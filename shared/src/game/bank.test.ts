import { describe, expect, it } from 'vitest';
import { MAX_INGEST_BYTES } from '../schemas/api/ingest.js';
import { eventSchema } from '../schemas/events.js';
import {
  BANK_FILLER_ITEM_ID,
  bankTabDisplayOrder,
  cashValue,
  compareBankTabs,
  isBankFiller,
  itemValue,
  MAX_BANK_ITEMS,
  MAX_EQUIPMENT_ITEMS,
  MAX_INVENTORY_ITEMS,
  MAX_VALUE,
  potionValue,
  tabsOf,
} from './bank.js';

describe('tabsOf', () => {
  it('fills tabs 1–9 in order, the rest is the main tab', () => {
    expect(tabsOf([2, 0, 1, 0, 0, 0, 0, 0, 0], 5)).toEqual([1, 1, 3, 0, 0]);
  });

  it('gives only the main tab without tab sizes', () => {
    expect(tabsOf([0, 0, 0, 0, 0, 0, 0, 0, 0], 2)).toEqual([0, 0]);
  });

  it('handles an empty bank', () => {
    expect(tabsOf([0, 0, 0, 0, 0, 0, 0, 0, 0], 0)).toEqual([]);
  });

  it('never gives more tabs than items', () => {
    expect(tabsOf([3, 0, 0, 0, 0, 0, 0, 0, 0], 2)).toEqual([1, 1]);
  });
});

describe('compareBankTabs', () => {
  it('sorts tabs 1–9 before the main tab', () => {
    expect([0, 3, 1, 9].sort(compareBankTabs)).toEqual([1, 3, 9, 0]);
  });
});

describe('bankTabDisplayOrder', () => {
  it('puts the main tab first, then tabs 1–9, as the game shows them', () => {
    const container = [{ tab: 1 }, { tab: 3 }, { tab: 9 }, { tab: 0 }];
    expect(bankTabDisplayOrder(container).map((tab) => tab.tab)).toEqual([0, 1, 3, 9]);
    // The input keeps container order.
    expect(container.map((tab) => tab.tab)).toEqual([1, 3, 9, 0]);
  });

  it('handles a bank with only the main tab', () => {
    expect(bankTabDisplayOrder([{ tab: 0 }])).toEqual([{ tab: 0 }]);
  });
});

describe('isBankFiller', () => {
  it('is true only for the bank filler item', () => {
    expect(isBankFiller(BANK_FILLER_ITEM_ID)).toBe(true);
    expect(isBankFiller(20594)).toBe(true);
    expect(isBankFiller(995)).toBe(false);
  });
});

describe('cashValue', () => {
  it('counts coins and platinum tokens × 1 000', () => {
    const items = [
      { itemId: 995, quantity: 12_500 },
      { itemId: 13204, quantity: 3 },
      { itemId: 4151, quantity: 1 },
      { itemId: 995, quantity: 500 },
    ];
    expect(cashValue(items)).toBe(16_000);
  });

  it('is 0 without cash', () => {
    expect(cashValue([])).toBe(0);
  });

  it('is capped', () => {
    const max = 2 ** 31 - 1;
    const items = Array.from({ length: 5000 }, () => ({ itemId: 13204, quantity: max }));
    expect(cashValue(items)).toBe(MAX_VALUE);
  });
});

describe('potionValue', () => {
  it('is the 4-dose price ÷ 4 × doses, rounded down at the end', () => {
    // Per-dose rounding first would give 775 × 7 = 5 425.
    expect(potionValue(3_101, 7, 4)).toBe(5_426);
    expect(potionValue(12_400, 312, 4)).toBe(967_200);
  });

  it('uses the doses of the full item', () => {
    expect(potionValue(900, 5, 3)).toBe(1_500);
  });

  it('is capped', () => {
    expect(potionValue(2 ** 31 - 1, 2 ** 31 - 1, 1)).toBe(MAX_VALUE);
  });
});

describe('itemValue', () => {
  it('is capped at 2^53 − 1', () => {
    expect(itemValue(2 ** 31 - 1, 2 ** 31 - 1)).toBe(MAX_VALUE);
    expect(itemValue(3, 7)).toBe(21);
  });
});

describe('bank.snapshot size', () => {
  const max = 2 ** 31 - 1;
  const name = (i: number) => `Item name of fifty characters ${String(i).padStart(20, '#')}`;
  const priced = (i: number) => ({
    itemId: 30_000 + i,
    name: name(i),
    quantity: max,
    gePrice: max,
    haPrice: max,
  });

  function event(itemCount: number) {
    return {
      eventId: '01933c4e-8a2b-7c3d-9e4f-0a1b2c3d4e5f',
      schemaVersion: 1,
      type: 'bank.snapshot',
      accountHash: '-1234567890123456789',
      occurredAt: '2026-11-08T19:42:13.512Z',
      sessionId: '01933c40-1111-7aaa-bbbb-ccccdddd0001',
      payload: {
        tabSizes: [200, 200, 200, 200, 200, 200, 200, 200, 200],
        items: Array.from({ length: itemCount }, (_, i) => ({ ...priced(i), placeholder: false })),
        inventory: Array.from({ length: MAX_INVENTORY_ITEMS }, (_, i) => priced(i)),
        equipment: Array.from({ length: MAX_EQUIPMENT_ITEMS }, (_, i) => ({
          slot: `SLOT_${String(i)}`,
          ...priced(i),
        })),
        contentHash: `sha256:${'f'.repeat(64)}`,
      },
    };
  }

  const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));

  it('fits in one ingest batch at the worst case (cap, 10-digit numbers, 50-char names)', () => {
    const worst = event(MAX_BANK_ITEMS);
    expect(eventSchema.safeParse(worst).success).toBe(true);
    const size = bytes({ events: [worst] });
    // ~0.33 MB: one event fits, a batch holds three such banks.
    expect(size).toBeLessThan(MAX_INGEST_BYTES / 3);
    // A full bank in today's game (1 410 slots) at the worst case.
    expect(bytes(event(1410))).toBeLessThan(250_000);
  });
});
