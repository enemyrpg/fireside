import { describe, expect, it } from 'vitest';
import { eventFactory, expectOrderIndependent } from './testing.js';

type Row = Record<string, unknown>;

interface BankTables {
  snapshots: Row[];
  items: Row[];
  containers: Row[];
}

interface PotionTables {
  snapshots: Row[];
  potions: Row[];
}

/** Bank tables, checked to be the same in any order, with failures and after a rebuild. */
function bank(...events: Parameters<typeof expectOrderIndependent>[0]): BankTables {
  return expectOrderIndependent(events).bank as BankTables;
}

function potions(...events: Parameters<typeof expectOrderIndependent>[0]): PotionTables {
  return expectOrderIndependent(events)['potion-storage'] as PotionTables;
}

const OTHER_ACCOUNT = '-42';

describe('bank projection', () => {
  it('stores bank-snapshot.json with tabs, totals and cash', () => {
    const f = eventFactory();
    const event = f.fromFixture('bank-snapshot.json', '19:00');
    const { snapshots, items, containers } = bank(event);
    expect(snapshots).toEqual([
      expect.objectContaining({
        eventId: event.eventId,
        takenAt: '2026-11-08T19:00:00.000Z',
        tabSizes: '[3,2,0,0,0,0,0,0,0]',
        // 9.8M + 14.5M + 0 (placeholder) + 48 × 9 200 + 320 × 780 + 12.5M + 4.2M + 10
        totalGe: 41_691_210,
        totalHa: 750_000 + 159_000 + 48 * 456 + 320 * 90 + 12_500_000 + 4_200_000 + 1,
        inventoryGe: 125_000 + 12 * 9_200,
        inventoryHa: 125_000 + 12 * 456,
        equipmentGe: 1_500_000 + 450 * 110,
        equipmentHa: 72_000 + 450 * 240,
        // Coins in bank and inventory + 4 200 platinum tokens.
        cash: 12_500_000 + 125_000 + 4_200_000,
      }),
    ]);
    expect(items.map((row) => [row.position, row.tab, row.itemId, row.placeholder])).toEqual([
      [0, 1, 11802, false],
      [1, 1, 11832, false],
      [2, 1, 20997, true],
      [3, 2, 2434, false],
      [4, 2, 385, false],
      [5, 0, 995, false],
      [6, 0, 13204, false],
      [7, 0, 1755, false],
    ]);
    expect(containers.map((row) => [row.container, row.position, row.slot, row.itemId])).toEqual([
      ['EQUIPMENT', 0, 'WEAPON', 4151],
      ['EQUIPMENT', 1, 'AMMO', 892],
      ['INVENTORY', 0, null, 995],
      ['INVENTORY', 1, null, 2435],
    ]);
  });

  it('keeps totals of every snapshot but items of the latest only', () => {
    const f = eventFactory();
    const older = f.fromFixture('bank-snapshot.json', '18:00');
    const newer = f.bankSnapshot('19:00');
    const { snapshots, items, containers } = bank(older, newer);
    expect(snapshots.map((row) => row.eventId)).toEqual([older.eventId, newer.eventId]);
    expect(items).toEqual([
      expect.objectContaining({ eventId: newer.eventId, itemId: 995, quantity: 1000 }),
    ]);
    expect(containers).toEqual([]);
  });

  it('keeps the latest items per account', () => {
    const f = eventFactory();
    const a = f.bankSnapshot('19:00');
    const b = f.bankSnapshot('18:00', { accountHash: OTHER_ACCOUNT });
    const aOld = f.fromFixture('bank-snapshot.json', '17:00');
    const { items } = bank(a, b, aOld);
    expect(items.map((row) => row.eventId).sort()).toEqual([a.eventId, b.eventId].sort());
  });

  it('breaks equal times by event ID', () => {
    const f = eventFactory();
    const first = f.fromFixture('bank-snapshot.json', '19:00');
    const second = f.bankSnapshot('19:00');
    const { items } = bank(first, second);
    expect(new Set(items.map((row) => row.eventId))).toEqual(new Set([second.eventId]));
  });

  it('stores an empty bank', () => {
    const f = eventFactory();
    const { snapshots, items } = bank(f.fromFixture('bank-snapshot-empty.json', '19:00'));
    expect(snapshots).toEqual([
      expect.objectContaining({ totalGe: 0, totalHa: 0, cash: 0, inventoryGe: 0, equipmentGe: 0 }),
    ]);
    expect(items).toEqual([]);
  });

  it('values a bank of placeholders at 0 and keeps the placeholders', () => {
    const f = eventFactory();
    const { snapshots, items } = bank(
      f.fromFixture('bank-snapshot-only-placeholders.json', '19:00'),
    );
    expect(snapshots).toEqual([expect.objectContaining({ totalGe: 0, totalHa: 0, cash: 0 })]);
    expect(items.map((row) => [row.tab, row.itemId, row.quantity, row.placeholder])).toEqual([
      [1, 20997, 0, true],
      [0, 4151, 0, true],
    ]);
  });

  it('stores unknown items and slots by name', () => {
    const f = eventFactory();
    const { items, containers } = bank(f.fromFixture('bank-snapshot-unknown-item.json', '19:00'));
    expect(items).toEqual([
      expect.objectContaining({ itemId: 99999, name: "Some item from next week's update" }),
    ]);
    expect(containers).toEqual([expect.objectContaining({ slot: 'NEW_SLOT', itemId: 99998 })]);
  });

  it('caps values at 2^53 − 1', () => {
    const f = eventFactory();
    const max = 2 ** 31 - 1;
    const huge = { quantity: max, placeholder: false as const, gePrice: max, haPrice: max };
    const event = f.bankSnapshot('19:00', {
      payload: {
        items: [
          { itemId: 1, name: 'A', ...huge },
          { itemId: 13204, name: 'Platinum token', ...huge },
        ],
      },
    });
    expect(bank(event).snapshots).toEqual([
      expect.objectContaining({ totalGe: Number.MAX_SAFE_INTEGER, cash: max * 1000 }),
    ]);
  });

  it('stores a full bank in chunks', () => {
    const f = eventFactory();
    const items = Array.from({ length: 1410 }, (_, i) => ({
      itemId: i,
      name: `Item ${String(i)}`,
      quantity: 1,
      placeholder: false as const,
      gePrice: 2,
      haPrice: 1,
    }));
    const event = f.bankSnapshot('19:00', {
      payload: { items, tabSizes: [500, 500, 0, 0, 0, 0, 0, 0, 0] },
    });
    const tables = expectOrderIndependent([event], { shuffles: 2 }).bank as BankTables;
    expect(tables.items).toHaveLength(1410);
    expect(tables.snapshots).toEqual([expect.objectContaining({ totalGe: 2820 })]);
    expect(tables.items.filter((row) => row.tab === 0)).toHaveLength(410);
  });
});

describe('potion storage projection', () => {
  it('values doses as ⌊full-item price × doses ÷ itemDoses⌋', () => {
    const f = eventFactory();
    const { snapshots, potions: rows } = potions(
      f.fromFixture('potion-storage-snapshot.json', '19:00'),
    );
    // 12 400 × 312 / 4 = 967 200; 10 101 × 7 / 4 = 17 676.75 → 17 676.
    expect(snapshots).toEqual([
      expect.objectContaining({ totalGe: 967_200 + 17_676, totalHa: Math.floor((180 * 7) / 4) }),
    ]);
    expect(rows.map((row) => [row.position, row.itemId, row.potion, row.doses])).toEqual([
      [0, 12695, 'Super combat potion', 312],
      [1, 3024, 'Super restore', 7],
    ]);
  });

  it('keeps totals of every snapshot but potions of the latest only', () => {
    const f = eventFactory();
    const older = f.fromFixture('potion-storage-snapshot.json', '18:00');
    const newer = f.potionStorage('19:00');
    const late = f.potionStorage('17:00', { payload: { potions: [] } });
    const { snapshots, potions: rows } = potions(newer, older, late);
    expect(snapshots).toHaveLength(3);
    expect(rows).toEqual([expect.objectContaining({ eventId: newer.eventId, doses: 100 })]);
  });

  it('stores an empty potion storage', () => {
    const f = eventFactory();
    const { snapshots, potions: rows } = potions(
      f.fromFixture('potion-storage-snapshot-empty.json', '19:00'),
    );
    expect(snapshots).toEqual([expect.objectContaining({ totalGe: 0, totalHa: 0 })]);
    expect(rows).toEqual([]);
  });
});
