import { acquireInstanceLock, type InstanceLock } from './backup/lock.js';
import { backupBeforeMigrating, type PreMigrateOptions } from './backup/pre-migrate.js';
import {
  databasePath,
  openDatabase,
  type Database,
  type DatabaseUpgrade,
  type OpenDatabaseOptions,
} from './db/index.js';
import { projectionUpgrade } from './projections/versions.js';
import {
  mergeTightenResults,
  tightenDataDir,
  type TightenOptions,
  type TightenResult,
} from './tighten-data-dir.js';

// How the server opens DATA_DIR at startup. The order matters and is tested:
// 1. instance lock: one server per DATA_DIR, so nothing below runs while
//    another server (perhaps from another branch) owns the database;
// 2. private: the folders `0700` and our files in
//    them `0600`, also the ones from before this existed, before anything
//    is copied;
// 3. backup before migrating, of the file exactly as the previous version
//    left it;
// 4. migrate (and open), then recompute projections whose rules changed, in
//    the same transaction (projections/versions.ts);
// 5. private once more, for a database (and its `-wal`) that was just made.
// If a step fails, the later ones don't run and the lock is released. Step 2
// and 5 never fail: what they can't change is returned for the log.

/** The steps, replaceable in tests to check the order. */
export interface DataDirSteps {
  lock: (dataDir: string) => InstanceLock;
  /** Runs twice: before the backup and after migrating. */
  makePrivate: (options: TightenOptions) => TightenResult;
  backupBeforeMigrating: (options: PreMigrateOptions) => string | undefined;
  migrate: (dbFile: string, options: OpenDatabaseOptions) => Database;
}

export const DATA_DIR_STEPS: DataDirSteps = {
  lock: acquireInstanceLock,
  makePrivate: tightenDataDir,
  backupBeforeMigrating,
  migrate: openDatabase,
};

export interface OpenDataDirOptions {
  dataDir: string;
  /** `BACKUP_DIR`, for the copy taken before migrating. */
  backupDir: string;
  /** Only tests change this. */
  migrationsFolder?: string;
  /** Default: recompute outdated projections (`projectionUpgrade`). Only tests change this. */
  upgrade?: DatabaseUpgrade;
}

export interface OpenedDataDir {
  /** Held until the process exits; release it after closing the database. */
  lock: InstanceLock;
  database: Database;
  dbFile: string;
  /** The copy taken before migrating, if migrations were pending. */
  preMigrateBackup: string | undefined;
  /** How many paths were made private, and which could not be (for the log). */
  permissions: TightenResult;
}

/**
 * Takes the instance lock, makes the folders and files private, backs up before migrating, opens (migrates) the database
 * and makes what that created private, in that order. Throws the first step's
 * error; `InstanceLockedError` means another process holds DATA_DIR.
 */
export function openDataDir(
  { dataDir, backupDir, migrationsFolder, upgrade = projectionUpgrade() }: OpenDataDirOptions,
  steps: DataDirSteps = DATA_DIR_STEPS,
): OpenedDataDir {
  const lock = steps.lock(dataDir);
  try {
    const dbFile = databasePath(dataDir);
    const before = steps.makePrivate({ dataDir, backupDir });
    const preMigrateBackup = steps.backupBeforeMigrating({
      dbFile,
      backupDir,
      ...(migrationsFolder === undefined ? {} : { migrationsFolder }),
      upgradePending: upgrade.pending,
    });
    const database = steps.migrate(dbFile, {
      ...(migrationsFolder === undefined ? {} : { migrationsFolder }),
      upgrade,
    });
    const permissions = mergeTightenResults(before, steps.makePrivate({ dataDir, backupDir }));
    return { lock, database, dbFile, preMigrateBackup, permissions };
  } catch (error) {
    lock.release();
    throw error;
  }
}
