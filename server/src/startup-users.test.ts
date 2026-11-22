import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BRANDING } from '@fireside/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EXIT_CONFIG } from './backup/lock.js';
import { databasePath, openDatabase } from './db/index.js';
import { hashPassword } from './users/password.js';
import { createUser, FIRST_USER_ID, setPasswordHash } from './users/users.js';

// The real server entry point (src/index.ts) in a child process, so the
// fail-closed check is tested where it runs: at startup, before listening.

const SERVER_DIR = join(import.meta.dirname, '..');
const CHEAP = { memory: 64, passes: 1, parallelism: 1 };

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => {
        resolve(port);
      });
    });
  });
}

interface StartResult {
  /** Exit code, or `null` if the server was still running (it listened). */
  code: number | null;
  stderr: string;
  /** The log (JSON lines) up to and including the line that says it listens. */
  stdout: string;
  listened: boolean;
}

/** Starts the server on `dataDir`. Stops it once it listens; waits for it to exit otherwise. */
async function startServer(
  dataDir: string,
  env: Record<string, string> = {},
): Promise<StartResult> {
  const port = await freePort();
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', '--conditions=@fireside/source', 'src/index.ts'],
    {
      cwd: SERVER_DIR,
      env: {
        ...process.env,
        DATA_DIR: dataDir,
        HOST: '127.0.0.1',
        PORT: String(port),
        BACKUP_ENABLED: 'false',
        LOG_LEVEL: 'info',
        TZ: 'UTC',
        PUBLIC_URL: '',
        TRUSTED_PROXY: '',
        ...env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let stderr = '';
  // An object, so the change made in the callback is seen below.
  const state = { listened: false, stdout: '' };
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  child.stdout.on('data', (chunk: Buffer) => {
    if (!state.listened) state.stdout += chunk.toString();
    if (!state.listened && chunk.toString().includes('Server listening')) {
      state.listened = true;
      child.kill('SIGTERM');
    }
  });
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (exitCode) => {
      resolve(exitCode);
    });
  });
  return {
    code: state.listened ? null : code,
    stderr,
    stdout: state.stdout,
    listened: state.listened,
  };
}

describe('server startup with users', () => {
  let dir: string;
  let dataDir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), `${BRANDING.shortName}-startup-`));
    dataDir = join(dir, 'data');
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** A migrated database in `dataDir` with `users` extra users and optional admin password. */
  async function prepare({
    extraUsers,
    adminPassword,
  }: {
    extraUsers: number;
    adminPassword: boolean;
  }) {
    const database = openDatabase(databasePath(dataDir));
    try {
      for (let i = 0; i < extraUsers; i++) createUser(database.db, `user${String(i + 2)}`);
      if (adminPassword) {
        setPasswordHash(database.db, FIRST_USER_ID, await hashPassword('a long passphrase', CHEAP));
      }
    } finally {
      database.close();
    }
  }

  it(
    'refuses to start (exit 78) when several users exist and none has a password',
    { timeout: 30_000 },
    async () => {
      await prepare({ extraUsers: 1, adminPassword: false });
      const result = await startServer(dataDir);
      expect(result.listened).toBe(false);
      expect(result.code).toBe(EXIT_CONFIG);
      expect(EXIT_CONFIG).toBe(78);
      expect(result.stderr).toContain(
        "There are 2 users but none has a password, so login can't be required. Refusing to start.",
      );
      expect(result.stderr).toContain('pnpm cli users set-password admin');
    },
  );

  it('starts in local mode with one user and no password', { timeout: 30_000 }, async () => {
    await prepare({ extraUsers: 0, adminPassword: false });
    expect((await startServer(dataDir)).listened).toBe(true);
  });

  it('starts with several users once one has a password', { timeout: 30_000 }, async () => {
    await prepare({ extraUsers: 2, adminPassword: true });
    expect((await startServer(dataDir)).listened).toBe(true);
  });

  it(
    'refuses to start (exit 78) with a PUBLIC_URL that is not https',
    { timeout: 30_000 },
    async () => {
      await prepare({ extraUsers: 1, adminPassword: true });
      const result = await startServer(dataDir, { PUBLIC_URL: 'http://app.example.com' });
      expect(result.listened).toBe(false);
      expect(result.code).toBe(EXIT_CONFIG);
      expect(result.stderr).toContain('PUBLIC_URL: Must use https://');
      expect(result.stderr).toContain('Secure');
    },
  );

  it('starts with an https PUBLIC_URL', { timeout: 30_000 }, async () => {
    await prepare({ extraUsers: 1, adminPassword: true });
    const result = await startServer(dataDir, { PUBLIC_URL: 'https://app.example.com' });
    expect(result.listened).toBe(true);
  });

  describe('with TRUSTED_PROXY', () => {
    const TUNNEL = { PUBLIC_URL: 'https://app.example.com', TRUSTED_PROXY: 'cloudflare' };
    const WARNING = 'TRUSTED_PROXY is set, but no user has a password';

    it('warns in local mode, and still starts', { timeout: 30_000 }, async () => {
      await prepare({ extraUsers: 0, adminPassword: false });
      const result = await startServer(dataDir, TUNNEL);
      expect(result.listened).toBe(true);
      const line = result.stdout.split('\n').find((entry) => entry.includes(WARNING));
      expect(line).toBeDefined();
      expect((JSON.parse(line ?? '{}') as { level?: number }).level).toBe(40); // warn
    });

    it('does not warn in login mode', { timeout: 30_000 }, async () => {
      await prepare({ extraUsers: 0, adminPassword: true });
      const result = await startServer(dataDir, TUNNEL);
      expect(result.listened).toBe(true);
      expect(result.stdout).not.toContain(WARNING);
    });
  });
});
