import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApiKey, ownKey } from '../auth/api-keys.js';
import { migrationsBefore, tempDir } from '../backup/testing.js';
import { storeEvents } from '../ingest/store.js';
import { PROJECTIONS, projectEvents } from '../projections/index.js';
import { eventFactory, sessionIdOf, TEST_NOW } from '../projections/testing.js';
import { FIRST_USER_ID } from '../users/users.js';
import { checkMigration } from './migration-check.js';
import { MIGRATIONS_TABLE, openDatabase } from './index.js';

// Migration 0027 adds `projection_versions` and `session_afk_estimates`, and
// the sessions projection's rules change (AFK estimated from idle
// heartbeats). A database from before it is recomputed at startup in the
// same transaction, so check-migration passes with no manual step: the
// recomputed tables may differ, and a rebuild gives exactly the same rows.

describe('migration 0027 (AFK estimate, projection versions)', () => {
  let dir: string;
  let remove: () => void;

  beforeEach(() => {
    ({ dir, remove } = tempDir());
  });
  afterEach(() => {
    remove();
  });

  /** A database as the previous version left it: no new tables, AFK only from `session.afk`. */
  function oldDatabase(file: string): void {
    // Up to 0027 only: the newest migration row deleted below is then 0027's.
    const database = openDatabase(file, {
      migrationsFolder: migrationsBefore(dir, '0028_price_hours'),
    });
    const f = eventFactory();
    const idle = { payload: { idle: true } };
    const events = [
      f.sessionStart('19:00'),
      f.heartbeat('19:01'),
      f.heartbeat('19:02', idle),
      f.heartbeat('19:03', idle),
      f.heartbeat('19:04', idle),
      f.heartbeat('19:05', idle),
      f.sessionEnd('19:06'),
    ];
    const apiKeyId = createApiKey(database.db, ownKey(FIRST_USER_ID), 'Test', TEST_NOW).id;
    const { storedIds } = storeEvents(
      database.db,
      events.map((event, index) => ({ index, event, raw: { ...event } })),
      { userId: FIRST_USER_ID, apiKeyId, receivedAt: TEST_NOW.toISOString() },
    );
    const { failed } = projectEvents(database.db, storedIds, {
      projections: PROJECTIONS,
      now: () => TEST_NOW,
    });
    expect(failed).toEqual([]);
    // Back to the old rules and schema: no estimate, so no AFK.
    database.sqlite.exec(`
      UPDATE sessions SET afk_seconds = 0, active_seconds = duration_seconds;
      DROP TABLE session_afk_estimates;
      DROP TABLE projection_versions;
      DELETE FROM "${MIGRATIONS_TABLE}"
        WHERE created_at = (SELECT max(created_at) FROM "${MIGRATIONS_TABLE}");
    `);
    database.close();
  }

  it('recomputes the sessions and passes check-migration', () => {
    const file = join(dir, 'old.db');
    oldDatabase(file);

    const report = checkMigration(file, { now: () => TEST_NOW });
    expect(report.tables.filter((row) => !row.ok)).toEqual([]);
    expect(report.rebuild.filter((check) => !check.ok)).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.tables.find((row) => row.table === 'sessions')).toMatchObject({
      recomputed: true,
    });
    // Changed: the AFK estimate is in it now.
    const sessions = report.tables.find((row) => row.table === 'sessions');
    expect(sessions?.before).not.toEqual(sessions?.after);
    expect(report.tables.find((row) => row.table === 'session_afk_estimates')).toMatchObject({
      before: undefined,
      after: { rows: 1 },
      recomputed: true,
    });
    // Raw data is compared as always.
    const events = report.tables.find((row) => row.table === 'events');
    expect(events?.ok).toBe(true);
    expect(events?.recomputed).toBeUndefined();

    const migrated = openDatabase(file);
    try {
      expect(
        migrated.sqlite.prepare('SELECT id, afk_seconds, active_seconds FROM sessions').all(),
      ).toEqual([{ id: sessionIdOf(1), afk_seconds: 180, active_seconds: 180 }]);
      expect(
        migrated.sqlite
          .prepare('SELECT name, version FROM projection_versions WHERE name = ?')
          .get('sessions'),
      ).toEqual({ name: 'sessions', version: 2 });
    } finally {
      migrated.close();
    }
  });
});
