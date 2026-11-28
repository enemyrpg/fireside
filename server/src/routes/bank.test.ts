import {
  bankHistoryResponseSchema,
  bankResponseSchema,
  bankSummaryResponseSchema,
  errorResponseSchema,
  potionStorageResponseSchema,
  priceMoversResponseSchema,
  type BankItem,
  type Event,
} from '@fireside/shared';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { buildApp } from '../app.js';
import { rebuildDerivedTables } from '../admin/rebuild.js';
import { accounts, priceDays, priceHours } from '../db/schema.js';
import { storeHours, type Trades } from '../prices/testing.js';
import { PROJECTIONS } from '../projections/index.js';
import {
  emptyRun,
  eventFactory,
  ingestBatch,
  TEST_ACCOUNT_HASH,
  TEST_NOW,
  type TestRun,
} from '../projections/testing.js';
import { testConfig } from '../test-utils.js';

// Bank, bank history, bank summary and potion storage. Europe/Oslo is UTC+1 in
// winter and UTC+2 in summer. Every response is also checked against its
// contract schema (values add up, order rules).

const TZ = 'Europe/Oslo';
const HASH_B = '2222222222';
const NOW = new Date('2026-11-10T12:00:00.000Z');

let app: FastifyInstance | undefined;
let run: TestRun | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

function start(events: readonly Event[], now = NOW, env: Record<string, string> = {}): void {
  run = emptyRun();
  ingestBatch(run, events, PROJECTIONS, TEST_NOW);
  expect(run.failed).toEqual([]);
  app = buildApp({
    db: run.database,
    config: testConfig({ TZ, ...env }),
    dashboard: { now: () => now },
  });
}

async function get<S extends z.ZodType>(url: string, schema: S): Promise<z.infer<S>> {
  const response = await app!.inject({ method: 'GET', url }); // eslint-disable-line @typescript-eslint/no-non-null-assertion -- set by start()
  expect(response.statusCode, response.body).toBe(200);
  return schema.parse(response.json());
}

async function getError(url: string, status: number) {
  const response = await app!.inject({ method: 'GET', url }); // eslint-disable-line @typescript-eslint/no-non-null-assertion -- set by start()
  expect(response.statusCode, response.body).toBe(status);
  return errorResponseSchema.parse(response.json()).error;
}

function idOf(hash: string): number {
  const row = run?.database.db
    .select({ id: accounts.id })
    .from(accounts)
    .where(eq(accounts.accountHash, hash))
    .get();
  expect(row, hash).toBeDefined();
  return row?.id ?? 0;
}

const api = (account: number | 'all', path: string) =>
  `/api/v1/accounts/${String(account)}/${path}`;

const item = (itemId: number, quantity: number, gePrice: number, haPrice = 0): BankItem =>
  quantity === 0
    ? { itemId, name: `Item ${String(itemId)}`, quantity: 0, placeholder: true, gePrice, haPrice }
    : { itemId, name: `Item ${String(itemId)}`, quantity, placeholder: false, gePrice, haPrice };

const coins = (quantity: number): BankItem => ({ ...item(995, quantity, 1, 1), name: 'Coins' });
const platinum = (quantity: number): BankItem => ({
  ...item(13204, quantity, 1000, 1000),
  name: 'Platinum token',
});

describe('GET …/bank', () => {
  it('gives the latest snapshot with tabs in game order and values per item and tab', async () => {
    const f = eventFactory();
    const older = f.bankSnapshot('18:00', { payload: { items: [coins(5)] } });
    const latest = f.fromFixture('bank-snapshot.json', '19:00');
    start([latest, older]);
    const id = idOf(TEST_ACCOUNT_HASH);
    const body = await get(api(id, 'bank'), bankResponseSchema);
    expect(body.banks).toHaveLength(1);
    const bank = body.banks[0];
    expect(bank?.takenAt).toBe('2026-11-08T19:00:00.000Z');
    expect(bank?.tabs).toEqual([
      { tab: 1, itemCount: 3, geValue: 24_300_000, haValue: 909_000 },
      { tab: 2, itemCount: 2, geValue: 441_600 + 249_600, haValue: 21_888 + 28_800 },
      { tab: 0, itemCount: 3, geValue: 16_700_010, haValue: 16_700_001 },
    ]);
    expect(bank?.items.map((row) => [row.position, row.tab, row.itemId])).toEqual([
      [0, 1, 11802],
      [1, 1, 11832],
      [2, 1, 20997],
      [3, 2, 2434],
      [4, 2, 385],
      [5, 0, 995],
      [6, 0, 13204],
      [7, 0, 1755],
    ]);
    expect(bank?.items[2]).toMatchObject({ placeholder: true, quantity: 0, geValue: 0 });
    expect(bank?.totals).toEqual({
      geValue: 41_691_210,
      haValue: 909_000 + 50_688 + 16_700_001,
      cashValue: 12_500_000 + 125_000 + 4_200_000,
    });
    expect(bank?.equipment.items.map((row) => row.slot)).toEqual(['WEAPON', 'AMMO']);
    expect(bank?.inventory).toMatchObject({ geValue: 125_000 + 110_400 });
    expect(body.totals).toEqual(bank?.totals);
  });

  it('lists each account for all, with summed totals', async () => {
    const f = eventFactory();
    start([
      f.bankSnapshot('19:00', { payload: { items: [coins(100), platinum(2)] } }),
      f.bankSnapshot('19:00', { accountHash: HASH_B, payload: { items: [coins(7)] } }),
    ]);
    const body = await get(api('all', 'bank'), bankResponseSchema);
    expect(body.banks.map((bank) => bank.accountId)).toEqual(
      [idOf(TEST_ACCOUNT_HASH), idOf(HASH_B)].sort((a, b) => a - b),
    );
    expect(body.totals).toEqual({ geValue: 2107, haValue: 2107, cashValue: 2107 });
  });

  it('gives no banks without a snapshot, and 404 for an unknown account', async () => {
    const f = eventFactory();
    start([f.sessionStart('19:00')]);
    const body = await get(api(idOf(TEST_ACCOUNT_HASH), 'bank'), bankResponseSchema);
    expect(body).toEqual({
      banks: [],
      totals: { geValue: 0, haValue: 0, cashValue: 0 },
      prices: { source: 'SNAPSHOT', fetchedAt: null },
    });
    expect((await getError(api(999, 'bank'), 404)).code).toBe('NOT_FOUND');
    expect((await getError(`${api('all', 'bank')}?x=1`, 400)).code).toBe('VALIDATION_ERROR');
  });

  it('gives an empty bank with only the main tab', async () => {
    const f = eventFactory();
    start([f.fromFixture('bank-snapshot-empty.json', '19:00')]);
    const [bank] = (await get(api('all', 'bank'), bankResponseSchema)).banks;
    expect(bank?.tabs).toEqual([{ tab: 0, itemCount: 0, geValue: 0, haValue: 0 }]);
    expect(bank?.items).toEqual([]);
    expect(bank?.totals).toEqual({ geValue: 0, haValue: 0, cashValue: 0 });
  });

  it('lists a bank with only placeholders at value 0', async () => {
    const f = eventFactory();
    start([f.fromFixture('bank-snapshot-only-placeholders.json', '19:00')]);
    const [bank] = (await get(api('all', 'bank'), bankResponseSchema)).banks;
    expect(bank?.items.map((row) => [row.tab, row.itemId, row.placeholder, row.geValue])).toEqual([
      [1, 20997, true, 0],
      [0, 4151, true, 0],
    ]);
    expect(bank?.items[0]?.gePriceEach).toBe(1_450_000_000);
    expect(bank?.totals.geValue).toBe(0);
  });

  it('shows unknown items by name', async () => {
    const f = eventFactory();
    start([f.fromFixture('bank-snapshot-unknown-item.json', '19:00')]);
    const [bank] = (await get(api('all', 'bank'), bankResponseSchema)).banks;
    expect(bank?.items[0]).toMatchObject({
      itemId: 99999,
      name: "Some item from next week's update",
    });
    expect(bank?.equipment.items[0]).toMatchObject({ slot: 'NEW_SLOT', name: 'Some new cape' });
  });
});

describe('GET …/potion-storage', () => {
  it('values doses from the full-item price', async () => {
    const f = eventFactory();
    start([f.fromFixture('potion-storage-snapshot.json', '19:00')]);
    const body = await get(api('all', 'potion-storage'), potionStorageResponseSchema);
    expect(body.storages[0]?.potions).toEqual([
      expect.objectContaining({ itemId: 12695, doses: 312, geValue: 967_200, haValue: 0 }),
      // ⌊10 101 × 7 ÷ 4⌋ = 17 676, ⌊180 × 7 ÷ 4⌋ = 315.
      expect.objectContaining({ itemId: 3024, doses: 7, geValue: 17_676, haValue: 315 }),
    ]);
    expect(body.totals).toEqual({ geValue: 984_876, haValue: 315 });
  });

  it('gives no storages without data', async () => {
    const f = eventFactory();
    start([f.bankSnapshot('19:00')]);
    expect(await get(api('all', 'potion-storage'), potionStorageResponseSchema)).toEqual({
      storages: [],
      totals: { geValue: 0, haValue: 0 },
      prices: { source: 'SNAPSHOT', fetchedAt: null },
    });
  });
});

describe('GET …/bank/summary', () => {
  it('adds bank, potion storage, inventory and equipment; cash from bank and inventory', async () => {
    const f = eventFactory();
    start([
      f.fromFixture('bank-snapshot.json', '19:00'),
      f.fromFixture('potion-storage-snapshot.json', '19:05'),
      f.bankSnapshot('18:00', { accountHash: HASH_B, payload: { items: [coins(1000)] } }),
    ]);
    const one = await get(api(idOf(TEST_ACCOUNT_HASH), 'bank/summary'), bankSummaryResponseSchema);
    expect(one).toEqual({
      bankGeValue: 41_691_210,
      potionStorageGeValue: 984_876,
      inventoryGeValue: 235_400,
      equipmentGeValue: 1_549_500,
      geValue: 41_691_210 + 984_876 + 235_400 + 1_549_500,
      cashValue: 16_825_000,
      updatedAt: '2026-11-08T19:05:00.000Z',
      prices: { source: 'SNAPSHOT', fetchedAt: null },
    });
    const all = await get(api('all', 'bank/summary'), bankSummaryResponseSchema);
    expect(all).toMatchObject({
      bankGeValue: 41_692_210,
      cashValue: 16_826_000,
      updatedAt: '2026-11-08T19:05:00.000Z',
    });
  });

  it('counts coins and platinum tokens in the inventory', async () => {
    const f = eventFactory();
    start([
      f.bankSnapshot('19:00', {
        payload: {
          items: [platinum(3)],
          inventory: [{ itemId: 995, name: 'Coins', quantity: 250, gePrice: 1, haPrice: 1 }],
        },
      }),
    ]);
    const summary = await get(api('all', 'bank/summary'), bankSummaryResponseSchema);
    expect(summary.cashValue).toBe(3250);
  });

  it('is zero with updatedAt null without data', async () => {
    const f = eventFactory();
    start([f.sessionStart('19:00')]);
    expect(await get(api('all', 'bank/summary'), bankSummaryResponseSchema)).toEqual({
      geValue: 0,
      bankGeValue: 0,
      potionStorageGeValue: 0,
      inventoryGeValue: 0,
      equipmentGeValue: 0,
      cashValue: 0,
      updatedAt: null,
      prices: { source: 'SNAPSHOT', fetchedAt: null },
    });
  });
});

describe('GET …/bank/history', () => {
  const history = (account: number | 'all', from: string, to: string) =>
    get(`${api(account, 'bank/history')}?from=${from}&to=${to}`, bankHistoryResponseSchema);

  it('carries the last snapshot of the day forward over the October DST change', async () => {
    const f = eventFactory();
    start([
      // 24 Oct 22:00 local (UTC+2).
      f.bankSnapshot('2026-10-24T20:00:00.000Z', { payload: { items: [coins(100)] } }),
      // 25 Oct is 25 hours: 23:30 local is 22:30Z, still the 25th.
      f.bankSnapshot('2026-10-25T22:30:00.000Z', { payload: { items: [coins(200)] } }),
      // Later the same day wins.
      f.bankSnapshot('2026-10-25T22:45:00.000Z', { payload: { items: [coins(250)] } }),
    ]);
    const body = await history('all', '2026-10-22T22:00:00.000Z', '2026-10-27T23:00:00.000Z');
    // Before the first snapshot (23 Oct) is left out.
    expect(body.days.map((day) => [day.date, day.start, day.bankGeValue])).toEqual([
      ['2026-10-24', '2026-10-23T22:00:00.000Z', 100],
      ['2026-10-25', '2026-10-24T22:00:00.000Z', 250],
      ['2026-10-26', '2026-10-25T23:00:00.000Z', 250],
      ['2026-10-27', '2026-10-26T23:00:00.000Z', 250],
    ]);
    expect(body.days[1]).toMatchObject({ cashValue: 250, geValue: 250 });
  });

  it('puts a snapshot after midnight on the next day over the March DST change', async () => {
    const f = eventFactory();
    start(
      [
        f.bankSnapshot('2026-03-28T12:00:00.000Z', { payload: { items: [coins(1)] } }),
        // 29 Mar is 23 hours (ends 22:00Z): 22:30Z is 00:30 on the 30th.
        f.bankSnapshot('2026-03-29T22:30:00.000Z', { payload: { items: [coins(2)] } }),
      ],
      new Date('2026-04-02T12:00:00.000Z'),
    );
    const body = await history('all', '2026-03-27T23:00:00.000Z', '2026-03-31T22:00:00.000Z');
    expect(body.days.map((day) => [day.date, day.start, day.bankGeValue])).toEqual([
      ['2026-03-28', '2026-03-27T23:00:00.000Z', 1],
      ['2026-03-29', '2026-03-28T23:00:00.000Z', 1],
      ['2026-03-30', '2026-03-29T22:00:00.000Z', 2],
      ['2026-03-31', '2026-03-30T22:00:00.000Z', 2],
    ]);
  });

  it('sums each account carried forward for all, and potion storage separately', async () => {
    const f = eventFactory();
    start([
      // Snapshot before the range: carried into it.
      f.bankSnapshot('2026-10-30T12:00:00.000Z', { payload: { items: [coins(10)] } }),
      f.bankSnapshot('2026-11-03T12:00:00.000Z', { payload: { items: [coins(30)] } }),
      // Account B starts on 2 Nov.
      f.bankSnapshot('2026-11-02T12:00:00.000Z', {
        accountHash: HASH_B,
        payload: {
          items: [coins(5)],
          equipment: [
            {
              slot: 'HEAD',
              itemId: 1163,
              name: 'Rune full helm',
              quantity: 1,
              gePrice: 20_000,
              haPrice: 21_120,
            },
          ],
        },
      }),
      f.potionStorage('2026-11-03T08:00:00.000Z', { accountHash: HASH_B }),
    ]);
    const from = '2026-10-31T23:00:00.000Z';
    const to = '2026-11-04T23:00:00.000Z';
    const all = await history('all', from, to);
    expect(
      all.days.map((day) => [
        day.date,
        day.bankGeValue,
        day.equipmentGeValue,
        day.potionStorageGeValue,
        day.geValue,
      ]),
    ).toEqual([
      ['2026-11-01', 10, 0, 0, 10],
      ['2026-11-02', 15, 20_000, 0, 20_015],
      ['2026-11-03', 35, 20_000, 310_000, 330_035],
      ['2026-11-04', 35, 20_000, 310_000, 330_035],
    ]);
    const b = await history(idOf(HASH_B), from, to);
    expect(b.days.map((day) => day.date)).toEqual(['2026-11-02', '2026-11-03', '2026-11-04']);
  });

  it('has the HA value of inventory and equipment, carried forward and summed (1.20.0)', async () => {
    const f = eventFactory();
    const carried = (name: string, haPrice: number) => ({
      itemId: 1163,
      name,
      quantity: 2,
      gePrice: 100,
      haPrice,
    });
    start([
      f.bankSnapshot('2026-11-01T12:00:00.000Z', {
        payload: {
          inventory: [carried('Inventory item', 30)],
          equipment: [{ slot: 'HEAD', ...carried('Worn item', 400) }],
        },
      }),
      f.bankSnapshot('2026-11-02T12:00:00.000Z', {
        accountHash: HASH_B,
        payload: { inventory: [carried('Inventory item', 5)] },
      }),
    ]);
    const body = await history('all', '2026-10-31T23:00:00.000Z', '2026-11-03T23:00:00.000Z');
    expect(
      body.days.map((day) => [
        day.date,
        day.inventoryHaValue,
        day.equipmentHaValue,
        day.inventoryGeValue,
      ]),
    ).toEqual([
      ['2026-11-01', 60, 800, 200],
      ['2026-11-02', 70, 800, 400],
      ['2026-11-03', 70, 800, 400],
    ]);
  });

  it('stops at now and uses a rolling year by default', async () => {
    const f = eventFactory();
    start([f.bankSnapshot('2026-11-01T12:00:00.000Z')], new Date('2026-11-03T12:00:00.000Z'));
    const body = await get(api('all', 'bank/history'), bankHistoryResponseSchema);
    expect(body.from).toBe('2025-11-03T23:00:00.000Z');
    expect(body.to).toBe('2026-11-03T23:00:00.000Z');
    expect(body.days.map((day) => day.date)).toEqual(['2026-11-01', '2026-11-02', '2026-11-03']);
    const future = await history('all', '2026-11-01T00:00:00.000Z', '2026-11-10T00:00:00.000Z');
    expect(future.days.at(-1)?.date).toBe('2026-11-03');
  });

  it('is empty without data, and validates the range', async () => {
    const f = eventFactory();
    start([f.sessionStart('19:00')]);
    expect((await get(api('all', 'bank/history'), bankHistoryResponseSchema)).days).toEqual([]);
    const only = await getError(`${api('all', 'bank/history')}?from=2026-11-01T00:00:00.000Z`, 400);
    expect(only.details[0]?.path).toBe('query.to');
    const long = await getError(
      `${api('all', 'bank/history')}?from=2025-01-01T00:00:00.000Z&to=2026-11-01T00:00:00.000Z`,
      400,
    );
    expect(long.details[0]?.path).toBe('query.to');
  });
});

// The latest snapshots at current GE prices: the volume-weighted average of
// each item's trades in the 24 stored hours up to the newest one.
describe('current GE prices', () => {
  const PRICES_ON = { PRICES_ENABLED: 'true', USER_AGENT_CONTACT: 'you@example.com' };
  const HOUR = 3_600_000;
  /** End of the newest stored hour: the current window is the 24 hours before it. */
  const END = Date.parse('2026-11-10T11:00:00.000Z');
  /** When the newest hour was stored (prices/testing.ts: 15 minutes after it ended). */
  const FETCHED_AT = '2026-11-10T11:15:00.000Z';
  const CURRENT = { source: 'CURRENT', fetchedAt: FETCHED_AT };
  const SNAPSHOT = { source: 'SNAPSHOT', fetchedAt: null };

  /** One trade an hour on each side given. */
  const priced = (high: number | null, low: number | null): Trades => ({
    ...(high === null ? {} : { high: [high, 1] as const }),
    ...(low === null ? {} : { low: [low, 1] as const }),
  });

  const db = () => run!.database.db; // eslint-disable-line @typescript-eslint/no-non-null-assertion -- set by start()

  /** `count` hours up to `endMs`, every one with the same trades. */
  function hours(endMs: number, count: number, trades: Readonly<Record<number, Trades>>): void {
    storeHours(db(), endMs - count * HOUR, count, () => trades);
  }

  /** The current window: 24 hours up to `END` with `trades`. */
  function fetched(trades: Readonly<Record<number, Trades>>): void {
    hours(END, 24, trades);
  }

  const events = () => {
    const f = eventFactory();
    return [
      f.bankSnapshot('19:00', {
        payload: {
          // 4151: both sides. 11832: only a low. 4152: no row (as a noted or
          // untradeable item). 995/13204: cash, never repriced.
          items: [
            item(4151, 2, 1_000_000, 72_000),
            item(11832, 1, 30_000_000, 100),
            item(4152, 5, 400, 3),
            coins(500),
            platinum(2),
            item(1755, 0, 50),
          ],
          inventory: [
            { itemId: 4151, name: 'Item 4151', quantity: 1, gePrice: 1_000_000, haPrice: 72_000 },
            { itemId: 995, name: 'Coins', quantity: 250, gePrice: 1, haPrice: 1 },
          ],
          equipment: [
            {
              slot: 'WEAPON',
              itemId: 11832,
              name: 'Item 11832',
              quantity: 1,
              gePrice: 30_000_000,
              haPrice: 100,
            },
          ],
        },
      }),
      f.fromFixture('potion-storage-snapshot.json', '19:05'),
    ];
  };

  const wiki: Record<number, Trades> = {
    4151: priced(1_200_001, 1_100_000), // (1 200 001 + 1 100 000) ÷ 2, rounded down → 1 150 000
    11832: priced(null, 28_000_000),
    995: priced(5, 5),
    13204: priced(1100, 1100),
    1755: priced(80, 60),
    12695: priced(13_000, 12_000), // 12 500 per 4 doses
  };

  it('values the latest bank, inventory and equipment at current prices, item by item', async () => {
    start(events(), NOW, PRICES_ON);
    fetched(wiki);
    const body = await get(api('all', 'bank'), bankResponseSchema);
    expect(body.prices).toEqual(CURRENT);
    const bank = body.banks[0];
    expect(
      bank?.items.map((row) => [row.itemId, row.gePriceEach, row.gePriceSource, row.geValue]),
    ).toEqual([
      [4151, 1_150_000, 'CURRENT', 2_300_000],
      [11832, 28_000_000, 'CURRENT', 28_000_000],
      [4152, 400, 'SNAPSHOT', 2_000],
      [995, 1, 'SNAPSHOT', 500],
      [13204, 1000, 'SNAPSHOT', 2_000],
      [1755, 70, 'CURRENT', 0],
    ]);
    // HA and cash are from the snapshot.
    expect(bank?.totals).toEqual({
      geValue: 2_300_000 + 28_000_000 + 2_000 + 500 + 2_000,
      haValue: 144_000 + 100 + 15 + 500 + 2_000,
      cashValue: 500 + 2_000 + 250,
    });
    expect(bank?.inventory.items.map((row) => [row.gePriceSource, row.geValue])).toEqual([
      ['CURRENT', 1_150_000],
      ['SNAPSHOT', 250],
    ]);
    expect(bank?.equipment).toMatchObject({ geValue: 28_000_000 });
    expect(body.totals).toEqual(bank?.totals);
  });

  it('values potion storage from the current price of the full item', async () => {
    start(events(), NOW, PRICES_ON);
    fetched(wiki);
    const body = await get(api('all', 'potion-storage'), potionStorageResponseSchema);
    expect(body.prices).toEqual(CURRENT);
    expect(
      body.storages[0]?.potions.map((row) => [row.itemId, row.gePriceSource, row.geValue]),
    ).toEqual([
      [12695, 'CURRENT', (12_500 * 312) / 4],
      [3024, 'SNAPSHOT', 17_676],
    ]);
    expect(body.totals).toEqual({ geValue: 975_000 + 17_676, haValue: 315 });
  });

  it('gives a summary that agrees with bank and potion storage', async () => {
    start(events(), NOW, PRICES_ON);
    fetched(wiki);
    const summary = await get(api('all', 'bank/summary'), bankSummaryResponseSchema);
    const bank = await get(api('all', 'bank'), bankResponseSchema);
    const potions = await get(api('all', 'potion-storage'), potionStorageResponseSchema);
    expect(summary).toEqual({
      bankGeValue: bank.totals.geValue,
      potionStorageGeValue: potions.totals.geValue,
      inventoryGeValue: 1_150_250,
      equipmentGeValue: 28_000_000,
      geValue: bank.totals.geValue + potions.totals.geValue + 1_150_250 + 28_000_000,
      cashValue: 2_750,
      updatedAt: '2026-11-08T19:05:00.000Z',
      prices: CURRENT,
    });
  });

  it('keeps snapshot prices in the history', async () => {
    start(events(), NOW, PRICES_ON);
    const url = api(
      'all',
      'bank/history?from=2026-11-08T00:00:00.000Z&to=2026-11-10T00:00:00.000Z',
    );
    const before = await get(url, bankHistoryResponseSchema);
    fetched(wiki);
    expect(await get(url, bankHistoryResponseSchema)).toEqual(before);
    expect(before.days[0]?.bankGeValue).toBe(2_000_000 + 30_000_000 + 2_000 + 500 + 2_000);
  });

  it.each([
    ['PRICES_ENABLED is off', { USER_AGENT_CONTACT: 'you@example.com' }, true],
    ['USER_AGENT_CONTACT is not set', { PRICES_ENABLED: 'true' }, true],
    ['nothing has been fetched yet', PRICES_ON, false],
  ])('uses snapshot prices when %s', async (_name, env, withPrices) => {
    start(events(), NOW, env);
    const off = {
      bank: await get(api('all', 'bank'), bankResponseSchema),
      summary: await get(api('all', 'bank/summary'), bankSummaryResponseSchema),
      potions: await get(api('all', 'potion-storage'), potionStorageResponseSchema),
    };
    expect(off.bank.prices).toEqual(SNAPSHOT);
    expect(off.summary.prices).toEqual(SNAPSHOT);
    expect(off.potions.prices).toEqual(SNAPSHOT);
    expect(off.bank.banks[0]?.items.every((row) => row.gePriceSource === 'SNAPSHOT')).toBe(true);
    expect(off.summary.bankGeValue).toBe(32_004_500);
    if (withPrices) {
      // Prices left in the table from when the feature was on are ignored.
      fetched(wiki);
      expect(await get(api('all', 'bank'), bankResponseSchema)).toEqual(off.bank);
      expect(await get(api('all', 'bank/summary'), bankSummaryResponseSchema)).toEqual(off.summary);
    }
  });

  // --- Price movers ---------------------------------------------

  /** 24 h before `END` (the end of the 24 h baseline window). */
  const DAY_AGO = '2026-11-09T11:00:00.000Z';
  /** The UTC day 7 d compares with: the middle of the window (9 Nov 23:00) minus 7 days. */
  const WEEK_DAY = Date.parse('2026-11-02T00:00:00.000Z');
  const WEEK_AGO = '2026-11-03T00:00:00.000Z';
  // 12 500 for the potion then as now, and no trades of 11832.
  const weekAgo: Record<number, Trades> = {
    4151: priced(1_150_000, 1_150_000),
    12695: priced(12_000, 12_000),
  };
  const dayAgo: Record<number, Trades> = {
    4151: priced(1_000_000, 1_000_000),
    11832: priced(null, 29_000_000),
    12695: priced(12_500, 12_500),
    995: priced(4, 4),
    13204: priced(900, 900),
    1755: priced(10, 10),
  };

  /** A whole UTC day for 7 d, the 24 h baseline window, then the current one (`wiki`). */
  function history({ week = true }: { week?: boolean } = {}): void {
    if (week) hours(WEEK_DAY + 24 * HOUR, 24, weekAgo);
    hours(END - 24 * HOUR, 24, dayAgo);
    fetched(wiki);
  }

  it('gives the change per held item for each period that has earlier prices', async () => {
    start(events(), NOW, PRICES_ON);
    history();
    const movers = await get(api('all', 'bank/price-movers'), priceMoversResponseSchema);
    expect(movers.prices).toEqual(CURRENT);
    // No 30 d: nothing is stored about then.
    expect(movers.periods.map((period) => period.period)).toEqual(['24h', '7d']);
    expect(movers.periods[0]).toEqual({
      period: '24h',
      baselineAt: DAY_AGO,
      // The sum of the items: the schema checks it too.
      change: 450_000 - 2_000_000,
      items: [
        // Two in the bank and one in the inventory, as one row.
        {
          kind: 'ITEM',
          itemId: 4151,
          name: 'Item 4151',
          quantity: 3,
          priceEach: 1_150_000,
          previousPriceEach: 1_000_000,
          change: 450_000,
        },
        // Bank and equipment.
        {
          kind: 'ITEM',
          itemId: 11832,
          name: 'Item 11832',
          quantity: 2,
          priceEach: 28_000_000,
          previousPriceEach: 29_000_000,
          change: -2_000_000,
        },
      ],
    });
    // Left out without a word: coins and platinum tokens (fixed price), the
    // placeholder, 4152 and Super restore (no price), and the potion (same price).
    expect(movers.periods[1]).toEqual({
      period: '7d',
      baselineAt: WEEK_AGO,
      change: 39_000,
      // 11832 had no trades that day, and 4151 cost the same.
      items: [
        {
          kind: 'POTION',
          itemId: 12695,
          name: 'Super combat potion',
          doses: 312,
          itemDoses: 4,
          priceEach: 12_500,
          previousPriceEach: 12_000,
          // ⌊12 500 × 312 ÷ 4⌋ − ⌊12 000 × 312 ÷ 4⌋
          change: 975_000 - 936_000,
        },
      ],
    });
  });

  it('leaves out an item without trades in the current window, though the bank still prices it', async () => {
    start(events(), NOW, PRICES_ON);
    // A day ago both items traded. The current window has no 11832.
    hours(END - 24 * HOUR, 24, dayAgo);
    fetched(Object.fromEntries(Object.entries(wiki).filter(([id]) => id !== '11832')));
    // The bank prices 11832 from the last 7 days (29M, from a day ago) …
    const bank = await get(api('all', 'bank'), bankResponseSchema);
    expect(bank.banks[0]?.items.find((row) => row.itemId === 11832)).toMatchObject({
      gePriceEach: 29_000_000,
      gePriceSource: 'CURRENT',
    });
    // … but that is not a price from the window, so it is no price change.
    const movers = await get(api('all', 'bank/price-movers'), priceMoversResponseSchema);
    expect(movers.periods).toHaveLength(1);
    expect(movers.periods[0]?.items.map((row) => row.itemId)).toEqual([4151]);
    expect(movers.periods[0]?.change).toBe(450_000);
  });

  it('counts the windows back from the newest stored hour, also when it is days old', async () => {
    start(events(), NOW, PRICES_ON);
    // Nothing stored since three days before END (the server was not used).
    const old = END - 72 * HOUR;
    hours(old - 24 * HOUR, 24, dayAgo);
    hours(old, 24, wiki);
    const movers = await get(api('all', 'bank/price-movers'), priceMoversResponseSchema);
    expect(movers.prices).toEqual({ source: 'CURRENT', fetchedAt: '2026-11-07T11:15:00.000Z' });
    expect(movers.periods.map(({ period, baselineAt }) => ({ period, baselineAt }))).toEqual([
      { period: '24h', baselineAt: '2026-11-06T11:00:00.000Z' },
    ]);
  });

  it('keeps one odd trade from moving the price: the side with more trades wins', async () => {
    start(events(), NOW, PRICES_ON);
    hours(END - 24 * HOUR, 24, dayAgo);
    // 4151 sells at 1M all day; one hour has a single insta-buy at 80M.
    hours(END - HOUR, 23, { ...dayAgo, 4151: { low: [1_000_000, 3] } });
    hours(END, 1, { ...dayAgo, 4151: { high: [80_000_000, 1], low: [1_000_000, 3] } });
    const bank = await get(api('all', 'bank'), bankResponseSchema);
    expect(bank.banks[0]?.items.find((row) => row.itemId === 4151)?.gePriceEach).toBe(1_000_000);
    const movers = await get(api('all', 'bank/price-movers'), priceMoversResponseSchema);
    expect(movers.periods[0]?.items.map((row) => row.itemId)).not.toContain(4151);
  });

  it('explains the change in net worth: the sum is the bank at the two sets of prices', async () => {
    start(events(), NOW, PRICES_ON);
    // Every priced item traded a day ago, so nothing is left out.
    history({ week: false });
    const now = await get(api('all', 'bank/summary'), bankSummaryResponseSchema);
    const movers = await get(api('all', 'bank/price-movers'), priceMoversResponseSchema);
    // Net worth a day ago at the same holdings: 4151 × 3, 11832 × 2 and the potions.
    const then = now.geValue - 3 * 150_000 + 2 * 1_000_000;
    expect(movers.periods).toHaveLength(1);
    expect(movers.periods[0]?.change).toBe(now.geValue - then);
  });

  it('gives one account its own items, and no periods before there is history', async () => {
    const f = eventFactory();
    start(
      [
        f.bankSnapshot('19:00', { payload: { items: [item(4151, 3, 1_000_000)] } }),
        f.bankSnapshot('19:10', {
          accountHash: HASH_B,
          payload: { items: [item(4151, 10, 1_000_000)] },
        }),
      ],
      NOW,
      PRICES_ON,
    );
    fetched(wiki);
    const none = await get(api('all', 'bank/price-movers'), priceMoversResponseSchema);
    expect(none).toEqual({ prices: CURRENT, periods: [] });

    // The hours before the window, fetched afterwards (a catch-up goes oldest first anyway).
    hours(END - 24 * HOUR, 24, dayAgo);
    const all = await get(api('all', 'bank/price-movers'), priceMoversResponseSchema);
    expect(all.periods[0]?.items[0]).toMatchObject({ itemId: 4151, quantity: 13 });
    const b = await get(api(idOf(HASH_B), 'bank/price-movers'), priceMoversResponseSchema);
    expect(b.periods[0]?.items).toEqual([
      expect.objectContaining({ itemId: 4151, quantity: 10, change: 1_500_000 }),
    ]);
    expect(b.periods[0]?.change).toBe(1_500_000);
  });

  it.each([
    ['PRICES_ENABLED is off', { USER_AGENT_CONTACT: 'you@example.com' }],
    ['USER_AGENT_CONTACT is not set', { PRICES_ENABLED: 'true' }],
  ])('has no periods when %s, also with history stored', async (_name, env) => {
    start(events(), NOW, env);
    history();
    expect(await get(api('all', 'bank/price-movers'), priceMoversResponseSchema)).toEqual({
      prices: SNAPSHOT,
      periods: [],
    });
  });

  it('is empty without a bank, 404 for an unknown account and 400 for a query', async () => {
    start([], NOW, PRICES_ON);
    history();
    const movers = await get(api('all', 'bank/price-movers'), priceMoversResponseSchema);
    expect(movers.periods.map((period) => [period.period, period.change, period.items])).toEqual([
      ['24h', 0, []],
      ['7d', 0, []],
    ]);
    expect((await getError(api(999, 'bank/price-movers'), 404)).code).toBe('NOT_FOUND');
    await getError(`${api('all', 'bank/price-movers')}?period=7d`, 400);
  });

  it('keeps the stored hours and days through a rebuild, with the same answer after', async () => {
    start(events(), NOW, PRICES_ON);
    history();
    const rows = () => [db().select().from(priceHours).all(), db().select().from(priceDays).all()];
    const stored = rows();
    const before = await get(api('all', 'bank/price-movers'), priceMoversResponseSchema);
    expect(rebuildDerivedTables(db(), { now: () => TEST_NOW }).failed).toEqual([]);
    expect(rows()).toEqual(stored);
    expect(await get(api('all', 'bank/price-movers'), priceMoversResponseSchema)).toEqual(before);
  });
});
