import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describeTightenResult, tightenDataDir, tightenWarnings } from '../tighten-data-dir.js';
import { acquireInstanceLock, InstanceLockedError, type InstanceLock } from '../backup/lock.js';
import { backupBeforeMigrating, PreMigrateBackupError } from '../backup/pre-migrate.js';
import {
  databasePath,
  openDatabase,
  PendingMigrationsError,
  type Database,
  type OpenDatabaseOptions,
} from '../db/index.js';
import { projectionUpgrade } from '../projections/versions.js';
import { CliError, type OpenDbOptions } from './run.js';

// How `pnpm cli` shares DATA_DIR with a server (see backup/lock.ts).
//
// keys, rebuild, reprocess and backup are safe while the server runs, so they
// don't need the instance lock. But only the process holding the lock may
// change the database file itself (migrations): a CLI on a
// branch with a new migration must never migrate a database a running server
// owns. So the CLI takes the lock if it is free and holds it until it exits
// (a server started meanwhile gets the clear "already running" error). If a
// server holds it, the CLI opens the database without migrating and refuses
// if the code and the database don't match.

export interface CliDataDirOptions extends Pick<OpenDatabaseOptions, 'migrationsFolder'> {
  /** `BACKUP_DIR`, for the copy taken before migrating. Default: `<dataDir>/backups`. */
  backupDir?: string;
}

/** The CLI's claim on DATA_DIR, taken the first time a command needs the database. */
export class CliDataDir {
  private lock: InstanceLock | undefined;
  private claimed = false;
  private running = false;

  constructor(
    readonly dataDir: string,
    private readonly log: (line: string) => void,
    private readonly openOptions: CliDataDirOptions = {},
  ) {}

  get dbFile(): string {
    return databasePath(this.dataDir);
  }

  /** Takes the lock if it is free. Returns true if a server holds it. */
  claim(): boolean {
    if (!this.claimed) {
      this.claimed = true;
      try {
        this.lock = acquireInstanceLock(this.dataDir);
      } catch (error) {
        if (!(error instanceof InstanceLockedError)) throw error;
        this.running = true;
      }
    }
    return this.running;
  }

  /**
   * Claims DATA_DIR and fails if there is no database (unless `create`). Prints which file is used, so a
   * wrong DATA_DIR is easy to spot.
   */
  prepare({ create }: OpenDbOptions): void {
    const serverRunning = this.claim();
    if (!create && !existsSync(this.dbFile)) {
      throw new CliError(
        `No database at ${this.dbFile}.\n` +
          'Check DATA_DIR in .env (it must match the server), or create the first key with: ' +
          'pnpm cli keys create <name>',
      );
    }
    this.log(`Database: ${this.dbFile}${serverRunning ? ' (in use by a running server)' : ''}`);
    this.makePrivate();
  }

  /**
   * With the lock (no server runs): makes the folders and our files in them
   * private, as the server does at startup (tighten-data-dir.ts). Says so only
   * when something changed or could not be changed.
   */
  private makePrivate(): void {
    if (this.running) return;
    const { backupDir = join(this.dataDir, 'backups') } = this.openOptions;
    const result = tightenDataDir({ dataDir: this.dataDir, backupDir });
    if (result.tightened > 0) this.log(describeTightenResult(result));
    for (const warning of tightenWarnings(result)) this.log(warning);
  }

  /**
   * Opens the database: migrates it with the lock, only checks it without.
   * Same order as the server (open-data-dir.ts): lock, private (in
   * `prepare`), backup before migrating, migrate.
   */
  open(options: OpenDbOptions): Database {
    this.prepare(options);
    const { backupDir = join(this.dataDir, 'backups'), migrationsFolder } = this.openOptions;
    const upgrade = projectionUpgrade();
    if (!this.running) {
      try {
        const copy = backupBeforeMigrating({
          dbFile: this.dbFile,
          backupDir,
          ...(migrationsFolder === undefined ? {} : { migrationsFolder }),
          upgradePending: upgrade.pending,
        });
        if (copy !== undefined) this.log(`Backup before migrating: ${copy}`);
      } catch (error) {
        if (error instanceof PreMigrateBackupError) {
          throw new CliError(`${error.message}\nNothing was migrated. Check BACKUP_DIR.`);
        }
        throw new CliError(`Could not open the database at ${this.dbFile}: ${String(error)}`);
      }
    }
    try {
      const database = openDatabase(this.dbFile, {
        ...(migrationsFolder === undefined ? {} : { migrationsFolder }),
        migrate: !this.running,
        upgrade,
      });
      if (database.upgrade) {
        const { projections, durationMs } = database.upgrade;
        this.log(
          `Recomputed ${projections.join(', ')} after a rule change in ${String(durationMs)} ms.`,
        );
      }
      // A database (and `-wal`) this command just created.
      this.makePrivate();
      return database;
    } catch (error) {
      if (error instanceof PendingMigrationsError) {
        throw new CliError(
          `${error.message}\nA running server uses this database, and this code expects a ` +
            'newer database version. Stop the server and run the command again (it then ' +
            'brings the database up to date), or run it from the same version as the server.',
        );
      }
      throw new CliError(`Could not open the database at ${this.dbFile}: ${String(error)}`);
    }
  }

  /** Releases the lock if the CLI holds it. */
  release(): void {
    this.lock?.release();
    this.lock = undefined;
  }
}
