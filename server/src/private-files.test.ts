import { spawn } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BRANDING } from '@fireside/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { keyFilePath } from './auth/secret-box.js';
import { createBackup } from './backup/backup.js';
import { parseBackupFolderName } from './backup/files.js';
import { lockPath } from './backup/lock.js';
import { backupBeforeMigrating } from './backup/pre-migrate.js';
import { restoreBackup } from './backup/restore.js';
import { migrationsWithExtra } from './backup/testing.js';
import { databasePath, openDatabase } from './db/index.js';

// Everything the server and the CLI write to DATA_DIR and BACKUP_DIR is for
// their user only: folders 700, files 600. First the functions that create
// files, then the real entry points in child processes started with the usual
// umask 022, as a shell or a container would.

const N = BRANDING.shortName;
const SERVER_DIR = join(import.meta.dirname, '..');
const KEEP = { daily: 7, weekly: 4, monthly: 6 };
const mode = (path: string) => (statSync(path).mode & 0o777).toString(8);

describe.skipIf(process.platform === 'win32')('private files', () => {
  let dir: string;
  let dataDir: string;
  let backupDir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), `${N}-private-`));
    dataDir = join(dir, 'data');
    backupDir = join(dataDir, 'backups');
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** A migrated database with the modes a default umask gives. */
  function looseDatabase(migrationsFolder?: string): string {
    const dbFile = databasePath(dataDir);
    openDatabase(dbFile, migrationsFolder === undefined ? {} : { migrationsFolder }).close();
    chmodSync(dataDir, 0o755);
    chmodSync(dbFile, 0o644);
    return dbFile;
  }
  const backupFiles = () =>
    readdirSync(backupDir).filter((name) => parseBackupFolderName(name) !== undefined);
  /** Modes of the folders and of every file in them, by name. */
  function modes(): Record<string, string> {
    const result: Record<string, string> = { DATA_DIR: mode(dataDir) };
    for (const name of readdirSync(dataDir)) {
      if (name !== 'backups') result[name] = mode(join(dataDir, name));
    }
    if (existsSync(backupDir)) {
      result.BACKUP_DIR = mode(backupDir);
      for (const name of readdirSync(backupDir))
        result[`backups/${name}`] = mode(join(backupDir, name));
    }
    return result;
  }
  const expectAllPrivate = () => {
    for (const [name, value] of Object.entries(modes())) {
      const expected = name === 'DATA_DIR' || name === 'BACKUP_DIR' ? '700' : '600';
      expect({ name, mode: value }).toEqual({ name, mode: expected });
    }
  };

  describe('the functions that create files', () => {
    it('a backup is 600 in a 700 folder, also from a loose database', () => {
      const dbFile = looseDatabase();
      const result = createBackup({ dbFile, dir: backupDir, keep: KEEP, timeZone: 'UTC' });
      expect(mode(result.path)).toBe('600');
      expect(mode(backupDir)).toBe('700');
    });

    it('the copy before a migration is 600 in a 700 folder', () => {
      const dbFile = looseDatabase();
      const copy = backupBeforeMigrating({
        dbFile,
        backupDir,
        migrationsFolder: migrationsWithExtra(dir),
      });
      expect(copy).toBeDefined();
      expect(mode(copy ?? '')).toBe('600');
      expect(mode(backupDir)).toBe('700');
    });

    it('a restored database and the copy of the one it replaced are 600', () => {
      const dbFile = looseDatabase();
      const backup = createBackup({ dbFile, dir: backupDir, keep: KEEP, timeZone: 'UTC' });
      // As a backup taken before this change, or copied in by hand.
      chmodSync(backup.path, 0o644);
      chmodSync(backupDir, 0o755);
      chmodSync(dbFile, 0o644);

      const result = restoreBackup({ file: backup.path, dataDir, backupDir });
      expect(mode(result.dbFile)).toBe('600');
      expect(result.previousSavedTo).not.toBeNull();
      expect(mode(result.previousSavedTo ?? '')).toBe('600');
      expect(mode(backupDir)).toBe('700');
      expect(mode(dataDir)).toBe('700');
    });

    it('a raw copy of a damaged database is 600 too', () => {
      const dbFile = looseDatabase();
      const backup = createBackup({ dbFile, dir: backupDir, keep: KEEP, timeZone: 'UTC' });
      // Not a database any more: `restore` keeps the raw file.
      // A file full of junk under the database's name, readable by all.
      writeJunk(dbFile, Buffer.alloc(8192, 0x5a));
      const result = restoreBackup({ file: backup.path, dataDir, backupDir });
      expect(result.previousRawCopy).toBe(true);
      expect(mode(result.previousSavedTo ?? '')).toBe('600');
      expect(mode(result.dbFile)).toBe('600');
    });
  });

  describe('the real entry points, started with umask 022', () => {
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

    /** Never the developer's own `.env`: every value that matters is set here. */
    const env = (extra: Record<string, string>) => ({
      ...process.env,
      DATA_DIR: dataDir,
      BACKUP_DIR: backupDir,
      HOST: '127.0.0.1',
      LOG_LEVEL: 'info',
      TZ: 'UTC',
      PUBLIC_URL: '',
      TRUSTED_PROXY: '',
      PRICES_ENABLED: 'false',
      RUNEPROFILE_ENABLED: 'false',
      USER_AGENT_CONTACT: '',
      ...extra,
    });
    /** `node <entry> <args>` under `umask 022`, whatever this process has. */
    const spawnEntry = (entry: string, args: string[], extra: Record<string, string>) =>
      spawn(
        'sh',
        [
          '-c',
          'umask 022 && exec "$0" "$@"',
          process.execPath,
          '--import',
          'tsx',
          '--conditions=@fireside/source',
          entry,
          ...args,
        ],
        { cwd: SERVER_DIR, env: env(extra), stdio: ['ignore', 'pipe', 'pipe'] },
      );

    /**
     * Starts the server, waits until it listens and has taken its startup
     * backup, reads the modes while it runs (so `-wal` and `-shm` exist),
     * then stops it. Returns the modes and the log.
     */
    async function runServer(): Promise<{
      running: Record<string, string>;
      log: string;
      cli: { list: string; restoreCode: number | null; restore: string };
    }> {
      const port = await freePort();
      const child = spawnEntry('src/index.ts', [], { PORT: String(port), BACKUP_ENABLED: 'true' });
      let log = '';
      let stderr = '';
      child.stdout.on('data', (chunk: Buffer) => {
        log += chunk.toString();
      });
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      const exited = new Promise<number | null>((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', resolve);
      });
      let running: Record<string, string> | undefined;
      let cli: { list: string; restoreCode: number | null; restore: string } | undefined;
      const ready = () =>
        log.includes('Server listening') && existsSync(backupDir) && backupFiles().length > 0;
      for (let i = 0; i < 400 && child.exitCode === null; i++) {
        if (ready()) {
          running = modes();
          // Making the files private must not cost the server its lock on
          // DATA_DIR: the CLI still sees it, and `restore` refuses.
          const list = await runCli(['keys', 'list']);
          const restore = await runCli(['restore', backupFiles()[0] ?? '']);
          cli = { list: list.output, restoreCode: restore.code, restore: restore.output };
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      // Only the process this test started.
      child.kill('SIGTERM');
      await exited;
      if (running === undefined || cli === undefined) {
        throw new Error(`The server did not start:\n${stderr}\n${log}`);
      }
      return { running, log, cli };
    }

    const logLine = (log: string, start: string) =>
      log
        .split('\n')
        .filter((line) => line.trim() !== '')
        .map((line) => JSON.parse(line) as { msg?: string; tightened?: number })
        .find((line) => line.msg?.startsWith(start));

    it(
      'the server makes a new DATA_DIR private: database, -wal, -shm, lock and the startup backup',
      { timeout: 60_000 },
      async () => {
        const { running, log, cli } = await runServer();
        expect(cli.list).toContain('(in use by a running server)');
        expect(cli.restoreCode, cli.restore).not.toBe(0);
        expect(cli.restore).toContain('already running');
        expect(running).toMatchObject({
          DATA_DIR: '700',
          BACKUP_DIR: '700',
          [`${N}.db`]: '600',
          [`${N}.db-wal`]: '600',
          [`${N}.db-shm`]: '600',
          [`${N}.lock`]: '600',
        });
        for (const [name, value] of Object.entries(running)) {
          const expected = name === 'DATA_DIR' || name === 'BACKUP_DIR' ? '700' : '600';
          expect({ name, mode: value }).toEqual({ name, mode: expected });
        }
        expect(Object.keys(running).some((name) => name.startsWith('backups/'))).toBe(true);
        // One line, with a count and no paths. Nothing was loose.
        const line = logLine(log, 'File permissions');
        expect(line).toMatchObject({ tightened: 0 });
        expect(JSON.stringify(line)).not.toContain(dir);
        // Never the folder above DATA_DIR.
        expect(mode(dir)).toBe(dirModeAtStart);
      },
    );

    it(
      'the server makes an existing loose install private at startup and says how many paths',
      { timeout: 60_000 },
      async () => {
        const dbFile = looseDatabase();
        const old = createBackup({ dbFile, dir: backupDir, keep: KEEP, timeZone: 'UTC' });
        // Old enough that the server takes its own startup backup.
        const aged = join(backupDir, `${N}-20260101-030000Z.db`);
        renameSync(old.path, aged);
        for (const path of [dbFile, aged]) chmodSync(path, 0o644);
        for (const path of [dataDir, backupDir]) chmodSync(path, 0o755);

        const { running, log, cli } = await runServer();
        expect(cli.list).toContain('(in use by a running server)');
        expect(cli.restoreCode, cli.restore).not.toBe(0);
        for (const [name, value] of Object.entries(running)) {
          const expected = name === 'DATA_DIR' || name === 'BACKUP_DIR' ? '700' : '600';
          expect({ name, mode: value }).toEqual({ name, mode: expected });
        }
        expect(running[`backups/${N}-20260101-030000Z.db`]).toBe('600');
        // The two folders, the database and the old backup.
        const line = logLine(log, 'File permissions');
        expect(line?.tightened).toBeGreaterThanOrEqual(4);
        expect(line?.msg).toContain('private');
        expect(JSON.stringify(line)).not.toContain(dir);
      },
    );

    /** Runs `pnpm cli <args>` to the end. */
    async function runCli(args: string[]): Promise<{ code: number | null; output: string }> {
      const child = spawnEntry('src/cli/index.ts', args, {});
      let output = '';
      child.stdout.on('data', (chunk: Buffer) => {
        output += chunk.toString();
      });
      child.stderr.on('data', (chunk: Buffer) => {
        output += chunk.toString();
      });
      const code = await new Promise<number | null>((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', resolve);
      });
      return { code, output };
    }

    it(
      'the CLI creates a private database, and its backup is private',
      { timeout: 60_000 },
      async () => {
        const created = await runCli(['keys', 'create', 'Gaming PC']);
        expect(created.code, created.output).toBe(0);
        expectAllPrivate();
        expect(mode(databasePath(dataDir))).toBe('600');
        expect(mode(lockPath(dataDir))).toBe('600');

        const backup = await runCli(['backup']);
        expect(backup.code, backup.output).toBe(0);
        expect(backupFiles()).toHaveLength(1);
        expectAllPrivate();
        // And it still reads what it wrote.
        const list = await runCli(['keys', 'list']);
        expect(list.code, list.output).toBe(0);
        expect(list.output).toContain('Gaming PC');
        expect(existsSync(keyFilePath(dataDir))).toBe(false);
      },
    );

    it('the CLI makes a loose install private and says so', { timeout: 60_000 }, async () => {
      looseDatabase();
      const list = await runCli(['keys', 'list']);
      expect(list.code, list.output).toBe(0);
      expect(list.output).toContain('File permissions: made');
      expectAllPrivate();
    });
  });

  let dirModeAtStart: string;
  beforeEach(() => {
    dirModeAtStart = mode(dir);
  });
});

function writeJunk(path: string, bytes: Buffer): void {
  rmSync(path, { force: true });
  writeFileSync(path, bytes, { mode: 0o644 });
  chmodSync(path, 0o644);
}
