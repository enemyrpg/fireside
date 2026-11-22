// Scratch servers for the scripts (UI snapshots, the CSP check, ad hoc checks).
//
// A scratch server must never make an external call and never touch real
// data. Three things make sure of it:
//
//   1. `scratchEnv` builds the environment from nothing: it does not copy
//      `process.env`, and it sets every external source off with no contact.
//   2. The server (and the seed) run with `no-env-file.ts` preloaded, so the
//      repo's `.env` is never read.
//   3. Guards: `assertScratchEnv` refuses an environment that could turn a
//      source on or point at real data before anything starts, and
//      `assertNoActiveSources` asks the running server and stops it if any
//      source is enabled or a contact is set.

import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const REPO_ROOT = resolve(import.meta.dirname, '../..');
const NO_ENV_FILE = join(import.meta.dirname, 'no-env-file.ts');

/** Data folders that hold real or shared data, relative to the repo root. */
const REAL_DATA_DIRS = ['data', 'data-dev', 'data-seed'];
/** The Docker instance's port. */
const RESERVED_PORT = 3100;

/** Variables a process needs to run at all. Nothing of the server's own configuration. */
const PASSED_ON = ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TMPDIR', 'CI'];

export interface ScratchOptions {
  /** Time zone of the server (default `Europe/Oslo`). */
  timeZone?: string;
  logLevel?: string;
}

/**
 * The whole environment of a scratch server on `dir` and `port`. Built from
 * nothing: only `PASSED_ON` comes from the caller's environment.
 */
export function scratchEnv(
  dir: string,
  port: number,
  options: ScratchOptions = {},
  from: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of PASSED_ON) {
    const value = from[name];
    if (value !== undefined) env[name] = value;
  }
  return {
    ...env,
    NODE_OPTIONS: `--import ${pathToFileURL(NO_ENV_FILE).href}`,
    DATA_DIR: dir,
    BACKUP_DIR: join(dir, 'backups'),
    HOST: '127.0.0.1',
    PORT: String(port),
    TZ: options.timeZone ?? 'Europe/Oslo',
    LOG_LEVEL: options.logLevel ?? 'warn',
    BACKUP_ENABLED: 'false',
    PRICES_ENABLED: 'false',
    RUNEPROFILE_ENABLED: 'false',
    RUNEPROFILE_API_KEY: '',
    USER_AGENT_CONTACT: '',
    PUBLIC_URL: '',
    TRUSTED_PROXY: '',
    MAX_USERS: '',
  };
}

/**
 * Refuses an environment that could make an external call or touch real data.
 * Called before every scratch server and seed run.
 */
export function assertScratchEnv(env: NodeJS.ProcessEnv, root: string = REPO_ROOT): void {
  const problems: string[] = [];
  for (const name of ['PRICES_ENABLED', 'RUNEPROFILE_ENABLED']) {
    if (env[name] !== 'false') problems.push(`${name} must be "false" (is ${String(env[name])})`);
  }
  for (const name of ['USER_AGENT_CONTACT', 'RUNEPROFILE_API_KEY', 'PUBLIC_URL']) {
    if (env[name] !== '') problems.push(`${name} must be empty`);
  }
  if (!(env.NODE_OPTIONS ?? '').includes('no-env-file.ts')) {
    problems.push('NODE_OPTIONS must preload no-env-file.ts, so .env is never read');
  }
  if (env.HOST !== '127.0.0.1') problems.push('HOST must be 127.0.0.1');
  const port = Number(env.PORT);
  if (!Number.isInteger(port) || port <= 0) problems.push('PORT must be set');
  if (port === RESERVED_PORT)
    problems.push(`PORT ${String(RESERVED_PORT)} belongs to the Docker instance`);
  const dir = env.DATA_DIR;
  if (dir === undefined || dir === '') {
    problems.push('DATA_DIR must be set');
  } else {
    const absolute = resolve(root, dir);
    for (const real of REAL_DATA_DIRS) {
      const realDir = join(root, real);
      if (absolute === realDir || absolute.startsWith(`${realDir}/`)) {
        problems.push(`DATA_DIR must not be ${real}/`);
      }
    }
  }
  if (problems.length > 0) {
    throw new Error(`Not a scratch environment, nothing was started:\n  ${problems.join('\n  ')}`);
  }
}

export async function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => {
        if (address === null || typeof address === 'string') reject(new Error('No port'));
        else resolvePort(address.port);
      });
    });
  });
}

export async function waitForHealth(base: string, server: ChildProcess): Promise<void> {
  for (let i = 0; i < 150; i += 1) {
    if (server.exitCode !== null) throw new Error(`Server exited with ${String(server.exitCode)}`);
    try {
      const response = await fetch(`${base}/api/v1/health`);
      if (response.ok) return;
    } catch {
      // Not listening yet.
    }
    await new Promise((done) => setTimeout(done, 200));
  }
  throw new Error('Server did not become healthy');
}

export async function stopServer(server: ChildProcess | undefined): Promise<void> {
  if (server?.exitCode !== null) return;
  const exited = new Promise((done) => server.once('exit', done));
  server.kill('SIGTERM');
  await Promise.race([exited, new Promise((done) => setTimeout(done, 10_000))]);
}

interface SourcesAnswer {
  contactSet: boolean;
  sources: { id: string; enabled: boolean; active: boolean }[];
}

/** What is wrong with the server's own answer about its external sources. Empty: all off. */
export function activeSourceProblems(answer: SourcesAnswer): string[] {
  const problems: string[] = [];
  if (answer.contactSet) problems.push('USER_AGENT_CONTACT is set');
  for (const source of answer.sources) {
    if (source.enabled || source.active) problems.push(`${source.id} is on`);
  }
  return problems;
}

/**
 * Asks the running server (`GET /admin/external-sources`, open on localhost
 * before a password is set) and throws if any source is on or a contact is
 * set. The caller stops the server.
 */
export async function assertNoActiveSources(base: string): Promise<void> {
  const response = await fetch(`${base}/api/v1/admin/external-sources`);
  if (!response.ok) {
    throw new Error(`Could not check the external sources: ${String(response.status)}`);
  }
  const problems = activeSourceProblems((await response.json()) as SourcesAnswer);
  if (problems.length > 0) {
    throw new Error(`The scratch server could make external calls: ${problems.join(', ')}`);
  }
}

export interface ScratchServer {
  base: string;
  port: number;
  server: ChildProcess;
}

/**
 * Starts the built server on `dir` on a free port, and stops it again at once
 * if it could make an external call. Needs `pnpm build`.
 */
export async function startScratchServer(
  dir: string,
  options: ScratchOptions = {},
): Promise<ScratchServer> {
  const port = await freePort();
  const env = scratchEnv(dir, port, options);
  assertScratchEnv(env);
  const base = `http://localhost:${String(port)}`;
  const server = spawn(process.execPath, ['server/dist/index.js'], {
    cwd: REPO_ROOT,
    env,
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  try {
    await waitForHealth(base, server);
    await assertNoActiveSources(base);
  } catch (error) {
    await stopServer(server);
    throw error;
  }
  return { base, port, server };
}

/** Fills `dir` with seed data (the generator behind `pnpm seed`), with the same guards. */
export function seedScratch(dir: string, args: string[] = [], options: ScratchOptions = {}): void {
  // Seeding refuses DATA_DIR itself, so the environment gets another (unused) one.
  const env = scratchEnv(join(dir, '..', 'unused'), 3999, options);
  assertScratchEnv(env);
  execFileSync(process.execPath, ['server/bin/seed.js', '--data-dir', dir, ...args], {
    cwd: REPO_ROOT,
    env,
    stdio: ['ignore', 'ignore', 'inherit'],
  });
}
