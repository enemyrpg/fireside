import { describe, expect, it } from 'vitest';
import { events, lootEvents } from '../db/schema.js';
import {
  eventFactory,
  expectOrderIndependent,
  runIncremental,
  TEST_ACCOUNT_HASH,
  validFixtureFiles,
} from './testing.js';
import { FIRST_USER_ID } from '../users/users.js';

const SESSION = '01933c40-8a2b-7c3d-9e4f-000000000001';

function at(time: string): string {
  return `2026-11-08T${time}:00.000Z`;
}

interface LootSnapshot {
  lootEvents: Record<string, unknown>[];
  lootItems: Record<string, unknown>[];
}

describe('loot projection', () => {
  it('stores every valid loot fixture, in any order', () => {
    const f = eventFactory();
    const files = validFixtureFiles('loot');
    expect(files).toContain('loot-player.json');
    const events = files.map((file, i) => f.fromFixture(file, `19:${String(i).padStart(2, '0')}`));
    const loot = expectOrderIndependent(events).loot as LootSnapshot;
    expect(loot.lootEvents).toHaveLength(files.length);
  });

  it('stores loot-npc.json with items and totals of price × quantity', () => {
    const f = eventFactory();
    const event = f.fromFixture('loot-npc.json', '19:00');
    const loot = expectOrderIndependent([event]).loot as LootSnapshot;

    expect(loot.lootEvents).toEqual([
      {
        userId: FIRST_USER_ID,
        accountHash: TEST_ACCOUNT_HASH,
        eventId: event.eventId,
        sessionId: SESSION,
        occurredAt: at('19:00'),
        sourceType: 'NPC',
        sourceName: 'Vorkath',
        sourceNpcId: 8061,
        killCount: 412,
        // 2 850 000 × 1 + 2 100 × 2, and 60 000 × 1 + 0 × 2.
        totalGeValue: 2_854_200,
        totalHaValue: 60_000,
      },
    ]);
    expect(loot.lootItems).toEqual([
      {
        eventId: event.eventId,
        position: 0,
        itemId: 11286,
        itemName: 'Draconic visage',
        quantity: 1,
        gePriceEach: 2_850_000,
        haPriceEach: 60_000,
      },
      {
        eventId: event.eventId,
        position: 1,
        itemId: 536,
        itemName: 'Dragon bones',
        quantity: 2,
        gePriceEach: 2100,
        haPriceEach: 0,
      },
    ]);
  });

  it('stores PLAYER loot without a source name', () => {
    const f = eventFactory();
    const loot = expectOrderIndependent([f.fromFixture('loot-player.json', '19:00')])
      .loot as LootSnapshot;
    expect(loot.lootEvents).toEqual([
      expect.objectContaining({
        sourceType: 'PLAYER',
        sourceName: null,
        sourceNpcId: null,
        killCount: null,
        totalGeValue: 1500,
        totalHaValue: 0,
      }),
    ]);
  });

  it('gives a KC observation for named loot with killCount, normalized by alias', () => {
    const f = eventFactory();
    const withKc = f.fromFixture('loot-npc.json', '19:00', {
      payload: { source: { type: 'NPC', name: 'Dusk' } },
    });
    const withoutKc = f.fromFixture('loot-npc-minimal.json', '19:01');
    const snapshot = expectOrderIndependent([withKc, withoutKc]);

    expect(snapshot.kc).toEqual([
      {
        userId: FIRST_USER_ID,
        accountHash: TEST_ACCOUNT_HASH,
        eventId: withKc.eventId,
        sessionId: SESSION,
        observedAt: at('19:00'),
        boss: 'Grotesque Guardians',
        killCount: 412,
        timeSeconds: null,
        personalBest: false,
        personalBestSeconds: null,
        teamSize: null,
      },
    ]);
    // The loot row keeps the source name as sent.
    expect((snapshot.loot as LootSnapshot).lootEvents[0]).toMatchObject({ sourceName: 'Dusk' });
  });

  it('gives no KC observation for PLAYER loot with killCount', () => {
    const f = eventFactory();
    const snapshot = expectOrderIndependent([
      f.fromFixture('loot-player.json', '19:00', { payload: { killCount: 7 } }),
    ]);
    expect(snapshot.kc).toEqual([]);
    expect((snapshot.loot as LootSnapshot).lootEvents[0]).toMatchObject({
      sourceName: null,
      killCount: 7,
    });
  });

  it('fails the event instead of storing a rounded total that is too large', () => {
    const f = eventFactory();
    const huge = f.fromFixture('loot-npc-minimal.json', '19:00', {
      payload: {
        items: [
          { itemId: 1, name: 'Huge', quantity: 10_000_000, gePrice: 2_000_000_000, haPrice: 0 },
        ],
      },
    });
    const normal = f.fromFixture('loot-npc-minimal.json', '19:01');
    const run = runIncremental([huge, normal]);

    expect(run.failed).toEqual([
      { eventId: huge.eventId, error: 'loot: loot value too large to store exactly' },
    ]);
    const db = run.database.db;
    expect(db.select({ eventId: lootEvents.eventId }).from(lootEvents).all()).toEqual([
      { eventId: normal.eventId },
    ]);
    // The raw event is kept.
    expect(db.select({ eventId: events.eventId }).from(events).all()).toHaveLength(2);
  });
});
