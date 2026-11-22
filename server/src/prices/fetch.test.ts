import { afterEach, describe, expect, it } from 'vitest';
import type { Database } from '../db/index.js';
import { itemPriceHistory, itemPrices } from '../db/schema.js';
import {
  ExternalDisabledError,
  ExternalRequestError,
  type ExternalClient,
} from '../external/client.js';
import { sourceState } from '../external/state.js';
import { testDatabase } from '../test-utils.js';
import {
  MIN_PRICE_ITEMS,
  parseLatestPrices,
  PRICES_PATH,
  PricesFormatError,
  refreshPrices,
} from './fetch.js';

// Hand-written responses in the shape of `/latest`. No real network.

const SECONDS = 1_794_830_400; // 2026-11-16T12:00:00Z
const ISO = '2026-11-16T12:00:00.000Z';

/** `count` items from ID 1000, each `{ high: id, low: id − 1 }`. */
function latest(count: number, extra: Record<string, unknown> = {}) {
  const data: Record<string, unknown> = {};
  for (let id = 1000; id < 1000 + count; id++) {
    data[String(id)] = { high: id, highTime: SECONDS, low: id - 1, lowTime: SECONDS - 60 };
  }
  return { data: { ...data, ...extra } };
}

describe('parseLatestPrices', () => {
  it('reads prices and times, with either side missing', () => {
    const prices = parseLatestPrices(
      latest(MIN_PRICE_ITEMS, {
        '2': { high: 185, highTime: SECONDS, low: null, lowTime: null },
        '6': { high: null, highTime: null, low: 2_500_000_000, lowTime: SECONDS },
      }),
    );
    expect(prices).toHaveLength(MIN_PRICE_ITEMS + 2);
    expect(prices.find((row) => row.itemId === 2)).toEqual({
      itemId: 2,
      high: 185,
      highTime: ISO,
      low: null,
      lowTime: null,
    });
    // Prices can pass 32 bits.
    expect(prices.find((row) => row.itemId === 6)).toEqual({
      itemId: 6,
      high: null,
      highTime: null,
      low: 2_500_000_000,
      lowTime: ISO,
    });
    expect(prices.find((row) => row.itemId === 1000)?.lowTime).toBe('2026-11-16T11:59:00.000Z');
  });

  it('leaves out an item with neither side', () => {
    const prices = parseLatestPrices(
      latest(MIN_PRICE_ITEMS, { '7': { high: null, highTime: null, low: null, lowTime: null } }),
    );
    expect(prices.some((row) => row.itemId === 7)).toBe(false);
    expect(prices).toHaveLength(MIN_PRICE_ITEMS);
  });

  const ok = { high: 5, highTime: SECONDS, low: 4, lowTime: SECONDS };

  it.each([
    ['an array', [], /unexpected format/],
    ['a string', 'nope', /unexpected format/],
    ['null', null, /unexpected format/],
    ['an error object', { error: 'Too many requests' }, /unexpected format/],
    ['the item map without the data wrapper', latest(MIN_PRICE_ITEMS).data, /unexpected format/],
    [
      'a new top-level field',
      { ...latest(MIN_PRICE_ITEMS), timestamp: SECONDS },
      /unexpected format/,
    ],
    [
      'a new field on an item',
      latest(MIN_PRICE_ITEMS, { '2': { ...ok, volume: 7 } }),
      /at data\.2/,
    ],
    [
      'a missing field on an item',
      latest(MIN_PRICE_ITEMS, { '2': { high: 5, low: 4 } }),
      /at data\.2/,
    ],
    [
      'a price with decimals',
      latest(MIN_PRICE_ITEMS, { '2': { ...ok, high: 100.9 } }),
      /at data\.2\.high/,
    ],
    ['a negative price', latest(MIN_PRICE_ITEMS, { '2': { ...ok, low: -5 } }), /at data\.2\.low/],
    ['a price as text', latest(MIN_PRICE_ITEMS, { '2': { ...ok, low: '4' } }), /at data\.2\.low/],
    [
      'a time in milliseconds',
      latest(MIN_PRICE_ITEMS, { '2': { ...ok, highTime: SECONDS * 1000 } }),
      /at data\.2\.highTime/,
    ],
    [
      'a time as text',
      latest(MIN_PRICE_ITEMS, { '2': { ...ok, lowTime: 'yesterday' } }),
      /at data\.2\.lowTime/,
    ],
    ['an item that is not an object', latest(MIN_PRICE_ITEMS, { '2': 'nothing' }), /at data\.2/],
    ['a key that is not an item ID', latest(MIN_PRICE_ITEMS, { abc: ok }), /at data\.abc/],
    ['a negative item ID', latest(MIN_PRICE_ITEMS, { '-3': ok }), /at data\.-3/],
    ['an item ID with a leading zero', latest(MIN_PRICE_ITEMS, { '01': ok }), /at data\.01/],
    ['too few items', latest(MIN_PRICE_ITEMS - 1), /only 99 usable items/],
    ['an empty map', { data: {} }, /only 0 usable items/],
  ])('rejects %s', (_name, body, message) => {
    expect(() => parseLatestPrices(body)).toThrow(PricesFormatError);
    expect(() => parseLatestPrices(body)).toThrow(message);
  });

  it('never puts values from the response in the error', () => {
    const body = latest(MIN_PRICE_ITEMS, { '2': { ...ok, low: 'secret-value' } });
    try {
      parseLatestPrices(body);
      expect.unreachable();
    } catch (error) {
      expect((error as Error).message).not.toContain('secret-value');
    }
  });
});

describe('refreshPrices', () => {
  let database: Database | undefined;
  afterEach(() => {
    database?.close();
    database = undefined;
  });

  const silent = { info: () => undefined, warn: () => undefined, error: () => undefined };
  const warnings: [object, string][] = [];
  const log = {
    ...silent,
    warn: (fields: object, message: string) => void warnings.push([fields, message]),
  };

  function setup() {
    database = testDatabase();
    const db = database.db;
    let nowMs = Date.parse('2026-11-16T12:00:00.000Z');
    const paths: string[] = [];
    let reply: () => unknown = () => latest(MIN_PRICE_ITEMS);
    const client: ExternalClient = {
      getJson(source, path) {
        paths.push(`${source} ${path}`);
        nowMs += 1500; // the request takes a while
        try {
          return Promise.resolve(reply());
        } catch (error) {
          return Promise.reject(error instanceof Error ? error : new Error('failed'));
        }
      },
      getText() {
        return Promise.reject(new Error('getText is not used for prices'));
      },
    };
    return {
      db,
      paths,
      advance: (ms: number) => (nowMs += ms),
      replyWith: (next: () => unknown) => (reply = next),
      refresh: () => refreshPrices({ db, client, log, now: () => new Date(nowMs) }),
      rows: () => db.select().from(itemPrices).all(),
      history: () => db.select().from(itemPriceHistory).all(),
      state: () => sourceState(db, 'WIKI_PRICES'),
    };
  }

  it('fetches every item in one request and stores it', async () => {
    const t = setup();
    expect(await t.refresh()).toBe(true);
    expect(t.paths).toEqual([`WIKI_PRICES ${PRICES_PATH}`]);
    expect(PRICES_PATH).not.toContain('?');
    expect(t.rows()).toHaveLength(MIN_PRICE_ITEMS);
    expect(t.rows()[0]).toEqual({
      itemId: 1000,
      high: 1000,
      highTime: ISO,
      low: 999,
      lowTime: '2026-11-16T11:59:00.000Z',
      fetchedAt: '2026-11-16T12:00:01.500Z',
    });
    expect(t.state()).toEqual({
      source: 'WIKI_PRICES',
      lastAttemptAt: '2026-11-16T12:00:00.000Z',
      lastSuccessAt: '2026-11-16T12:00:01.500Z',
      lastError: null,
      lastErrorAt: null,
    });
  });

  it('updates items that are in a newer response and keeps the ones that are not', async () => {
    const t = setup();
    await t.refresh();
    t.advance(3_600_000);
    t.replyWith(() => {
      // One new item (the last ID), one changed (1000) and one gone (1001).
      const body = latest(MIN_PRICE_ITEMS + 1, {
        '1000': { high: 5, highTime: SECONDS, low: null, lowTime: null },
      });
      delete (body.data as Record<string, unknown>)['1001'];
      return body;
    });
    expect(await t.refresh()).toBe(true);
    const byId = new Map(t.rows().map((row) => [row.itemId, row]));
    expect(byId.size).toBe(MIN_PRICE_ITEMS + 1);
    expect(byId.get(1000)).toMatchObject({ high: 5, low: null, lowTime: null });
    expect(byId.get(1000)?.fetchedAt).toBe('2026-11-16T13:00:03.000Z');
    expect(byId.get(1001)).toMatchObject({ high: 1001, fetchedAt: '2026-11-16T12:00:01.500Z' });
  });

  it.each([
    [
      'the request fails',
      () => Promise.reject(new ExternalRequestError('HTTP 503', 503)),
      'HTTP 503',
    ],
    [
      'the response has the wrong shape',
      () => ({ error: 'nope' }),
      'The price response had an unexpected format at data: invalid_type',
    ],
    [
      'something unexpected is thrown',
      () => {
        throw new Error('secret detail');
      },
      'Unexpected error, see the server log',
    ],
    [
      'the source was turned off',
      () => {
        throw new ExternalDisabledError('off');
      },
      'Unexpected error, see the server log',
    ],
  ])('keeps the last good prices when %s', async (_name, reply, message) => {
    const t = setup();
    await t.refresh();
    const before = t.rows();
    const history = t.history();
    // One history row per item of the good fetch.
    expect(history).toHaveLength(MIN_PRICE_ITEMS);
    t.advance(3_600_000);
    t.replyWith(reply);
    expect(await t.refresh()).toBe(false);
    expect(t.rows()).toEqual(before);
    // A failed fetch adds nothing to the history and prunes nothing.
    expect(t.history()).toEqual(history);
    expect(t.state()).toEqual({
      source: 'WIKI_PRICES',
      lastAttemptAt: '2026-11-16T13:00:01.500Z',
      lastSuccessAt: '2026-11-16T12:00:01.500Z',
      lastError: message,
      lastErrorAt: '2026-11-16T13:00:03.000Z',
    });

    // The next good fetch clears the error.
    t.advance(3_600_000);
    t.replyWith(() => latest(MIN_PRICE_ITEMS));
    expect(await t.refresh()).toBe(true);
    expect(t.state()).toMatchObject({ lastError: null, lastErrorAt: null });
  });

  it('stores a fetch on a wrong clock like any other, and warns once with the two times', async () => {
    warnings.length = 0;
    const t = setup();
    await t.refresh();
    t.advance(3_600_000);
    await t.refresh();
    expect(warnings).toEqual([]);
    const before = t.history();

    // The clock jumps two months ahead.
    t.advance(61 * 24 * 3_600_000);
    expect(await t.refresh()).toBe(true);
    // Nothing deleted: the two earlier fetches are still there, plus the new one.
    expect(t.history()).toHaveLength(3 * MIN_PRICE_ITEMS);
    expect(t.history()).toEqual(expect.arrayContaining(before));
    expect(warnings).toHaveLength(1);
    // Only the two times.
    expect(warnings[0]?.[0]).toEqual({
      fetchedAt: '2027-01-16T13:00:04.500Z',
      previousAt: '2026-11-16T13:00:03.000Z',
    });
    expect(warnings[0]?.[1]).toMatch(/more than a day after the previous stored one, or before it/);

    // Still ahead an hour later: that fetch follows on, so no warning.
    t.advance(3_600_000);
    await t.refresh();
    expect(warnings).toHaveLength(1);

    // The clock is put right: the fetch is before the newest stored one.
    t.advance(-61 * 24 * 3_600_000);
    await t.refresh();
    expect(warnings).toHaveLength(2);
    expect(warnings[1]?.[0]).toEqual({
      fetchedAt: '2026-11-16T14:00:07.500Z',
      previousAt: '2027-01-16T14:00:06.000Z',
    });
    // The fetches after that follow on from it: no more warnings.
    t.advance(3_600_000);
    await t.refresh();
    t.advance(3_600_000);
    await t.refresh();
    expect(warnings).toHaveLength(2);
    // All seven fetches are kept: nothing is pruned by the clock.
    expect(t.history()).toHaveLength(7 * MIN_PRICE_ITEMS);
  });
});
