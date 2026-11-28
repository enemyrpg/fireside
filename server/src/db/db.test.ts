import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { BRANDING } from '@fireside/shared';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { testConfig, testDatabase } from '../test-utils.js';
import {
  databasePath,
  ForeignKeyViolationError,
  MigrationError,
  MIGRATIONS_DIR,
  openDatabase,
  PendingMigrationsError,
  type Database,
} from './index.js';
import { apiKeys, events, users, type NewEventRow } from './schema.js';
import { FIRST_USER_ID } from '../users/users.js';

interface ColumnInfo {
  name: string;
  type: string;
  notnull: 0 | 1;
  pk: 0 | 1;
}

interface IndexInfo {
  name: string;
  unique: 0 | 1;
}

function columns(database: Database, table: string) {
  return (database.sqlite.pragma(`table_info(${table})`) as ColumnInfo[]).map(
    ({ name, type, notnull, pk }) => ({ name, type, notnull: notnull === 1, pk: pk === 1 }),
  );
}

function indexes(database: Database, table: string) {
  return (database.sqlite.pragma(`index_list(${table})`) as IndexInfo[])
    .filter((index) => !index.name.startsWith('sqlite_autoindex_'))
    .map(({ name, unique }) => ({ name, unique: unique === 1 }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function tableNames(database: Database) {
  return database.sqlite
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' " +
        "AND name NOT LIKE '__drizzle%' ORDER BY name",
    )
    .pluck()
    .all();
}

const NOW = '2026-11-09T12:00:00.000Z';

function insertApiKey(database: Database) {
  return database.db
    .insert(apiKeys)
    .values({
      userId: FIRST_USER_ID,
      createdByUserId: FIRST_USER_ID,
      name: 'Gaming PC',
      keyHash: 'hash',
      prefix: 'abcd',
      createdAt: NOW,
    })
    .returning({ id: apiKeys.id })
    .get().id;
}

function event(apiKeyId: number, overrides: Partial<NewEventRow> = {}): NewEventRow {
  return {
    eventId: '019a6b3e-0000-7000-8000-000000000001',
    userId: FIRST_USER_ID,
    type: 'heartbeat',
    accountHash: '123456789',
    sessionId: '019a6b3e-0000-7000-8000-0000000000aa',
    occurredAt: NOW,
    receivedAt: NOW,
    apiKeyId,
    schemaVersion: 1,
    payload: '{}',
    ...overrides,
  };
}

describe('in-memory database', () => {
  let database: Database;
  beforeEach(() => {
    database = testDatabase();
  });
  afterEach(() => {
    database.close();
  });

  it('creates the raw and derived tables, users, sessions and the audit log', () => {
    expect(tableNames(database)).toEqual([
      'account_clog_sources',
      'account_ids',
      'account_names',
      'account_pets',
      'accounts',
      'api_keys',
      'audit_log',
      'bank_snapshot_items',
      'bank_snapshots',
      'clog_feed_times',
      'clog_items',
      'clog_obtained',
      'clog_reads',
      'clog_snapshots',
      'container_snapshot_items',
      'diary_completions',
      'diary_snapshots',
      'diary_states',
      'events',
      'external_snapshots',
      'external_sources',
      'invites',
      'item_icons',
      'kc_observations',
      'loot_events',
      'loot_items',
      'named_icons',
      'pb_records',
      'pet_drops',
      'potion_storage_items',
      'potion_storage_snapshots',
      'price_day_hours',
      'price_days',
      'price_hour_fetches',
      'price_hours',
      'projection_versions',
      'quest_completions',
      'quest_snapshots',
      'quest_states',
      'raid_drop_choices',
      'raid_manual_drops',
      'raid_special_loot',
      'raid_split_defaults',
      'recovery_codes',
      'server_settings',
      'session_afk_estimates',
      'session_afk_periods',
      'session_heartbeats',
      'session_summaries',
      'sessions',
      'trusted_devices',
      'user_sessions',
      'users',
      'weekly_summaries',
      'xp_snapshot_skills',
      'xp_snapshots',
    ]);
  });

  it('creates api_keys as in 03', () => {
    expect(columns(database, 'api_keys')).toEqual([
      { name: 'id', type: 'INTEGER', notnull: true, pk: true },
      { name: 'user_id', type: 'INTEGER', notnull: true, pk: false },
      { name: 'created_by_user_id', type: 'INTEGER', notnull: false, pk: false },
      { name: 'revoked_by_user_id', type: 'INTEGER', notnull: false, pk: false },
      { name: 'name', type: 'TEXT', notnull: true, pk: false },
      { name: 'key_hash', type: 'TEXT', notnull: true, pk: false },
      { name: 'prefix', type: 'TEXT', notnull: true, pk: false },
      { name: 'created_at', type: 'TEXT', notnull: true, pk: false },
      { name: 'last_used_at', type: 'TEXT', notnull: false, pk: false },
      { name: 'revoked_at', type: 'TEXT', notnull: false, pk: false },
    ]);
    expect(indexes(database, 'api_keys')).toEqual([
      { name: 'api_keys_key_hash_unique', unique: true },
      { name: 'api_keys_user_idx', unique: false },
    ]);
    const keyReferences = database.sqlite.pragma('foreign_key_list(api_keys)') as {
      table: string;
      from: string;
      on_delete: string;
    }[];
    // A deleted user's own keys are deleted with them (users/delete-user.ts);
    // a key someone else made or revoked keeps its row.
    expect(
      keyReferences.map((row) => `${row.from} → ${row.table} (${row.on_delete})`).sort(),
    ).toEqual([
      'created_by_user_id → users (SET NULL)',
      'revoked_by_user_id → users (SET NULL)',
      'user_id → users (NO ACTION)',
    ]);
  });

  it('creates invites as in 03', () => {
    expect(columns(database, 'invites').map((column) => column.name)).toEqual([
      'id',
      'type',
      'token_hash',
      'label',
      'created_by',
      'created_at',
      'expires_at',
      'role',
      'can_create_api_keys',
      'target_user_id',
      'used_at',
      'used_by',
      'revoked_at',
      'revoked_by',
    ]);
    expect(indexes(database, 'invites')).toEqual([
      { name: 'invites_created_at_idx', unique: false },
      { name: 'invites_token_hash_unique', unique: true },
      { name: 'invites_type_target_idx', unique: false },
    ]);
    const references = database.sqlite.pragma('foreign_key_list(invites)') as {
      table: string;
      from: string;
      on_delete: string;
    }[];
    expect(references.map((row) => `${row.from} → ${row.table} (${row.on_delete})`).sort()).toEqual(
      [
        'created_by → users (SET NULL)',
        'revoked_by → users (SET NULL)',
        'target_user_id → users (CASCADE)',
        'used_by → users (SET NULL)',
      ],
    );
  });

  it('creates user_sessions and audit_log as in 03', () => {
    expect(columns(database, 'user_sessions')).toEqual([
      { name: 'id', type: 'TEXT', notnull: true, pk: true },
      { name: 'user_id', type: 'INTEGER', notnull: true, pk: false },
      { name: 'created_at', type: 'TEXT', notnull: true, pk: false },
      { name: 'last_seen_at', type: 'TEXT', notnull: true, pk: false },
      { name: 'expires_at', type: 'TEXT', notnull: true, pk: false },
      { name: 'user_agent', type: 'TEXT', notnull: false, pk: false },
    ]);
    expect(indexes(database, 'user_sessions')).toEqual([
      { name: 'user_sessions_user_idx', unique: false },
    ]);
    expect(columns(database, 'audit_log')).toEqual([
      { name: 'id', type: 'INTEGER', notnull: true, pk: true },
      { name: 'at', type: 'TEXT', notnull: true, pk: false },
      { name: 'actor_user_id', type: 'INTEGER', notnull: false, pk: false },
      { name: 'action', type: 'TEXT', notnull: true, pk: false },
      { name: 'target', type: 'TEXT', notnull: false, pk: false },
    ]);
  });

  it('creates users with user 1, the local admin', () => {
    expect(columns(database, 'users')).toEqual([
      { name: 'id', type: 'INTEGER', notnull: true, pk: true },
      { name: 'username', type: 'TEXT', notnull: true, pk: false },
      { name: 'password_hash', type: 'TEXT', notnull: false, pk: false },
      { name: 'role', type: 'TEXT', notnull: true, pk: false },
      { name: 'can_create_api_keys', type: 'INTEGER', notnull: true, pk: false },
      { name: 'totp_secret', type: 'TEXT', notnull: false, pk: false },
      { name: 'disabled_at', type: 'TEXT', notnull: false, pk: false },
      { name: 'created_at', type: 'TEXT', notnull: true, pk: false },
      { name: 'last_login_at', type: 'TEXT', notnull: false, pk: false },
      { name: 'totp_enabled_at', type: 'TEXT', notnull: false, pk: false },
      { name: 'totp_last_step', type: 'INTEGER', notnull: false, pk: false },
      { name: 'totp_pending_secret', type: 'TEXT', notnull: false, pk: false },
      { name: 'totp_pending_expires_at', type: 'TEXT', notnull: false, pk: false },
    ]);
    expect(indexes(database, 'users')).toEqual([{ name: 'users_username_unique', unique: true }]);
    const [admin, ...others] = database.db.select().from(users).all();
    expect(others).toEqual([]);
    expect(admin).toMatchObject({
      id: FIRST_USER_ID,
      username: 'admin',
      passwordHash: null,
      role: 'admin',
      canCreateApiKeys: true,
      totpSecret: null,
      disabledAt: null,
      lastLoginAt: null,
    });
    expect(admin?.createdAt).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
  });

  it('creates events as in 03, with projection status and indexes for projections', () => {
    expect(columns(database, 'events')).toEqual([
      { name: 'event_id', type: 'TEXT', notnull: true, pk: true },
      { name: 'user_id', type: 'INTEGER', notnull: true, pk: false },
      { name: 'type', type: 'TEXT', notnull: true, pk: false },
      { name: 'account_hash', type: 'TEXT', notnull: true, pk: false },
      { name: 'session_id', type: 'TEXT', notnull: true, pk: false },
      { name: 'occurred_at', type: 'TEXT', notnull: true, pk: false },
      { name: 'received_at', type: 'TEXT', notnull: true, pk: false },
      { name: 'api_key_id', type: 'INTEGER', notnull: true, pk: false },
      { name: 'schema_version', type: 'INTEGER', notnull: true, pk: false },
      { name: 'payload', type: 'TEXT', notnull: true, pk: false },
      { name: 'processed_at', type: 'TEXT', notnull: false, pk: false },
      { name: 'projection_error', type: 'TEXT', notnull: false, pk: false },
    ]);
    expect(indexes(database, 'events')).toEqual([
      { name: 'events_account_occurred_idx', unique: false },
      { name: 'events_account_type_occurred_idx', unique: false },
      { name: 'events_occurred_at_idx', unique: false },
      { name: 'events_session_type_occurred_idx', unique: false },
      { name: 'events_unprocessed_idx', unique: false },
    ]);
    const eventReferences = database.sqlite.pragma('foreign_key_list(events)') as {
      table: string;
      from: string;
    }[];
    expect(eventReferences.map((row) => `${row.from} → ${row.table}`).sort()).toEqual([
      'api_key_id → api_keys',
      'user_id → users',
    ]);
  });

  it('creates account_ids, accounts and account_names as in 03', () => {
    expect(columns(database, 'account_ids')).toEqual([
      { name: 'id', type: 'INTEGER', notnull: true, pk: true },
      { name: 'user_id', type: 'INTEGER', notnull: true, pk: false },
      { name: 'account_hash', type: 'TEXT', notnull: true, pk: false },
    ]);
    expect(indexes(database, 'account_ids')).toEqual([
      { name: 'account_ids_user_hash_idx', unique: true },
    ]);
    expect(columns(database, 'accounts')).toEqual([
      { name: 'id', type: 'INTEGER', notnull: true, pk: true },
      { name: 'user_id', type: 'INTEGER', notnull: true, pk: false },
      { name: 'account_hash', type: 'TEXT', notnull: true, pk: false },
      { name: 'account_type', type: 'TEXT', notnull: false, pk: false },
      { name: 'display_name', type: 'TEXT', notnull: false, pk: false },
      { name: 'first_seen_at', type: 'TEXT', notnull: true, pk: false },
      { name: 'last_seen_at', type: 'TEXT', notnull: true, pk: false },
    ]);
    expect(indexes(database, 'accounts')).toEqual([
      { name: 'accounts_user_hash_idx', unique: true },
    ]);
    expect(columns(database, 'account_names')).toEqual([
      { name: 'id', type: 'INTEGER', notnull: true, pk: true },
      { name: 'account_id', type: 'INTEGER', notnull: true, pk: false },
      { name: 'display_name', type: 'TEXT', notnull: true, pk: false },
      { name: 'first_seen_at', type: 'TEXT', notnull: true, pk: false },
      { name: 'first_event_id', type: 'TEXT', notnull: true, pk: false },
      { name: 'last_seen_at', type: 'TEXT', notnull: true, pk: false },
    ]);
    expect(indexes(database, 'account_names')).toEqual([
      { name: 'account_names_account_first_seen_idx', unique: true },
    ]);
    const accountReferences = database.sqlite.pragma('foreign_key_list(accounts)') as {
      table: string;
      from: string;
    }[];
    expect(accountReferences.map((row) => `${row.from} → ${row.table}`).sort()).toEqual([
      'id → account_ids',
      'user_id → users',
    ]);
    expect(database.sqlite.pragma('foreign_key_list(account_names)')).toMatchObject([
      { table: 'accounts', from: 'account_id', to: 'id', on_delete: 'CASCADE' },
    ]);
  });

  it('creates sessions, session_heartbeats and session_afk_periods as in 03 and 06', () => {
    expect(columns(database, 'sessions')).toEqual([
      { name: 'id', type: 'TEXT', notnull: true, pk: true },
      { name: 'account_id', type: 'INTEGER', notnull: true, pk: false },
      { name: 'started_at', type: 'TEXT', notnull: true, pk: false },
      { name: 'ended_at', type: 'TEXT', notnull: false, pk: false },
      { name: 'end_reason', type: 'TEXT', notnull: false, pk: false },
      { name: 'world', type: 'INTEGER', notnull: false, pk: false },
      { name: 'last_heartbeat_at', type: 'TEXT', notnull: true, pk: false },
      { name: 'duration_seconds', type: 'INTEGER', notnull: true, pk: false },
      { name: 'afk_seconds', type: 'INTEGER', notnull: true, pk: false },
      { name: 'active_seconds', type: 'INTEGER', notnull: true, pk: false },
    ]);
    expect(indexes(database, 'sessions')).toEqual([
      { name: 'sessions_account_started_idx', unique: false },
      { name: 'sessions_open_heartbeat_idx', unique: false },
    ]);
    expect(columns(database, 'session_heartbeats').map((column) => column.name)).toEqual([
      'event_id',
      'session_id',
      'at',
      'region_id',
      'world',
      'world_types',
      'world_location',
      'world_activity',
      'idle',
    ]);
    expect(indexes(database, 'session_heartbeats')).toEqual([
      { name: 'session_heartbeats_session_at_idx', unique: false },
    ]);
    expect(columns(database, 'session_afk_periods').map((column) => column.name)).toEqual([
      'id',
      'event_id',
      'session_id',
      'started_at',
      'ended_at',
    ]);
    expect(indexes(database, 'session_afk_periods')).toEqual([
      { name: 'session_afk_periods_event_id_unique', unique: true },
      { name: 'session_afk_periods_session_idx', unique: false },
    ]);
  });

  it('creates session_summaries as in 03', () => {
    expect(columns(database, 'session_summaries')).toEqual([
      { name: 'session_id', type: 'TEXT', notnull: true, pk: true },
      { name: 'xp_gained_total', type: 'INTEGER', notnull: true, pk: false },
      { name: 'xp_gained_by_skill', type: 'TEXT', notnull: true, pk: false },
      { name: 'loot_ge_value', type: 'INTEGER', notnull: true, pk: false },
      { name: 'loot_count', type: 'INTEGER', notnull: true, pk: false },
      { name: 'kc_gained_by_boss', type: 'TEXT', notnull: true, pk: false },
    ]);
  });

  it('enforces foreign keys', () => {
    expect(database.sqlite.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(() => database.db.insert(events).values(event(999)).run()).toThrow(/FOREIGN KEY/);
  });

  it('stores an event unchanged and rejects a second one with the same event_id', () => {
    const apiKeyId = insertApiKey(database);
    const row = event(apiKeyId, { payload: '{"skill":"Attack","xp":13034431}' });
    database.db.insert(events).values(row).run();

    expect(database.db.select().from(events).all()).toEqual([
      { ...row, processedAt: null, projectionError: null },
    ]);
    expect(() => database.db.insert(events).values(row).run()).toThrow(/UNIQUE/);
  });

  it('rejects a duplicate key_hash', () => {
    insertApiKey(database);
    expect(() => insertApiKey(database)).toThrow(/UNIQUE/);
  });
});

describe('database file', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), `${BRANDING.shortName}-test-`));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('is named after the project and lives in the data directory', () => {
    expect(databasePath(dir)).toBe(join(dir, `${BRANDING.shortName}.db`));
  });

  it('creates a missing data directory', () => {
    const file = databasePath(join(dir, 'nested', 'data'));
    openDatabase(file).close();
    expect(existsSync(file)).toBe(true);
  });

  it('uses WAL mode and can be reopened (migrations run again without error)', () => {
    const file = databasePath(dir);

    const first = openDatabase(file);
    expect(first.sqlite.pragma('journal_mode', { simple: true })).toBe('wal');
    insertApiKey(first);
    first.close();

    const second = openDatabase(file);
    expect(second.sqlite.pragma('journal_mode', { simple: true })).toBe('wal');
    expect(second.db.select().from(apiKeys).all()).toHaveLength(1);
    second.close();
  });
});

interface Journal {
  entries: { idx: number; version: string; when: number; tag: string; breakpoints: boolean }[];
}

/** Copies the real migrations to `dir` and adds one more, as drizzle-kit would. */
function migrationsWith(
  dir: string,
  tag: string,
  statements: string[],
  when?: (lastWhen: number) => number,
): string {
  const folder = join(dir, 'migrations');
  cpSync(MIGRATIONS_DIR, folder, { recursive: true });
  const journalFile = join(folder, 'meta', '_journal.json');
  const journal = JSON.parse(readFileSync(journalFile, 'utf8')) as Journal;
  const last = journal.entries.at(-1);
  if (!last) throw new Error('No migrations');
  journal.entries.push({
    ...last,
    idx: last.idx + 1,
    when: when ? when(last.when) : last.when + 1,
    tag,
  });
  writeFileSync(journalFile, JSON.stringify(journal));
  writeFileSync(join(folder, `${tag}.sql`), statements.join('--> statement-breakpoint\n'));
  return folder;
}

// What drizzle-kit generates when a column change needs a table rebuild.
const REBUILD_API_KEYS = [
  'PRAGMA foreign_keys=OFF;',
  'CREATE TABLE `__new_api_keys` (`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL, ' +
    "`name` text DEFAULT 'unnamed' NOT NULL, `key_hash` text NOT NULL, `prefix` text NOT NULL, " +
    '`created_at` text NOT NULL, `last_used_at` text, `revoked_at` text, ' +
    '`user_id` integer NOT NULL REFERENCES `users`(`id`), ' +
    '`created_by_user_id` integer NOT NULL REFERENCES `users`(`id`), ' +
    '`revoked_by_user_id` integer REFERENCES `users`(`id`));',
  'INSERT INTO `__new_api_keys` (`id`, `name`, `key_hash`, `prefix`, `created_at`, ' +
    '`last_used_at`, `revoked_at`, `user_id`, `created_by_user_id`, `revoked_by_user_id`) ' +
    'SELECT `id`, `name`, `key_hash`, `prefix`, `created_at`, `last_used_at`, `revoked_at`, ' +
    '`user_id`, `created_by_user_id`, `revoked_by_user_id` FROM `api_keys`;',
  'DROP TABLE `api_keys`;',
  'ALTER TABLE `__new_api_keys` RENAME TO `api_keys`;',
  'PRAGMA foreign_keys=ON;',
  'CREATE UNIQUE INDEX `api_keys_key_hash_unique` ON `api_keys` (`key_hash`);',
  'CREATE INDEX `api_keys_user_idx` ON `api_keys` (`user_id`);',
];

/**
 * Holds the write lock on `file` from another thread, like a second process
 * would. Releases after `releaseAfterMs`, or when `release()` is called.
 */
async function holdWriteLock(file: string, releaseAfterMs?: number) {
  const worker = new Worker(
    `
    const { parentPort, workerData } = require('node:worker_threads');
    const Sqlite = require(workerData.driver);
    const db = new Sqlite(workerData.file);
    db.pragma('journal_mode = WAL');
    db.exec('BEGIN IMMEDIATE; CREATE TABLE lock_holder (x)');
    const release = () => { db.exec('COMMIT'); db.close(); parentPort.close(); };
    parentPort.once('message', release);
    if (workerData.releaseAfterMs !== undefined) setTimeout(release, workerData.releaseAfterMs);
    parentPort.postMessage('locked');
    `,
    {
      eval: true,
      workerData: {
        file,
        releaseAfterMs,
        driver: createRequire(import.meta.url).resolve('better-sqlite3'),
      },
    },
  );
  const exited = new Promise((resolve) => worker.once('exit', resolve));
  await new Promise((resolve) => worker.once('message', resolve));
  return {
    exited,
    release: () => {
      worker.postMessage('release');
    },
  };
}

describe('migrations', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), `${BRANDING.shortName}-test-`));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function fileWithOneEvent(): string {
    const file = databasePath(dir);
    const database = openDatabase(file);
    database.db
      .insert(events)
      .values(event(insertApiKey(database)))
      .run();
    database.close();
    return file;
  }

  it('can rebuild a table that other rows point to, and keeps foreign keys on after', () => {
    const file = fileWithOneEvent();
    const migrationsFolder = migrationsWith(dir, '0001_rebuild_api_keys', REBUILD_API_KEYS);

    const database = openDatabase(file, { migrationsFolder });
    expect(database.db.select().from(apiKeys).all()).toHaveLength(1);
    expect(database.db.select().from(events).all()).toHaveLength(1);
    expect(database.sqlite.pragma('foreign_keys', { simple: true })).toBe(1);
    database.close();
  });

  it('rolls back a migration that breaks foreign keys', () => {
    const file = fileWithOneEvent();
    const migrationsFolder = migrationsWith(dir, '0001_bad', ['DELETE FROM `api_keys`;']);

    expect(() => openDatabase(file, { migrationsFolder })).toThrow(ForeignKeyViolationError);

    const database = openDatabase(file);
    expect(database.db.select().from(apiKeys).all()).toHaveLength(1);
    expect(database.sqlite.prepare('SELECT count(*) FROM __drizzle_migrations').pluck().get()).toBe(
      readMigrationFiles({ migrationsFolder: MIGRATIONS_DIR }).length,
    );
    database.close();
  });

  it('waits for another process that holds the write lock when migrations are pending', async () => {
    const file = databasePath(dir);
    // Another connection (e.g. the CLI) holds the write lock on a fresh
    // database. The file is already in WAL mode, as it always is after the
    // first start.
    const lock = await holdWriteLock(file, 300);

    const database = openDatabase(file);
    expect(database.sqlite.pragma('journal_mode', { simple: true })).toBe('wal');
    expect(tableNames(database)).toEqual([
      'account_clog_sources',
      'account_ids',
      'account_names',
      'account_pets',
      'accounts',
      'api_keys',
      'audit_log',
      'bank_snapshot_items',
      'bank_snapshots',
      'clog_feed_times',
      'clog_items',
      'clog_obtained',
      'clog_reads',
      'clog_snapshots',
      'container_snapshot_items',
      'diary_completions',
      'diary_snapshots',
      'diary_states',
      'events',
      'external_snapshots',
      'external_sources',
      'invites',
      'item_icons',
      'kc_observations',
      'lock_holder',
      'loot_events',
      'loot_items',
      'named_icons',
      'pb_records',
      'pet_drops',
      'potion_storage_items',
      'potion_storage_snapshots',
      'price_day_hours',
      'price_days',
      'price_hour_fetches',
      'price_hours',
      'projection_versions',
      'quest_completions',
      'quest_snapshots',
      'quest_states',
      'raid_drop_choices',
      'raid_manual_drops',
      'raid_special_loot',
      'raid_split_defaults',
      'recovery_codes',
      'server_settings',
      'session_afk_estimates',
      'session_afk_periods',
      'session_heartbeats',
      'session_summaries',
      'sessions',
      'trusted_devices',
      'user_sessions',
      'users',
      'weekly_summaries',
      'xp_snapshot_skills',
      'xp_snapshots',
    ]);
    database.close();
    await lock.exited;
  });

  it('does not need the write lock when nothing is pending', async () => {
    const file = databasePath(dir);
    openDatabase(file).close();
    // A long write (e.g. `pnpm cli rebuild`) must not stop the server starting.
    // Without the fix this blocks for the 5 s busy timeout and then throws.
    const lock = await holdWriteLock(file);

    const started = Date.now();
    const database = openDatabase(file);
    expect(Date.now() - started).toBeLessThan(1000);
    database.close();
    lock.release();
    await lock.exited;
  });

  it('refuses a pending migration older than the newest applied one', () => {
    const file = fileWithOneEvent();
    const migrationsFolder = migrationsWith(dir, '0001_late', ['SELECT 1;'], (last) => last - 1);

    expect(() => openDatabase(file, { migrationsFolder })).toThrow(/older than the newest/);
  });

  it('refuses an applied migration that was edited', () => {
    const file = fileWithOneEvent();
    const migrationsFolder = migrationsWith(dir, '0001_extra', ['SELECT 1;']);
    openDatabase(file, { migrationsFolder }).close();
    writeFileSync(join(migrationsFolder, '0001_extra.sql'), 'SELECT 2;');

    expect(() => openDatabase(file, { migrationsFolder })).toThrow(MigrationError);
    expect(() => openDatabase(file, { migrationsFolder })).toThrow(/changed after it was applied/);
  });

  it('with migrate: false, opens an up-to-date database without writing', () => {
    const file = fileWithOneEvent();
    const database = openDatabase(file, { migrate: false });
    expect(database.db.select().from(events).all()).toHaveLength(1);
    database.close();
  });

  it('with migrate: false, refuses pending migrations and leaves the file alone', () => {
    const file = fileWithOneEvent();
    const migrationsFolder = migrationsWith(dir, '0001_extra', [
      'CREATE TABLE extra (id integer);',
    ]);

    expect(() => openDatabase(file, { migrationsFolder, migrate: false })).toThrow(
      PendingMigrationsError,
    );
    const database = openDatabase(file);
    expect(tableNames(database)).not.toContain('extra');
    database.close();
  });

  it('with migrate: false, refuses a database that was never migrated', () => {
    const file = databasePath(dir);
    expect(() => openDatabase(file, { migrate: false })).toThrow(PendingMigrationsError);
  });

  it('refuses a database with migrations this version does not know', () => {
    const file = fileWithOneEvent();
    const migrationsFolder = migrationsWith(dir, '0001_future', ['SELECT 1;']);
    openDatabase(file, { migrationsFolder }).close();

    expect(() => openDatabase(file)).toThrow(/newer version/);
  });
});

describe('app', () => {
  it('closes the database when the app closes', async () => {
    const database = testDatabase();
    const app = buildApp({ config: testConfig(), db: database });
    await app.ready();
    expect(app.db).toBe(database.db);

    await app.close();
    expect(database.sqlite.open).toBe(false);
  });
});

describe('migration 0006 (loot item position)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), `${BRANDING.shortName}-test-`));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** The real migrations up to (not including) `tag`. */
  function migrationsBefore(tag: string): string {
    const folder = join(dir, 'migrations');
    cpSync(MIGRATIONS_DIR, folder, { recursive: true });
    const journalFile = join(folder, 'meta', '_journal.json');
    const journal = JSON.parse(readFileSync(journalFile, 'utf8')) as Journal;
    const index = journal.entries.findIndex((entry) => entry.tag === tag);
    expect(index).toBeGreaterThan(0);
    journal.entries = journal.entries.slice(0, index);
    writeFileSync(journalFile, JSON.stringify(journal));
    return folder;
  }

  it('numbers existing items per loot event in id (payload) order', () => {
    const file = databasePath(dir);
    const old = openDatabase(file, {
      migrationsFolder: migrationsBefore('0006_loot_item_position'),
    });
    const run = (statement: string, ...params: unknown[]) =>
      old.sqlite.prepare(statement).run(...params);
    // Raw SQL: the schema is the one from before 0006, not schema.ts.
    run(
      "INSERT INTO api_keys (id, name, key_hash, prefix, created_at) VALUES (1, 'PC', 'hash', 'abcd', ?)",
      NOW,
    );
    run("INSERT INTO account_ids (id, account_hash) VALUES (1, '123456789')");
    run(
      "INSERT INTO accounts (id, account_hash, first_seen_at, last_seen_at) VALUES (1, '123456789', ?, ?)",
      NOW,
      NOW,
    );
    // Two loot events whose items interleave by id: A gets ids 1 and 3, B gets 2 and 4.
    for (const n of [1, 2]) {
      const eventId = `019a6b3e-0000-7000-8000-00000000000${String(n)}`;
      run(
        'INSERT INTO events (event_id, type, account_hash, session_id, occurred_at, received_at, ' +
          "api_key_id, schema_version, payload) VALUES (?, 'loot', '123456789', 's', ?, ?, 1, 1, '{}')",
        eventId,
        NOW,
        NOW,
      );
      run(
        'INSERT INTO loot_events (id, account_id, session_id, event_id, occurred_at, source_type, ' +
          "source_name, total_ge_value, total_ha_value) VALUES (?, 1, 's', ?, ?, 'NPC', 'Vorkath', 0, 0)",
        n,
        eventId,
        NOW,
      );
    }
    for (const [lootEventId, itemId] of [
      [1, 10],
      [2, 20],
      [1, 11],
      [2, 21],
    ]) {
      run(
        'INSERT INTO loot_items (loot_event_id, item_id, item_name, quantity, ge_price_each, ' +
          "ha_price_each) VALUES (?, ?, 'Item', 1, 0, 0)",
        lootEventId,
        itemId,
      );
    }
    old.close();

    const database = openDatabase(file);
    expect(
      database.sqlite
        .prepare('SELECT loot_event_id, item_id, position FROM loot_items ORDER BY id')
        .all(),
    ).toEqual([
      { loot_event_id: 1, item_id: 10, position: 0 },
      { loot_event_id: 2, item_id: 20, position: 0 },
      { loot_event_id: 1, item_id: 11, position: 1 },
      { loot_event_id: 2, item_id: 21, position: 1 },
    ]);
    expect(indexes(database, 'loot_items')).toEqual([
      { name: 'loot_items_loot_event_position_idx', unique: true },
    ]);
    // Same table as a fresh database: no default, so a missing position is an error.
    expect(columns(database, 'loot_items')).toContainEqual({
      name: 'position',
      type: 'INTEGER',
      notnull: true,
      pk: false,
    });
    expect(
      database.sqlite
        .prepare("SELECT dflt_value FROM pragma_table_info('loot_items') WHERE name = 'position'")
        .pluck()
        .get(),
    ).toBeNull();
    expect(() =>
      database.sqlite
        .prepare(
          'INSERT INTO loot_items (loot_event_id, item_id, item_name, quantity, ge_price_each, ' +
            "ha_price_each) VALUES (1, 12, 'Item', 1, 0, 0)",
        )
        .run(),
    ).toThrow(/NOT NULL/);
    // IDs are kept, and new items still get higher ones.
    const next = database.sqlite
      .prepare(
        'INSERT INTO loot_items (loot_event_id, position, item_id, item_name, quantity, ' +
          "ge_price_each, ha_price_each) VALUES (1, 2, 12, 'Item', 1, 0, 0) RETURNING id",
      )
      .pluck()
      .get();
    expect(next).toBe(5);
    expect(database.sqlite.pragma('foreign_key_check')).toEqual([]);
    database.close();
  });
});
