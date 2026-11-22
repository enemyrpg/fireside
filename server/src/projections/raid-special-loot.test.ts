import type { LootItem } from '@fireside/shared';
import { describe, expect, it } from 'vitest';
import {
  eventFactory,
  expectOrderIndependent,
  sessionIdOf,
  TEST_ACCOUNT_HASH,
  validFixtureFiles,
} from './testing.js';
import { FIRST_USER_ID } from '../users/users.js';

type SpecialLootRow = Record<string, unknown>;

const FANG = { itemId: 26219, name: "Osmumten's fang", quantity: 1, gePrice: 24_500_000 };
const fangItem: LootItem = { ...FANG, haPrice: 0 };
const coins: LootItem = { itemId: 995, name: 'Coins', quantity: 50_000, gePrice: 1, haPrice: 0 };
const TOA = { type: 'EVENT', name: 'Tombs of Amascut' } as const;

/** The special loot rows, checked to be the same in any order and after a rebuild. */
function specialLoot(...events: Parameters<typeof expectOrderIndependent>[0]): SpecialLootRow[] {
  return expectOrderIndependent(events)['raid-special-loot'] as SpecialLootRow[];
}

describe('raid special loot projection', () => {
  it('counts an own purple once: SELF event and chest loot are one drop', () => {
    const f = eventFactory();
    const loot = f.loot('19:00', { source: TOA, items: [coins, fangItem], killCount: 140 });
    const special = f.raidSpecialLoot('19:00', {
      raid: 'Tombs of Amascut Expert Mode',
      teamSize: 3,
      killCount: 140,
    });
    expect(specialLoot(loot, special)).toEqual([
      {
        userId: FIRST_USER_ID,
        accountHash: TEST_ACCOUNT_HASH,
        sessionId: sessionIdOf(1),
        occurredAt: special.occurredAt,
        raid: 'Tombs of Amascut: Expert Mode',
        raidGroup: 'Tombs of Amascut',
        itemId: 26219,
        itemName: "Osmumten's fang",
        quantity: 1,
        gePriceEach: 24_500_000,
        recipient: 'SELF',
        teamSize: 3,
        killCount: 140,
        specialEventId: special.eventId,
        lootEventId: loot.eventId,
        lootItemPosition: 1,
      },
    ]);
  });

  it('leaves loot totals alone: the purple is in normal loot once', () => {
    const f = eventFactory();
    const loot = f.loot('19:00', { source: TOA, items: [coins, fangItem] });
    const snapshot = expectOrderIndependent([loot, f.raidSpecialLoot('19:00')]);
    const { lootEvents } = snapshot.loot as { lootEvents: { totalGeValue: number }[] };
    expect(lootEvents.map((event) => event.totalGeValue)).toEqual([50_000 + 24_500_000]);
    // The SELF event adds no loot of its own.
    expect(snapshot['raid-special-loot']).toHaveLength(1);
  });

  it('keeps a loot purple without a special loot event as SELF', () => {
    const f = eventFactory();
    const loot = f.loot('19:00', { source: TOA, items: [fangItem], killCount: 12 });
    expect(specialLoot(loot)).toEqual([
      expect.objectContaining({
        raid: 'Tombs of Amascut',
        recipient: 'SELF',
        teamSize: null,
        killCount: 12,
        specialEventId: null,
        lootEventId: loot.eventId,
        lootItemPosition: 0,
      }),
    ]);
  });

  it('keeps a SELF event without loot', () => {
    const f = eventFactory();
    const special = f.raidSpecialLoot('19:00');
    expect(specialLoot(special)).toEqual([
      expect.objectContaining({ specialEventId: special.eventId, lootEventId: null }),
    ]);
  });

  it('never matches a teammate drop to own loot', () => {
    const f = eventFactory();
    const loot = f.loot('19:00', { source: TOA, items: [fangItem] });
    const teammate = f.raidSpecialLoot('19:00', { recipient: 'TEAMMATE' });
    const rows = specialLoot(loot, teammate);
    expect(rows).toHaveLength(2);
    expect(rows).toContainEqual(
      expect.objectContaining({
        recipient: 'TEAMMATE',
        specialEventId: teammate.eventId,
        lootEventId: null,
      }),
    );
    expect(rows).toContainEqual(
      expect.objectContaining({
        recipient: 'SELF',
        specialEventId: null,
        lootEventId: loot.eventId,
      }),
    );
  });

  it('matches two identical purples in a session one to one, oldest first', () => {
    const f = eventFactory();
    const first = f.loot('19:00', { source: TOA, items: [fangItem] });
    const second = f.loot('19:40', { source: TOA, items: [fangItem] });
    const a = f.raidSpecialLoot('19:00');
    const b = f.raidSpecialLoot('19:40');
    const rows = specialLoot(first, second, a, b);
    expect(rows.map((row) => [row.specialEventId, row.lootEventId])).toEqual([
      [a.eventId, first.eventId],
      [b.eventId, second.eventId],
    ]);
  });

  it('does not merge across sessions, raids or items', () => {
    const f = eventFactory();
    const events = [
      f.loot('19:00', { source: TOA, items: [fangItem] }),
      // Another session.
      f.raidSpecialLoot('19:00', { sessionId: sessionIdOf(2) }),
      // Another raid: the fang is not a CoX purple.
      f.raidSpecialLoot('19:01', { raid: 'Chambers of Xeric' }),
      // Another item.
      f.raidSpecialLoot('19:02', {
        item: { itemId: 25975, name: 'Lightbearer', quantity: 1, gePrice: 3_000_000 },
      }),
    ];
    const rows = specialLoot(...events);
    expect(rows).toHaveLength(4);
    expect(rows.filter((row) => row.lootEventId !== null && row.specialEventId !== null)).toEqual(
      [],
    );
  });

  it('ignores non-raid loot and normal raid items', () => {
    const f = eventFactory();
    expect(
      specialLoot(
        // A fang from a non-raid source is not a purple.
        f.loot('19:00', { source: { type: 'NPC', name: 'Vorkath' }, items: [fangItem] }),
        f.loot('19:10', { source: TOA, items: [coins] }),
        f.loot('19:20', { source: { type: 'PLAYER', name: null }, items: [fangItem] }),
      ),
    ).toEqual([]);
  });

  it('matches a mode to raid loot named after the raid (CoX: Challenge Mode)', () => {
    const f = eventFactory();
    const hat = { itemId: 21018, name: 'Ancestral hat', quantity: 1, gePrice: 9_800_000 };
    const loot = f.loot('19:00', {
      source: { type: 'EVENT', name: 'Chambers of Xeric' },
      items: [{ ...hat, haPrice: 0 }],
    });
    const special = f.raidSpecialLoot('19:00', {
      raid: 'Chambers of Xeric: Challenge Mode',
      item: hat,
    });
    expect(specialLoot(loot, special)).toEqual([
      expect.objectContaining({
        raid: 'Chambers of Xeric: Challenge Mode',
        raidGroup: 'Chambers of Xeric',
        specialEventId: special.eventId,
        lootEventId: loot.eventId,
      }),
    ]);
  });

  it('stores an unknown raid by name', () => {
    const f = eventFactory();
    expect(specialLoot(f.raidSpecialLoot('19:00', { raid: '  Some New  Raid ' }))).toEqual([
      expect.objectContaining({ raid: 'Some New Raid', raidGroup: 'Some New Raid' }),
    ]);
  });

  it('stores every valid raid.special_loot fixture', () => {
    const f = eventFactory();
    const files = validFixtureFiles('raid.special_loot');
    expect(files).toContain('raid-special-loot-teammate-minimal.json');
    const events = files.map((file, i) => f.fromFixture(file, `19:0${String(i)}`));
    expect(specialLoot(...events)).toHaveLength(files.length);
  });

  it('gives the same rows in any order in a mixed session', () => {
    const f = eventFactory();
    const s2 = { sessionId: sessionIdOf(2) };
    expectOrderIndependent(
      [
        f.sessionStart('18:00'),
        f.loot('19:00', { source: TOA, items: [coins, fangItem], killCount: 1 }),
        f.raidSpecialLoot('19:00', { teamSize: 2 }),
        f.raidSpecialLoot('19:00', { recipient: 'TEAMMATE', teamSize: 2 }),
        f.kc('19:00', { boss: 'Tombs of Amascut', killCount: 1, timeSeconds: 1800, teamSize: 2 }),
        f.loot('19:30', { source: TOA, items: [fangItem], killCount: 2 }),
        f.raidSpecialLoot('19:30'),
        f.raidSpecialLoot('19:30', s2),
        f.loot('19:31', { source: TOA, items: [fangItem], ...s2 }),
      ],
      { shuffles: 40, seed: 7 },
    );
  });
});
