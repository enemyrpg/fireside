import { randomBytes } from 'node:crypto';
import { closeSync, openSync, readdirSync, readSync, renameSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { BRANDING } from '@fireside/shared';
import BetterSqlite3 from 'better-sqlite3';
import { systemClock, type Clock } from '../auth/api-keys.js';
import type { RetentionConfig } from '../config.js';
import { createPrivateFile, ensurePrivateDir, makePrivateFile } from '../fs-modes.js';
import {
  backupFileName,
  fsyncPath,
  isNotFound,
  listBackups,
  markWrittenThisRun,
  TEMP_PREFIX,
  TEMP_SUFFIX,
} from './files.js';
import { pruneBackups, type ClockAheadHandler } from './retention.js';

// Backups use `VACUUM INTO` on a separate read-only connection:
// - it runs as one read transaction, so with WAL the copy is an exact snapshot
//   of everything committed when it started (also what is still in `-wal`),
//   while the server keeps writing;
// - the online backup API copies page by page and starts over whenever another
//   connection writes, so under steady writes it may never finish;
// - the result is one compact file in rollback-journal mode, with no `-wal`
//   or `-shm` beside it, ready to copy or open.
// It runs synchronously: the server waits while it runs (well under a second
// for typical sizes). The duration is logged.

/** Wait this long for a lock held by another process (same as the app). */
const BUSY_TIMEOUT_MS = 5000;

/** Thrown when a file is not a usable Fireside database. */
export class InvalidDatabaseFileError extends Error {
  override name = 'InvalidDatabaseFileError';
}

const SQLITE_HEADER = 'SQLite format 3\0';

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Whether the file starts with the SQLite header. */
function hasSqliteHeader(path: string): boolean {
  const buffer = Buffer.alloc(SQLITE_HEADER.length);
  const fd = openSync(path, 'r');
  try {
    const read = readSync(fd, buffer, 0, buffer.length, 0);
    return read === buffer.length && buffer.toString('latin1') === SQLITE_HEADER;
  } finally {
    closeSync(fd);
  }
}

/**
 * Opens a database file read-only and checks that it is a healthy Fireside
 * database: SQLite header, `PRAGMA integrity_check` and the tables every
 * version has. Returns the open connection; the caller closes it.
 */
export function openCheckedDatabase(path: string): BetterSqlite3.Database {
  try {
    if (!hasSqliteHeader(path)) {
      throw new InvalidDatabaseFileError(`${path} is not an SQLite database`);
    }
  } catch (error) {
    if (error instanceof InvalidDatabaseFileError) throw error;
    throw new InvalidDatabaseFileError(`Can't read ${path}: ${errorMessage(error)}`);
  }

  let sqlite: BetterSqlite3.Database;
  try {
    sqlite = new BetterSqlite3(path, {
      readonly: true,
      fileMustExist: true,
      timeout: BUSY_TIMEOUT_MS,
    });
  } catch (error) {
    throw new InvalidDatabaseFileError(`Can't open ${path}: ${errorMessage(error)}`);
  }
  try {
    const problems = (
      sqlite.pragma('integrity_check', { simple: false }) as Record<string, string>[]
    )
      .map((row) => Object.values(row)[0] ?? '')
      .filter((line) => line !== 'ok');
    if (problems.length > 0) {
      throw new InvalidDatabaseFileError(
        `${path} failed the integrity check: ${problems.slice(0, 3).join('; ')}`,
      );
    }
    const tables = new Set(
      sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").pluck().all(),
    );
    for (const table of ['__drizzle_migrations', 'events']) {
      if (!tables.has(table)) {
        throw new InvalidDatabaseFileError(
          `${path} is not a ${BRANDING.displayName} database (no ${table} table)`,
        );
      }
    }
    return sqlite;
  } catch (error) {
    sqlite.close();
    if (error instanceof InvalidDatabaseFileError) throw error;
    throw new InvalidDatabaseFileError(`${path} is not a valid database: ${errorMessage(error)}`);
  }
}

/**
 * Copies an open database to `target` (a new file) with `VACUUM INTO`, and
 * flushes it to disk. The copy is `0600` from the start: it holds everything
 * the database does.
 */
export function vacuumInto(sqlite: BetterSqlite3.Database, target: string): void {
  // `VACUUM INTO` fills an empty file, so the file is never created with the
  // umask's mode, also when nothing set a private umask (tests, other tools).
  createPrivateFile(target);
  sqlite.prepare('VACUUM INTO ?').run(target);
  makePrivateFile(target);
  fsyncPath(target);
}

export interface BackupOptions {
  /** The live database file. */
  dbFile: string;
  /** `BACKUP_DIR`. Created if missing. */
  dir: string;
  keep: RetentionConfig;
  /** IANA time zone for retention (days, weeks, months). */
  timeZone: string;
  now?: Clock;
  /** Called once per process when the clock is more than a day ahead of the backups. */
  onClockAhead?: ClockAheadHandler;
}

export interface BackupResult {
  fileName: string;
  path: string;
  createdAt: Date;
  sizeBytes: number;
  durationMs: number;
  /** Backups kept after retention (this one included). */
  count: number;
  totalSizeBytes: number;
  /** Backups deleted by retention. */
  deleted: string[];
}

/**
 * Takes a backup of `dbFile` into `dir`, safe while the server writes:
 * `VACUUM INTO` a temp file, integrity check, rename to the final name, then
 * retention. On failure the temp file is removed and nothing else changes.
 */
export function createBackup({
  dbFile,
  dir,
  keep,
  timeZone,
  now = systemClock,
  onClockAhead,
}: BackupOptions): BackupResult {
  const started = now();
  const startedMs = performance.now();
  ensurePrivateDir(dir);
  const temp = join(dir, `${TEMP_PREFIX}${randomBytes(6).toString('hex')}${TEMP_SUFFIX}`);

  let final: string;
  let fileName: string;
  try {
    let source: BetterSqlite3.Database;
    try {
      source = new BetterSqlite3(dbFile, {
        readonly: true,
        fileMustExist: true,
        timeout: BUSY_TIMEOUT_MS,
      });
    } catch (error) {
      throw new Error(`Can't open the database at ${dbFile}: ${errorMessage(error)}`, {
        cause: error,
      });
    }
    try {
      vacuumInto(source, temp);
    } finally {
      source.close();
    }

    openCheckedDatabase(temp).close();

    // A second backup in the same second (e.g. manual right after scheduled) gets a suffix.
    let copy = 1;
    do {
      fileName = backupFileName(started.getTime(), copy++);
      final = join(dir, fileName);
    } while (listBackups(dir).some((backup) => backup.fileName === fileName));
    renameSync(temp, final);
    markWrittenThisRun(fileName);
    fsyncPath(dir);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }

  const deleted = pruneBackups(dir, keep, timeZone, {
    nowMs: started.getTime(),
    ...(onClockAhead ? { onClockAhead } : {}),
  });
  const backups = listBackups(dir);
  const sizeBytes = backups.find((backup) => backup.fileName === fileName)?.sizeBytes ?? 0;
  return {
    fileName,
    path: final,
    createdAt: started,
    sizeBytes,
    durationMs: Math.round(performance.now() - startedMs),
    count: backups.length,
    totalSizeBytes: backups.reduce((sum, backup) => sum + backup.sizeBytes, 0),
    deleted,
  };
}

/** A temp file older than this is left over from an interrupted backup. */
const STALE_TEMP_MS = 60 * 60_000;

/**
 * Removes temp files left by a backup that was interrupted (crash, power
 * loss). Files younger than an hour are left alone: a `pnpm cli backup` may
 * be writing one right now. Returns the removed names.
 */
export function removeLeftoverTempFiles(dir: string, now: Clock = systemClock): string[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch (error) {
    if (isNotFound(error)) return [];
    throw error;
  }
  const removed: string[] = [];
  for (const name of names) {
    if (!name.startsWith(TEMP_PREFIX) || !name.endsWith(TEMP_SUFFIX)) continue;
    const path = join(dir, name);
    try {
      if (now().getTime() - statSync(path).mtimeMs < STALE_TEMP_MS) continue;
    } catch (error) {
      if (isNotFound(error)) continue;
      throw error;
    }
    rmSync(path, { force: true });
    removed.push(name);
  }
  return removed;
}
