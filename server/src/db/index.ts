import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BRANDING } from '@fireside/shared';
import BetterSqlite3 from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import type { BaseSQLiteDatabase } from 'drizzle-orm/sqlite-core';
import { readMigrationFiles, type MigrationMeta } from 'drizzle-orm/migrator';
import * as schema from './schema.js';

/** Generated migrations, committed in `server/drizzle/` (same path from src/ and dist/). */
export const MIGRATIONS_DIR = fileURLToPath(new URL('../../drizzle/', import.meta.url));

/** Same table and format as Drizzle's own migrator, so drizzle-kit tools still work. */
export const MIGRATIONS_TABLE = '__drizzle_migrations';

/** How long to wait for another process (e.g. the CLI) to release a lock. */
const BUSY_TIMEOUT_MS = 5000;

export type Db = BetterSQLite3Database<typeof schema>;

/** A database or a transaction on it. Both have the same query API. */
export type Queryable = BaseSQLiteDatabase<'sync', BetterSqlite3.RunResult, typeof schema>;

export interface Database {
  /** Drizzle query builder. Use this in app code. */
  db: Db;
  /** The raw connection, for pragmas and tests. */
  sqlite: BetterSqlite3.Database;
  close(): void;
}

export interface OpenDatabaseOptions {
  /** Folder with drizzle-kit migrations. Only tests change this. */
  migrationsFolder?: string;
  /**
   * Apply pending migrations (default). With `false`, the database is only
   * checked: `PendingMigrationsError` if migrations are pending. Used by the
   * CLI while a server owns the database, which must not migrate under it.
   */
  migrate?: boolean;
}

/** Path of the database file inside `DATA_DIR`. */
export function databasePath(dataDir: string): string {
  return join(dataDir, `${BRANDING.shortName}.db`);
}

/** Thrown when the migrations in the database and in `server/drizzle/` don't match. */
export class MigrationError extends Error {
  override name = 'MigrationError';
}

/** Thrown when the database has a migration this server doesn't know: it is from a newer version. */
export class UnknownMigrationError extends MigrationError {
  override name = 'UnknownMigrationError';
}

/** Thrown by `openDatabase(…, { migrate: false })` when the database needs migrations. */
export class PendingMigrationsError extends MigrationError {
  override name = 'PendingMigrationsError';
}

/** Thrown when a migration would leave rows pointing at rows that no longer exist. */
export class ForeignKeyViolationError extends MigrationError {
  override name = 'ForeignKeyViolationError';
}

/**
 * Opens (or creates) the database and its folder, sets connection pragmas
 * and applies any pending migrations. Pass `':memory:'` for a throwaway
 * database in tests.
 */
export function openDatabase(
  filename: string,
  { migrationsFolder = MIGRATIONS_DIR, migrate: applyMigrations = true }: OpenDatabaseOptions = {},
): Database {
  if (filename !== ':memory:') mkdirSync(dirname(filename), { recursive: true });

  const sqlite = new BetterSqlite3(filename, { timeout: BUSY_TIMEOUT_MS });
  try {
    // WAL lets the dashboard read while ingest writes. In-memory databases
    // ignore it and stay in "memory" mode. The mode is saved in the file, so
    // this only takes a lock the very first time. That first switch can't
    // wait for other writers (SQLite returns "locked" at once), which only
    // matters if two processes create a brand-new database at the same moment.
    sqlite.pragma('journal_mode = WAL');
    // Safe with WAL: a power loss can lose the last commits, never corrupt the file.
    sqlite.pragma('synchronous = NORMAL');

    if (applyMigrations) migrate(sqlite, migrationsFolder);
    else checkMigrations(sqlite, migrationsFolder);
    sqlite.pragma('foreign_keys = ON');

    return {
      db: drizzle(sqlite, { schema }),
      sqlite,
      close: () => {
        if (sqlite.open) sqlite.close();
      },
    };
  } catch (error) {
    sqlite.close();
    throw error;
  }
}

/**
 * Applies pending migrations in one transaction. Replaces Drizzle's
 * migrator, which (in 0.45) has these problems for us:
 * - It checks which migrations are applied before taking the write lock, so
 *   two processes starting at once (server + CLI) can both apply the same one.
 *   Here the check is repeated inside `BEGIN IMMEDIATE`.
 * - `PRAGMA foreign_keys` can't change inside a transaction, so the table
 *   rebuilds drizzle-kit generates would run with foreign keys on and fail.
 *   Here foreign keys stay off during migrations and are checked before commit.
 * - It only compares against the newest applied migration, so an older one
 *   merged late, or an applied file that was edited, is skipped silently.
 *   Here both are errors.
 * When nothing is pending, no write lock is taken, so a long CLI job does not
 * block the server from starting.
 */
function migrate(sqlite: BetterSqlite3.Database, migrationsFolder: string): void {
  const migrations = readMigrationFiles({ migrationsFolder });

  // A no-op without a write lock when the table already exists.
  sqlite.exec(
    `CREATE TABLE IF NOT EXISTS "${MIGRATIONS_TABLE}" ` +
      '(id SERIAL PRIMARY KEY, hash text NOT NULL, created_at numeric)',
  );
  if (pendingMigrations(sqlite, migrations).length === 0) return;

  sqlite.pragma('foreign_keys = OFF');
  sqlite
    .transaction(() => {
      // Another process may have applied them while we waited for the lock.
      const pending = pendingMigrations(sqlite, migrations);
      if (pending.length === 0) return;

      const insert = sqlite.prepare(
        `INSERT INTO "${MIGRATIONS_TABLE}" (hash, created_at) VALUES (?, ?)`,
      );
      for (const migration of pending) {
        for (const statement of migration.sql) sqlite.exec(statement);
        insert.run(migration.hash, migration.folderMillis);
      }

      const violations = sqlite.pragma('foreign_key_check') as unknown[];
      if (violations.length > 0) {
        throw new ForeignKeyViolationError(
          `Migration left ${String(violations.length)} broken foreign key reference(s): ` +
            JSON.stringify(violations.slice(0, 5)),
        );
      }
    })
    .immediate();
}

/** Throws `PendingMigrationsError` (or a `MigrationError`) unless the database is up to date. Only reads. */
function checkMigrations(sqlite: BetterSqlite3.Database, migrationsFolder: string): void {
  const migrations = readMigrationFiles({ migrationsFolder });
  const hasTable =
    sqlite
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(MIGRATIONS_TABLE) !== undefined;
  const pending = hasTable ? pendingMigrations(sqlite, migrations).length : migrations.length;
  if (pending > 0) {
    throw new PendingMigrationsError(
      `The database needs ${String(pending)} migration(s) that have not been applied.`,
    );
  }
}

/**
 * Number of migrations `openDatabase` would apply to this database. Only
 * reads. Throws `UnknownMigrationError` if the database is from a newer
 * version, or `MigrationError` if it and the files disagree in another way.
 */
export function countPendingMigrations(
  sqlite: BetterSqlite3.Database,
  migrationsFolder: string = MIGRATIONS_DIR,
): number {
  return pendingMigrations(sqlite, readMigrationFiles({ migrationsFolder })).length;
}

/**
 * Migrations not yet applied. Throws if the database and the files disagree.
 * The stored hash is a SHA-256 of the whole `.sql` file, comments included, so
 * never edit an applied migration file, not even a comment: every database that
 * has applied it would then refuse to start. Add a new migration instead.
 */
function pendingMigrations(
  sqlite: BetterSqlite3.Database,
  migrations: MigrationMeta[],
): MigrationMeta[] {
  const rows = sqlite.prepare(`SELECT hash, created_at FROM "${MIGRATIONS_TABLE}"`).all() as {
    hash: string;
    created_at: number | string;
  }[];
  const applied = new Map(rows.map((row) => [Number(row.created_at), row.hash]));
  const known = new Set(migrations.map((migration) => migration.folderMillis));
  const newestApplied = Math.max(0, ...applied.keys());
  const label = (millis: number) => `migration from ${new Date(millis).toISOString()}`;

  for (const millis of applied.keys()) {
    if (!known.has(millis)) {
      throw new UnknownMigrationError(
        `The database has a ${label(millis)} that this server version doesn't know. ` +
          'Is the database from a newer version?',
      );
    }
  }

  const pending: MigrationMeta[] = [];
  for (const migration of migrations) {
    const hash = applied.get(migration.folderMillis);
    if (hash === undefined) {
      if (migration.folderMillis < newestApplied) {
        throw new MigrationError(
          `The ${label(migration.folderMillis)} is older than the newest applied one. ` +
            'Regenerate it so it comes last.',
        );
      }
      pending.push(migration);
    } else if (hash !== migration.hash) {
      throw new MigrationError(
        `The ${label(migration.folderMillis)} was changed after it was applied. ` +
          'Add a new migration instead of editing an old one.',
      );
    }
  }
  return pending;
}
