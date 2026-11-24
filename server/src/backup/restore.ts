import { copyFileSync, existsSync, realpathSync, renameSync, rmSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import { systemClock, type Clock } from '../auth/api-keys.js';
import { countPendingMigrations, databasePath, MIGRATIONS_DIR, openDatabase } from '../db/index.js';
import { ensurePrivateDir, makePrivateFile } from '../fs-modes.js';
import { errorMessage, openCheckedDatabase, vacuumInto } from './backup.js';
import { fsyncPath, markWrittenThisRun, parseBackupFileName, preRestoreFileName } from './files.js';
import { gunzipFile, isGzipFile } from './gzip.js';
import { acquireInstanceLock } from './lock.js';
import { tightenDataDir } from '../tighten-data-dir.js';

// `pnpm cli restore <file>`. Only while no server uses DATA_DIR (see lock.ts).
//
// 1. Take the instance lock, so a server can't start halfway through.
// 2. A gzipped backup (by its first bytes, whatever its name) is decompressed
//    into a temp file in DATA_DIR. Never the OS temp folder: in Docker that is
//    a RAM-backed tmpfs. Backups from before compression are used as they are.
// 3. Check the backup (integrity, tables, schema not newer than this server).
//    The backup file is opened read-only and never changed.
// 4. Copy it next to the database with `VACUUM INTO`, delete the decompressed
//    temp right away (it is no longer needed, and the disk then never holds
//    more than three copies at once), and run any pending migrations on the
//    copy (a backup from an older version).
// 5. Keep the current database: `VACUUM INTO` a pre-restore copy in
//    BACKUP_DIR (includes what is still in its `-wal`).
// 6. Delete the current `-wal`/`-shm` (an old WAL applied to the new file
//    would corrupt it) and rename the copy into place.
// Until step 6 the current database is untouched.
//
// Disk use (DATA_DIR and BACKUP_DIR are usually on the same disk): besides
// the backup itself, at most three database-sized files at once. During
// step 4 the current database, the decompressed backup and the copy; during
// step 5 the current database, the copy and the pre-restore copy.

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

export async function restoreBackup({
  file,
  dataDir,
  backupDir,
  now = systemClock,
  migrationsFolder = MIGRATIONS_DIR,
}: RestoreOptions): Promise<RestoreResult> {
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
    // 2–4: decompress, check the backup and copy it into DATA_DIR.
    const temp = join(dataDir, `.${basename(dbFile)}.restore-tmp`);
    const unzipped = join(dataDir, `.${basename(dbFile)}.restore-gunzip-tmp`);
    removeWithSideFiles(temp);
    removeWithSideFiles(unzipped);
    let migrationsApplied: number;
    try {
      let source = file;
      if (isGzipFile(file)) {
        try {
          await gunzipFile(file, unzipped);
        } catch (error) {
          throw new Error(`Can't decompress ${file}: ${errorMessage(error)}`, { cause: error });
        }
        source = unzipped;
      }
      const backup = openCheckedDatabase(source);
      try {
        // Throws UnknownMigrationError for a backup from a newer version.
        migrationsApplied = countPendingMigrations(backup, migrationsFolder);
        vacuumInto(backup, temp);
      } finally {
        backup.close();
      }
      // Not needed any more: free its space before the pre-restore copy is written.
      removeWithSideFiles(unzipped);
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
      removeWithSideFiles(unzipped);
      // Name the backup, not the temp file it was decompressed into.
      const message = errorMessage(error).replaceAll(unzipped, `${file} (decompressed)`);
      throw new RestoreError(`Nothing was changed. ${message}`);
    }

    // 5: keep the current database.
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

    // 6: swap. The old -wal must go before the new file is in place.
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
