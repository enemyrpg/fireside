import { randomBytes } from 'node:crypto';
import { existsSync, renameSync, rmSync } from 'node:fs';
import { basename, join } from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import { systemClock, type Clock } from '../auth/api-keys.js';
import { countPendingMigrations, MIGRATIONS_DIR, MIGRATIONS_TABLE } from '../db/index.js';
import { ensurePrivateDir } from '../fs-modes.js';
import { errorMessage, openCheckedDatabase, vacuumInto } from './backup.js';
import {
  fsyncPath,
  markWrittenThisRun,
  preMigrateFileName,
  TEMP_PREFIX,
  TEMP_SUFFIX,
} from './files.js';

// A copy of the database before migrations change it. Taken by the server and
// the CLI whenever an existing database has pending migrations, before anything
// is migrated. Named like the pre-restore copies
// (`fireside-pre-migrate-<time>.db`), not like a backup, so the daily, weekly
// and monthly levels never count it: it is the way back if a migration goes
// wrong. Like every backup it is deleted after the max age (retention.ts).

/** Wait this long for a lock held by another process (same as the app). */
const BUSY_TIMEOUT_MS = 5000;

/** Thrown when the copy fails. Nothing has been migrated. */
export class PreMigrateBackupError extends Error {
  override name = 'PreMigrateBackupError';
}

export interface PreMigrateOptions {
  dbFile: string;
  /** `BACKUP_DIR`. */
  backupDir: string;
  /** Only tests change this. */
  migrationsFolder?: string;
  /**
   * Whether projections must be recomputed (`DatabaseUpgrade.pending`): that
   * changes the database too, so it also gets a copy first.
   */
  upgradePending?: (sqlite: BetterSqlite3.Database) => boolean;
  now?: Clock;
}

/** Applied migrations in the file, or 0 for a file without the migrations table. */
function appliedMigrations(sqlite: BetterSqlite3.Database): number {
  const hasTable =
    sqlite
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(MIGRATIONS_TABLE) !== undefined;
  if (!hasTable) return 0;
  const row = sqlite.prepare(`SELECT count(*) AS n FROM "${MIGRATIONS_TABLE}"`).get() as {
    n: number;
  };
  return row.n;
}

/**
 * Copies `dbFile` into `backupDir` if it is an existing database with pending
 * migrations or a pending upgrade. Returns the copy's path, or `undefined` when no copy is needed
 * (no file, a new database, or nothing pending). Only reads `dbFile`. Throws
 * `PreMigrateBackupError` if the copy fails: the caller must then not migrate.
 * A database from a newer version throws the same error `openDatabase` would.
 */
export function backupBeforeMigrating({
  dbFile,
  backupDir,
  migrationsFolder = MIGRATIONS_DIR,
  upgradePending,
  now = systemClock,
}: PreMigrateOptions): string | undefined {
  if (!existsSync(dbFile)) return undefined;

  const source = new BetterSqlite3(dbFile, {
    readonly: true,
    fileMustExist: true,
    timeout: BUSY_TIMEOUT_MS,
  });
  let temp: string | undefined;
  try {
    if (appliedMigrations(source) === 0) return undefined;
    if (countPendingMigrations(source, migrationsFolder) === 0 && !upgradePending?.(source)) {
      return undefined;
    }

    try {
      ensurePrivateDir(backupDir);
      temp = join(backupDir, `${TEMP_PREFIX}${randomBytes(6).toString('hex')}${TEMP_SUFFIX}`);
      vacuumInto(source, temp);
    } catch (error) {
      if (temp !== undefined) rmSync(temp, { force: true });
      throw new PreMigrateBackupError(
        `Could not back up the database before migrating it: ${errorMessage(error)}`,
        { cause: error },
      );
    }
  } finally {
    source.close();
  }

  try {
    openCheckedDatabase(temp).close();
    const ms = now().getTime();
    let copy = 1;
    let target: string;
    do target = join(backupDir, preMigrateFileName(ms, copy++));
    while (existsSync(target));
    renameSync(temp, target);
    markWrittenThisRun(basename(target));
    fsyncPath(backupDir);
    return target;
  } catch (error) {
    rmSync(temp, { force: true });
    throw new PreMigrateBackupError(
      `Could not back up the database before migrating it: ${errorMessage(error)}`,
      { cause: error },
    );
  }
}
