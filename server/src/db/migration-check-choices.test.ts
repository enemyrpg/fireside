import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApiKey, ownKey } from '../auth/api-keys.js';
import { tempDir } from '../backup/testing.js';
import { storeEvents } from '../ingest/store.js';
import { PROJECTIONS, projectEvents } from '../projections/index.js';
import { eventFactory, TEST_NOW } from '../projections/testing.js';
import { recordCurrentVersions } from '../projections/versions.js';
import { FIRST_USER_ID } from '../users/users.js';
import { openDatabase } from './index.js';
import { checkMigration } from './migration-check.js';

// check-migration on the upgrade to nearest-chest matching (raid-special-loot
// version 2): the split choices it merges and the ones of drops that are gone
// are expected, so the check passes, and their text is never in the report.

const FANG = { itemId: 26219, name: "Osmumten's fang", quantity: 1, gePrice: 24_000_000 };
const TOA = { type: 'EVENT', name: 'Tombs of Amascut' } as const;
const coins = { itemId: 995, name: 'Coins', quantity: 50_000, gePrice: 1, haPrice: 1 };

describe('check-migration and raid split choices', () => {
  let dir: string;
  let remove: () => void;
  beforeEach(() => {
    ({ dir, remove } = tempDir());
  });
  afterEach(() => {
    remove();
  });

  it('expects merged and removed choices from the nearest-chest upgrade', () => {
    const file = join(dir, 'old.db');
    const database = openDatabase(file);
    const f = eventFactory();
    const first = f.loot('19:00', { source: TOA, items: [coins, { ...FANG, haPrice: 0 }] });
    const second = f.loot('19:40', { source: TOA, items: [{ ...FANG, haPrice: 0 }] });
    const special = f.raidSpecialLoot('19:40', { item: FANG, teamSize: 3 });
    const events = [f.sessionStart('18:00'), first, second, special];
    const apiKeyId = createApiKey(database.db, ownKey(FIRST_USER_ID), 'Test', TEST_NOW).id;
    const { storedIds } = storeEvents(
      database.db,
      events.map((event, index) => ({ index, event, raw: { ...event } })),
      { userId: FIRST_USER_ID, apiKeyId, receivedAt: TEST_NOW.toISOString() },
    );
    expect(
      projectEvents(database.db, storedIds, { projections: PROJECTIONS, now: () => TEST_NOW })
        .failed,
    ).toEqual([]);
    recordCurrentVersions(database.db, PROJECTIONS, () => TEST_NOW);
    // As version 1 left it: the event matched with the oldest chest. Its drop
    // has choices under both keys that conflict in the note, and one choice is
    // on the coins of the first chest (a drop that is gone).
    database.sqlite.exec(`
      UPDATE raid_special_loot SET loot_event_id = NULL WHERE special_event_id = '${special.eventId}';
      UPDATE raid_special_loot SET loot_event_id = '${second.eventId}', loot_item_position = 0,
          occurred_at = '${second.occurredAt}'
        WHERE special_event_id IS NULL;
      UPDATE raid_special_loot SET loot_event_id = '${first.eventId}', loot_item_position = 1
        WHERE special_event_id = '${special.eventId}';
      UPDATE projection_versions SET version = 1 WHERE name = 'raid-special-loot';
      INSERT INTO raid_drop_choices (event_id, item_index, note, own_value, updated_at) VALUES
        ('${special.eventId}', 0, 'Zq8 older', 7, '2026-11-09T10:00:00.000Z'),
        ('${first.eventId}', 1, 'Zq8 newer', NULL, '2026-11-09T11:00:00.000Z'),
        ('${first.eventId}', 0, 'Zq8 gone', NULL, '2026-11-09T11:00:00.000Z');
    `);
    database.close();

    const report = checkMigration(file, { now: () => TEST_NOW });
    expect(report.ownership.filter((check) => !check.ok)).toEqual([]);
    expect(report.ownership.map((check) => check.name)).toContain(
      'raid_drop_choices: only moved or removed as the upgrade should',
    );
    expect(report.ok).toBe(true);
    expect(JSON.stringify(report)).not.toContain('Zq8');

    const after = openDatabase(file);
    try {
      expect(
        after.sqlite
          .prepare('SELECT event_id, item_index, note, own_value FROM raid_drop_choices')
          .all(),
      ).toEqual([{ event_id: special.eventId, item_index: 0, note: 'Zq8 newer', own_value: 7 }]);
    } finally {
      after.close();
    }
  });
});
