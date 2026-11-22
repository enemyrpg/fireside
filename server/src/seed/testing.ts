import { createHash } from 'node:crypto';
import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { join, relative } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import BetterSqlite3 from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { expect, inject } from 'vitest';
import type { Config } from '../config.js';
import type { Database } from '../db/index.js';
import * as schema from '../db/schema.js';
import { testConfig, testDatabase } from '../test-utils.js';
import { generateSeed, type SeedData, type SeedOptions } from './generator/generate.js';
import { seedInProcess, type InProcessResult } from './in-process.js';

// Seed databases shared by the `*-seed.test.ts` files. Sending a seed
// through ingest takes most of those files' time, and several files use the
// same options, so each dataset is built once per test run:
//
// - The first file that needs a dataset takes its lock and builds it with
//   `seedInProcess`, exactly as the files did on their own before, then
//   saves the database and the seed result in the run's folder
//   (vitest.global-setup.ts).
// - Other files wait for it and get their own in-memory copy, so a file can
//   write to its database (a rebuild, stored weeks) without affecting others.
// - Waiting is bounded. If the building file fails, or its worker exits, or
//   the lock is held too long, waiting files fail at once with an error that
//   names the building file instead of hanging until the hook times out.
//
// A dataset is identified by the seed options and the env for `testConfig`,
// so a file with other options or another config gets its own dataset.

declare module 'vitest' {
  export interface ProvidedContext {
    /** Folder for this run's shared seed datasets (vitest.global-setup.ts). */
    seedFixtureDir: string;
  }
}

// The timeouts are generous on purpose. They only matter when something hangs,
// and CI is far slower than a development machine: the runner has two slow
// cores and runs two test files at a time on them. Rebuilds of a
// seed database that take 5 s locally took over 60 s there, so the tests that
// rebuild or walk a whole seed database have 240 s (a plain number in each
// file: Prettier keeps a test on one line only with a literal).

/** How long a file waits for another file to build a dataset. */
export const SEED_FIXTURE_WAIT_MS = 240_000;

/** Timeout for a `beforeAll` that loads a dataset: building plus waiting. */
export const SEED_FIXTURE_HOOK_TIMEOUT_MS = 300_000;

const POLL_MS = 50;

export interface SeedFixture {
  /** The generated seed (deterministic, so generated again in each file). */
  data: SeedData;
  /** This file's own in-memory copy of the seeded database. */
  database: Database;
  /** `testConfig(env)`, the config the dataset was seeded with. */
  config: Config;
  /** What `seedInProcess` returned when the dataset was built. */
  result: InProcessResult;
}

interface LockHolder {
  pid: number;
  file: string;
}

interface BuildError {
  file: string;
  error: string;
}

/**
 * The seeded database for `options` and `env`, built by the first file that
 * asks for it in this test run. Throws if the dataset can't be had within
 * `waitMs`, or if building it failed in another file.
 */
export async function loadSeedFixture(
  options: SeedOptions,
  env: Record<string, string>,
  { waitMs = SEED_FIXTURE_WAIT_MS }: { waitMs?: number } = {},
): Promise<SeedFixture> {
  const data = generateSeed(options);
  const config = testConfig(env);
  const label = describeDataset(options, env);
  const base = join(inject('seedFixtureDir'), datasetKey(options, env));
  const paths = {
    lock: `${base}.lock`,
    db: `${base}.db`,
    // Written last: the dataset is ready once this file exists.
    result: `${base}.json`,
    error: `${base}.error.json`,
  };
  const file = currentTestFile();

  if (tryLock(paths.lock, file)) {
    try {
      await build(paths, data, config);
    } catch (error) {
      const failure: BuildError = {
        file,
        error: error instanceof Error ? (error.stack ?? error.message) : String(error),
      };
      writeAtomic(paths.error, JSON.stringify(failure));
      throw error;
    }
  }

  const deadline = Date.now() + waitMs;
  for (;;) {
    if (existsSync(paths.result)) return { data, config, ...open(paths) };

    if (existsSync(paths.error)) {
      const failure = JSON.parse(readFileSync(paths.error, 'utf8')) as BuildError;
      throw new Error(
        `Seed dataset (${label}) failed to build in ${failure.file}, so this file can't ` +
          `use it. Fix that file's error first:\n${failure.error}`,
      );
    }

    const holder = readLock(paths.lock);
    if (holder && holder.pid !== process.pid && !isRunning(holder.pid)) {
      throw new Error(
        `Seed dataset (${label}): the test worker building it for ${holder.file} ` +
          `(pid ${String(holder.pid)}) exited without finishing.`,
      );
    }

    if (Date.now() >= deadline) {
      throw new Error(
        `Timed out after ${String(waitMs / 1000)} s waiting for ` +
          `${holder?.file ?? 'another test file'} to build seed dataset (${label}).`,
      );
    }
    await sleep(POLL_MS);
  }
}

async function build(
  paths: { db: string; result: string },
  data: SeedData,
  config: Config,
): Promise<void> {
  const database = testDatabase();
  try {
    const result = await seedInProcess(database, config, data);
    writeAtomic(paths.db, database.sqlite.serialize());
    writeAtomic(paths.result, JSON.stringify(result));
  } finally {
    database.close();
  }
}

/** A writable in-memory copy of the saved dataset, set up like `openDatabase`. */
function open(paths: { db: string; result: string }): Pick<SeedFixture, 'database' | 'result'> {
  const sqlite = new BetterSqlite3(readFileSync(paths.db));
  sqlite.pragma('foreign_keys = ON');
  const database: Database = {
    db: drizzle(sqlite, { schema }),
    sqlite,
    close: () => {
      if (sqlite.open) sqlite.close();
    },
  };
  const result = JSON.parse(readFileSync(paths.result, 'utf8')) as InProcessResult;
  return { database, result };
}

/** Takes the lock if nobody has it. The lock is never released: the result or error file ends it. */
function tryLock(path: string, file: string): boolean {
  let fd: number;
  try {
    fd = openSync(path, 'wx');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw error;
  }
  try {
    const holder: LockHolder = { pid: process.pid, file };
    writeSync(fd, JSON.stringify(holder));
  } finally {
    closeSync(fd);
  }
  return true;
}

function readLock(path: string): LockHolder | undefined {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as LockHolder;
  } catch {
    // Not there, or the holder hasn't written it yet.
    return undefined;
  }
}

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: it runs, as another user.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Readers never see a half-written file. */
function writeAtomic(path: string, content: string | Uint8Array): void {
  const tmp = `${path}.${String(process.pid)}.tmp`;
  writeFileSync(tmp, content);
  renameSync(tmp, path);
}

function datasetKey(options: SeedOptions, env: Record<string, string>): string {
  const canonical = JSON.stringify([
    options.seed,
    options.accounts,
    options.months,
    options.until.toISOString(),
    options.timeZone,
    Object.entries(env).sort(([a], [b]) => a.localeCompare(b)),
  ]);
  return createHash('sha256').update(canonical).digest('hex').slice(0, 16);
}

function describeDataset(options: SeedOptions, env: Record<string, string>): string {
  const keys = Object.keys(env).sort().join(', ');
  return (
    `seed ${String(options.seed)}, ${String(options.accounts)} accounts, ` +
    `${String(options.months)} months until ${options.until.toISOString()}, env ${keys}`
  );
}

function currentTestFile(): string {
  const path = expect.getState().testPath;
  return path ? relative(process.cwd(), path) : 'an unknown test file';
}
