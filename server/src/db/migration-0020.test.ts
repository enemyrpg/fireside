import { copyFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApiKey, revokeApiKey } from '../auth/api-keys.js';
import { migrationsBefore, tempDir } from '../backup/testing.js';
import { createManualDrop } from '../raids/choices.js';
import { generateSeed } from '../seed/generator/generate.js';
import { seedInProcess } from '../seed/in-process.js';
import { testConfig, testDatabase, TEST_OWNER } from '../test-utils.js';
import { FIRST_USER_ID } from '../users/users.js';
import { databasePath, MIGRATIONS_TABLE, openDatabase } from './index.js';
import { checkMigration, tableState } from './migration-check.js';

// Migration 0020 (users and ownership) on a realistic database: a seed sent
// through ingest, with keys, collection logs and raid choices, as version 0019
// would have stored it. Afterwards every row must be there with the same
// content, everything must belong to user 1, and a rebuild must give the same
// derived tables.

const SEED = {
  seed: 3,
  accounts: 2,
  months: 0.5,
  until: new Date('2026-11-03T20:00:00.000Z'),
  timeZone: 'Europe/Oslo',
};
const NOW = new Date('2026-11-04T12:00:00.000Z');
const TBOW = 20997;

describe('migration 0020 (users and ownership)', () => {
  let dir: string;
  let remove: () => void;
  beforeEach(() => {
    ({ dir, remove } = tempDir());
  });
  afterEach(() => {
    remove();
  });

  /** The seeded database with today's schema: every row of user 1. */
  async function seededToday(): Promise<string> {
    const database = testDatabase();
    try {
      const data = generateSeed(SEED);
      const result = await seedInProcess(database, testConfig({ TZ: SEED.timeZone }), data);
      expect(result.failed).toEqual([]);
      const db = database.db;
      // A revoked key, a split default, a choice on a detected event and a manual drop.
      const { id } = createApiKey(db, TEST_OWNER, 'Old laptop', NOW);
      revokeApiKey(db, id, { byUserId: FIRST_USER_ID, now: NOW });
      const sqlite = database.sqlite;
      const account = sqlite.prepare('SELECT id FROM accounts ORDER BY id LIMIT 1').pluck().get();
      // A drop's own event: a choice on an event with no drop would be removed.
      const event = sqlite
        .prepare("SELECT event_id FROM events WHERE type = 'raid.special_loot' LIMIT 1")
        .pluck()
        .get();
      expect(event).toBeDefined();
      sqlite
        .prepare(
          "INSERT INTO raid_split_defaults (account_id, mode, updated_at) VALUES (?, 'FFA', ?)",
        )
        .run(account, NOW.toISOString());
      sqlite
        .prepare(
          'INSERT INTO raid_drop_choices (event_id, item_index, mode, own_value, updated_at) ' +
            "VALUES (?, 0, 'SPLIT', 123, ?)",
        )
        .run(event, NOW.toISOString());
      createManualDrop(
        db,
        account as number,
        { raid: 'Chambers of Xeric', itemId: TBOW, occurredAt: '2026-11-01T20:00:00.000Z' },
        NOW,
      );
      const file = join(dir, 'today.db');
      writeFileSync(file, sqlite.serialize());
      return file;
    } finally {
      database.close();
    }
  }

  /**
   * The same rows in a database built with the migrations before 0020, the
   * way the previous version stored them (without the new columns).
   */
  function asVersion0019(today: string): string {
    const file = databasePath(dir);
    openDatabase(file, { migrationsFolder: migrationsBefore(dir, '0020_users_ownership') }).close();
    const old = new BetterSqlite3(file);
    try {
      old.pragma('foreign_keys = OFF');
      old.prepare('ATTACH DATABASE ? AS today').run(today);
      const tables = old
        .prepare(
          "SELECT name FROM main.sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name <> ?",
        )
        .pluck()
        .all(MIGRATIONS_TABLE) as string[];
      // Tables a later migration dropped (the `/latest` prices, 0028) are left empty.
      const inToday = new Set(
        old
          .prepare("SELECT name FROM today.sqlite_master WHERE type = 'table'")
          .pluck()
          .all() as string[],
      );
      old.transaction(() => {
        for (const table of tables.filter((name) => inToday.has(name))) {
          const columns = (old.pragma(`main.table_info("${table}")`) as { name: string }[])
            .map((column) => `"${column.name}"`)
            .join(', ');
          old.exec(
            `INSERT INTO main."${table}" (${columns}) SELECT ${columns} FROM today."${table}"`,
          );
        }
        // AUTOINCREMENT counters as they were.
        old.exec('DELETE FROM main.sqlite_sequence');
        old.exec(
          "INSERT INTO main.sqlite_sequence SELECT * FROM today.sqlite_sequence WHERE name <> 'users'",
        );
      })();
      old.exec('DETACH DATABASE today');
      expect(old.pragma('foreign_key_check')).toEqual([]);
    } finally {
      old.close();
    }
    return file;
  }

  it(
    'keeps every row, gives everything to user 1, and a rebuild changes nothing',
    { timeout: 60_000 },
    async () => {
      const today = await seededToday();
      const file = asVersion0019(today);
      const before = new BetterSqlite3(file, { readonly: true });
      const sequencesBefore = before.prepare('SELECT * FROM sqlite_sequence ORDER BY name').all();
      before.close();

      // The migration alone keeps the AUTOINCREMENT counters of the tables
      // it rebuilds, so no key or account ID is ever handed out twice.
      const migratedOnly = join(dir, 'migrated-only.db');
      copyFileSync(file, migratedOnly);
      openDatabase(migratedOnly).close();
      const counters = new BetterSqlite3(migratedOnly, { readonly: true });
      expect(counters.prepare('SELECT * FROM sqlite_sequence ORDER BY name').all()).toEqual(
        [...(sequencesBefore as { name: string; seq: number }[]), { name: 'users', seq: 1 }].sort(
          (x, y) => x.name.localeCompare(y.name),
        ),
      );
      counters.close();

      const report = checkMigration(file, { now: () => NOW });

      // Every table that existed: same rows, same content (without the new columns).
      expect(report.tables.filter((row) => !row.ok)).toEqual([]);
      expect(report.ownership.filter((check) => !check.ok)).toEqual([]);
      expect(report.rebuild.filter((check) => !check.ok)).toEqual([]);
      expect(report.ok).toBe(true);
      // The data is really there (the check isn't comparing empty tables).
      const rows = Object.fromEntries(report.tables.map((row) => [row.table, row.after?.rows]));
      for (const table of [
        'events',
        'accounts',
        'account_ids',
        'api_keys',
        'sessions',
        'xp_snapshots',
        'loot_events',
        'raid_special_loot',
        'external_snapshots',
        'clog_items',
        'raid_split_defaults',
        'raid_drop_choices',
        'raid_manual_drops',
      ]) {
        expect(rows[table], table).toBeGreaterThan(0);
      }
      expect(rows.users).toBe(1);

      // The tables a rebuild never writes are exactly what today's code
      // stores, new columns included: the migration fills them the same way.
      // (Derived tables are compared above, through the projections' snapshots:
      // a rebuild renumbers their surrogate IDs and re-stamps `processed_at`.)
      const migrated = new BetterSqlite3(file, { readonly: true });
      const original = new BetterSqlite3(today, { readonly: true });
      try {
        const kept = [
          'account_ids',
          'api_keys',
          'raid_split_defaults',
          'raid_drop_choices',
          'raid_manual_drops',
          'external_snapshots',
          'account_clog_sources',
        ];
        const state = (sqlite: BetterSqlite3.Database) => ({
          ...Object.fromEntries(kept.map((table) => [table, tableState(sqlite, table)])),
          events: tableState(sqlite, 'events', ['processed_at']),
        });
        expect(state(migrated)).toEqual(state(original));
      } finally {
        migrated.close();
        original.close();
      }
    },
  );
});
