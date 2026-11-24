import { randomBytes } from 'node:crypto';
import { closeSync, openSync, readSync, renameSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { BRANDING } from '@fireside/shared';
import BetterSqlite3 from 'better-sqlite3';
import { systemClock, type Clock } from '../auth/api-keys.js';
import type { RetentionConfig } from '../config.js';
import { createPrivateFile, ensurePrivateDir, makePrivateFile } from '../fs-modes.js';
import {
  backupFileName,
  fsyncPath,
  isBackupNameTaken,
  listBackups,
  markWrittenThisRun,
  TEMP_PREFIX,
  TEMP_SUFFIX,
} from './files.js';
import { gzipFile } from './gzip.js';
import { pruneBackups, type ClockAheadHandler } from './retention.js';

// Backups use `VACUUM INTO` on a separate read-only connection:
// - it runs as one read transaction, so with WAL the copy is an exact snapshot
//   of everything committed when it started (also what is still in `-wal`),
//   while the server keeps writing;
// - the online backup API copies page by page and starts over whenever another
//   connection writes, so under steady writes it may never finish;
// - the result is one compact file in rollback-journal mode, with no `-wal`
//   or `-shm` beside it, ready to copy or open.
// `VACUUM INTO` runs synchronously: the server waits while it runs (well under
// a second for typical sizes). The copy is then gzipped as a stream, which
// doesn't block the server. The duration is logged.
//
// Steps, all in BACKUP_DIR: `VACUUM INTO` a temp file (`….db.tmp`), integrity
// check, gzip it into a second temp file (`….gz.tmp`), rename that to the
// final name once the gzip stream has finished and is on disk, then remove the
// uncompressed temp. Both temp files exist for a moment, so a backup needs
// free space for the database plus its compressed copy. A backup interrupted
// at any point leaves only temp files, which never count as backups and which
// retention removes.

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
  /** Size of the compressed backup. */
  sizeBytes: number;
  /** Size of the database copy before compression. */
  uncompressedBytes: number;
  durationMs: number;
  /** Backups kept after retention (this one included). */
  count: number;
  totalSizeBytes: number;
  /** Backups deleted by retention. */
  deleted: string[];
}

/**
 * Takes a backup of `dbFile` into `dir`, safe while the server writes:
 * `VACUUM INTO` a temp file, integrity check, gzip into a second temp file,
 * rename that to the final name, then retention. On failure both temp files
 * are removed and nothing else changes.
 */
export async function createBackup({
  dbFile,
  dir,
  keep,
  timeZone,
  now = systemClock,
  onClockAhead,
}: BackupOptions): Promise<BackupResult> {
  const started = now();
  const startedMs = performance.now();
  ensurePrivateDir(dir);
  const tempBase = join(dir, `${TEMP_PREFIX}${randomBytes(6).toString('hex')}`);
  const plainTemp = `${tempBase}.db${TEMP_SUFFIX}`;
  const gzipTemp = `${tempBase}.gz${TEMP_SUFFIX}`;

  let final: string;
  let fileName: string;
  let uncompressedBytes: number;
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
      vacuumInto(source, plainTemp);
    } finally {
      source.close();
    }

    openCheckedDatabase(plainTemp).close();
    uncompressedBytes = statSync(plainTemp).size;

    await gzipFile(plainTemp, gzipTemp);

    // A second backup in the same second (e.g. manual right after scheduled)
    // gets a suffix. Chosen after the gzip, so a backup that ran meanwhile is seen.
    let copy = 1;
    while (isBackupNameTaken(dir, started.getTime(), copy)) copy++;
    fileName = backupFileName(started.getTime(), copy);
    final = join(dir, fileName);
    renameSync(gzipTemp, final);
    markWrittenThisRun(fileName);
    fsyncPath(dir);
  } catch (error) {
    rmSync(gzipTemp, { force: true });
    throw error;
  } finally {
    rmSync(plainTemp, { force: true });
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
    uncompressedBytes,
    durationMs: Math.round(performance.now() - startedMs),
    count: backups.length,
    totalSizeBytes: backups.reduce((sum, backup) => sum + backup.sizeBytes, 0),
    deleted,
  };
}
