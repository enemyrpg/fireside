import { copyFileSync, existsSync, realpathSync, renameSync, rmSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import { systemClock, type Clock } from '../auth/api-keys.js';
import { countPendingMigrations, databasePath, MIGRATIONS_DIR, openDatabase } from '../db/index.js';
import { ensurePrivateDir, makePrivateFile } from '../fs-modes.js';
import { errorMessage, openCheckedDatabase, vacuumInto } from './backup.js';
import { fsyncPath, markWrittenThisRun, parseBackupFileName, preRestoreFileName } from './files.js';
import { acquireInstanceLock } from './lock.js';
import { tightenDataDir } from '../tighten-data-dir.js';

// `pnpm cli restore <file>`. Only while no server uses DATA_DIR (see lock.ts).
//
// 1. Take the instance lock, so a server can't start halfway through.
// 2. Check the backup (integrity, tables, schema not newer than this server).
//    The backup file is opened read-only and never changed.
// 3. Copy it next to the database with `VACUUM INTO` and run any pending
//    migrations on the copy (a backup from an older version).
// 4. Keep the current database: `VACUUM INTO` a pre-restore copy in
//    BACKUP_DIR (includes what is still in its `-wal`).
// 5. Delete the current `-wal`/`-shm` (an old WAL applied to the new file
//    would corrupt it) and rename the copy into place.
// Until step 5 the current database is untouched.

export interface RestoreOptions {
  /** The backup to restore (absolute path). */
  file: string;
  dataDir: string;
  /** Where the pre-restore copy of the current database goes. */
  backupDir: string;
  now?: Clock;
  /** Only tests change this. */
  migrationsFolder?: string;
}

export interface RestoreResult {
  /** When the backup was taken, if the file has a backup name. */
  backupCreatedAt: Date | null;
  /** Migrations applied to bring the backup up to this version. */
  migrationsApplied: number;
  /** The copy of the database that was replaced, or `null` if there was none. */
  previousSavedTo: string | null;
  /** True when the copy is the raw files, because the old database couldn't be read. */
  previousRawCopy: boolean;
  dbFile: string;
}

/** An expected failure (bad file, newer schema, …). Nothing was changed. */
export class RestoreError extends Error {
  override name = 'RestoreError';
}

const SIDE_FILES = ['-wal', '-shm', '-journal'] as const;

function removeWithSideFiles(path: string): void {
  for (const suffix of ['', ...SIDE_FILES]) rmSync(path + suffix, { force: true });
}

export function restoreBackup({
  file,
  dataDir,
  backupDir,
  now = systemClock,
  migrationsFolder = MIGRATIONS_DIR,
}: RestoreOptions): RestoreResult {
  const dbFile = databasePath(dataDir);
  if (!existsSync(file) || !statSync(file).isFile()) {
    throw new RestoreError(`No backup file at ${file}`);
  }
  if (existsSync(dbFile) && realpathSync(file) === realpathSync(dbFile)) {
    throw new RestoreError(`${file} is the current database, not a backup`);
  }

  const lock = acquireInstanceLock(dataDir);
  try {
    // With the lock, as the server does at startup: the folders and what is
    // already in them are for this user only. Best effort; the server reports
    // what it can't change when it starts.
    tightenDataDir({ dataDir, backupDir });
    // 2–3: check the backup and copy it into DATA_DIR.
    const temp = join(dataDir, `.${basename(dbFile)}.restore-tmp`);
    removeWithSideFiles(temp);
    let migrationsApplied: number;
    try {
      const backup = openCheckedDatabase(file);
      try {
        // Throws UnknownMigrationError for a backup from a newer version.
        migrationsApplied = countPendingMigrations(backup, migrationsFolder);
        vacuumInto(backup, temp);
      } finally {
        backup.close();
      }
      // Applies pending migrations, then closes cleanly (no -wal left).
      openDatabase(temp, { migrationsFolder }).close();
      for (const suffix of SIDE_FILES) {
        if (existsSync(temp + suffix)) {
          throw new Error(`${temp + suffix} was left after closing the restored copy`);
        }
      }
      fsyncPath(temp);
    } catch (error) {
      removeWithSideFiles(temp);
      throw new RestoreError(`Nothing was changed. ${errorMessage(error)}`);
    }

    // 4: keep the current database.
    let previousSavedTo: string | null = null;
    let previousRawCopy = false;
    if (existsSync(dbFile)) {
      try {
        ensurePrivateDir(backupDir);
        const savedName = preRestoreFileName(now().getTime());
        previousSavedTo = join(backupDir, savedName);
        markWrittenThisRun(savedName);
        markWrittenThisRun(`${savedName}-wal`);
        ({ raw: previousRawCopy } = keepCurrentDatabase(dbFile, previousSavedTo));
      } catch (error) {
        removeWithSideFiles(temp);
        throw new RestoreError(
          `Nothing was changed. Could not save a copy of the current database: ${errorMessage(error)}`,
        );
      }
    }

    // 5: swap. The old -wal must go before the new file is in place.
    for (const suffix of SIDE_FILES) rmSync(dbFile + suffix, { force: true });
    renameSync(temp, dbFile);
    fsyncPath(dirname(dbFile));

    const createdAtMs = parseBackupFileName(basename(file));
    return {
      backupCreatedAt: createdAtMs === undefined ? null : new Date(createdAtMs),
      migrationsApplied,
      previousSavedTo,
      previousRawCopy,
      dbFile,
    };
  } finally {
    lock.release();
  }
}

/**
 * Saves the current database to `target`. Normally with `VACUUM INTO`, which
 * includes what is still in its `-wal`. If the file is too damaged for that,
 * the raw files are copied as they are (`target`, `target-wal`).
 */
function keepCurrentDatabase(dbFile: string, target: string): { raw: boolean } {
  try {
    const current = new BetterSqlite3(dbFile, { fileMustExist: true, timeout: 0 });
    try {
      current.pragma('wal_checkpoint(TRUNCATE)');
      vacuumInto(current, target);
    } finally {
      current.close();
    }
    return { raw: false };
  } catch {
    rmSync(target, { force: true });
    // A raw copy takes the mode of the file it copies: make it private.
    copyFileSync(dbFile, target);
    makePrivateFile(target);
    fsyncPath(target);
    if (existsSync(`${dbFile}-wal`)) {
      copyFileSync(`${dbFile}-wal`, `${target}-wal`);
      makePrivateFile(`${target}-wal`);
      fsyncPath(`${target}-wal`);
    }
    return { raw: true };
  }
}
