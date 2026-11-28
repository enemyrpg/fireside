import { afterEach, describe, expect, it } from 'vitest';
import type { Database } from '../db/index.js';
import { priceDayHours, priceDays, priceHourFetches, priceHours } from '../db/schema.js';
import {
  ExternalDisabledError,
  ExternalRequestError,
  type ExternalClient,
} from '../external/client.js';
import { sourceState } from '../external/state.js';
import { testDatabase } from '../test-utils.js';
import {
  fetchMissingHours,
  HOUR_PATH,
  latestSettledHour,
  MAX_HOUR_SUM,
  MIN_PRICE_ITEMS,
  missingHours,
  parseHourBucket,
  PRICE_CATCHUP_MAX,
  PRICE_DAYS_KEPT,
  PRICE_HOUR_SETTLE_MS,
  PRICE_HOURS_KEPT,
  PricesFormatError,
  storeHourBucket,
} from './fetch.js';
import { DAY, FILLER_FROM, HOUR, hourResponse, storeHour, storeHours } from './testing.js';

// Hand-made responses in the shape of `/1h` (prices/testing.ts). No real network.

const H = Date.parse('2026-11-16T12:00:00.000Z');

describe('parseHourBucket', () => {
  it('reads every item with its value (average × volume, whole gp) and volume per side', () => {
    const bucket = parseHourBucket(
      hourResponse(H, {
        4151: { high: [1_500_000.25, 4], low: [1_490_000.5, 3] },
        2: { low: [180, 7] },
      }),
      H,
    );
    expect(bucket.hourStart).toBe('2026-11-16T12:00:00.000Z');
    expect(bucket.items).toHaveLength(MIN_PRICE_ITEMS + 2);
    expect(bucket.items.find((item) => item.itemId === 4151)).toEqual({
      itemId: 4151,
      highValue: 6_000_001,
      highVolume: 4,
      lowValue: 4_470_002, // 4 470 001.5, rounded
      lowVolume: 3,
    });
    expect(bucket.items.find((item) => item.itemId === 2)).toEqual({
      itemId: 2,
      highValue: 0,
      highVolume: 0,
      lowValue: 1_260,
      lowVolume: 7,
    });
    expect(bucket.skipped).toBe(0);
  });

  const entry = { avgHighPrice: 10, highPriceVolume: 1, avgLowPrice: 9, lowPriceVolume: 1 };
  const withItem = (item: unknown) => {
    const body = hourResponse(H);
    body.data['4151'] = item;
    return body;
  };

  it.each([
    ['not an object', 'nope', 'unexpected format'],
    ['no data', { timestamp: H / 1000 }, 'at data'],
    ['no timestamp', { data: hourResponse(H).data }, 'at timestamp'],
    ['an extra top-level field', { ...hourResponse(H), extra: 1 }, 'unrecognized_keys'],
    ['an extra item field', withItem({ ...entry, extra: 1 }), 'at data.4151'],
    ['a missing item field', withItem({ avgHighPrice: 10, highPriceVolume: 1 }), 'at data.4151'],
    [
      'a price as a string',
      withItem({ ...entry, avgHighPrice: '10' }),
      'at data.4151.avgHighPrice',
    ],
    [
      'a negative volume',
      withItem({ ...entry, lowPriceVolume: -1 }),
      'at data.4151.lowPriceVolume',
    ],
    ['a fractional volume', withItem({ ...entry, lowPriceVolume: 1.5 }), 'lowPriceVolume'],
    ['a null average with trades', withItem({ ...entry, avgHighPrice: null }), 'at data.4151'],
    ['an average without trades', withItem({ ...entry, highPriceVolume: 0 }), 'at data.4151'],
    [
      'an item ID that is not a number',
      { ...hourResponse(H), data: { abc: entry } },
      'at data.abc',
    ],
    [
      'a timestamp that is not an hour',
      { ...hourResponse(H), timestamp: H / 1000 + 60 },
      'timestamp',
    ],
  ])('refuses %s', (_name, body, message) => {
    expect(() => parseHourBucket(body, H)).toThrow(PricesFormatError);
    expect(() => parseHourBucket(body, H)).toThrow(message);
  });

  it('never puts values from the response in the error', () => {
    try {
      parseHourBucket(withItem({ ...entry, avgHighPrice: 'secret-value' }), H);
      expect.unreachable();
    } catch (error) {
      expect(String(error)).not.toContain('secret-value');
    }
  });

  it('refuses a response for another hour (a wrong clock, a cache) and one with too few items', () => {
    expect(() => parseHourBucket(hourResponse(H + HOUR), H)).toThrow('for another hour');
    expect(() => parseHourBucket(hourResponse(H, {}, MIN_PRICE_ITEMS - 1), H)).toThrow(
      `only ${String(MIN_PRICE_ITEMS - 1)} usable items`,
    );
    // An empty hour, as for a time the wiki has no data for yet.
    expect(() => parseHourBucket({ data: {}, timestamp: H / 1000 }, H)).toThrow('only 0');
  });

  it('leaves out an item whose sums would be too large to add up exactly', () => {
    const bucket = parseHourBucket(
      hourResponse(H, { 4151: { high: [MAX_HOUR_SUM, 2] }, 2: { low: [MAX_HOUR_SUM, 1] } }),
      H,
    );
    expect(bucket.skipped).toBe(1);
    expect(bucket.items.map((item) => item.itemId)).toContain(2);
    expect(bucket.items.map((item) => item.itemId)).not.toContain(4151);
  });
});

describe('storing hours', () => {
  let database: Database | undefined;
  afterEach(() => {
    database?.close();
    database = undefined;
  });
  const setup = () => (database = testDatabase()).db;

  it('stores the hour, its items and its day, and adds a second hour to the same day', () => {
    const db = setup();
    storeHour(db, H, { 4151: { high: [110, 2], low: [100, 3] } });
    storeHour(db, H + HOUR, { 4151: { low: [90, 1] } });
    expect(db.select().from(priceHourFetches).all()).toEqual([
      { hourStart: '2026-11-16T12:00:00.000Z', fetchedAt: '2026-11-16T13:15:00.000Z', items: 101 },
      { hourStart: '2026-11-16T13:00:00.000Z', fetchedAt: '2026-11-16T14:15:00.000Z', items: 101 },
    ]);
    expect(
      db
        .select()
        .from(priceHours)
        .all()
        .filter((row) => row.itemId === 4151),
    ).toEqual([
      {
        hourStart: '2026-11-16T12:00:00.000Z',
        itemId: 4151,
        highValue: 220,
        highVolume: 2,
        lowValue: 300,
        lowVolume: 3,
      },
      {
        hourStart: '2026-11-16T13:00:00.000Z',
        itemId: 4151,
        highValue: 0,
        highVolume: 0,
        lowValue: 90,
        lowVolume: 1,
      },
    ]);
    expect(
      db
        .select()
        .from(priceDays)
        .all()
        .find((row) => row.itemId === 4151),
    ).toEqual({
      day: '2026-11-16',
      itemId: 4151,
      highValue: 220,
      highVolume: 2,
      lowValue: 390,
      lowVolume: 4,
    });
    expect(db.select().from(priceDayHours).all()).toEqual([{ day: '2026-11-16', hours: 2 }]);
  });

  it('never counts an hour twice in its day', () => {
    const db = setup();
    const bucket = parseHourBucket(hourResponse(H, { 4151: { low: [100, 1] } }), H);
    expect(storeHourBucket(db, bucket, new Date(H + HOUR))).toBe(true);
    expect(storeHourBucket(db, bucket, new Date(H + 2 * HOUR))).toBe(false);
    expect(db.select().from(priceDayHours).all()).toEqual([{ day: '2026-11-16', hours: 1 }]);
    expect(
      db
        .select()
        .from(priceDays)
        .all()
        .find((row) => row.itemId === 4151)?.lowVolume,
    ).toBe(1);
  });

  it('keeps the 48 hours up to the newest and 35 days, counted from the newest hour', () => {
    const db = setup();
    const first = Date.parse('2026-10-01T00:00:00.000Z');
    // 40 days of hours: every day complete.
    storeHours(db, first, 40 * 24);
    const newest = first + (40 * 24 - 1) * HOUR;
    const hours = db.select().from(priceHourFetches).all();
    expect(hours).toHaveLength(PRICE_HOURS_KEPT);
    expect(hours[0]?.hourStart).toBe(
      new Date(newest - (PRICE_HOURS_KEPT - 1) * HOUR).toISOString(),
    );
    expect(db.select().from(priceHours).all()).toHaveLength(PRICE_HOURS_KEPT * MIN_PRICE_ITEMS);
    const days = db.select().from(priceDayHours).all();
    expect(days).toHaveLength(PRICE_DAYS_KEPT);
    expect(days.every((day) => day.hours === 24)).toBe(true);
    expect(days[0]?.day).toBe('2026-10-06'); // 9 November, the newest day, minus 34
    expect(
      new Set(
        db
          .select()
          .from(priceDays)
          .all()
          .map((row) => row.day),
      ).size,
    ).toBe(PRICE_DAYS_KEPT);
  });

  it('prunes nothing when an older missing hour is stored', () => {
    const db = setup();
    storeHour(db, H);
    storeHour(db, H - 10 * HOUR);
    expect(db.select().from(priceHourFetches).all()).toHaveLength(2);
  });
});

describe('missingHours', () => {
  let database: Database | undefined;
  afterEach(() => {
    database?.close();
    database = undefined;
  });

  it('asks only for hours that ended at least the settle time ago', () => {
    database = testDatabase();
    expect(PRICE_HOUR_SETTLE_MS).toBe(10 * 60 * 1000);
    // 13:09: the 12:00 hour ended 9 minutes ago, so 11:00 is the newest settled one.
    expect(latestSettledHour(H + HOUR + 9 * 60 * 1000)).toBe(H - HOUR);
    expect(latestSettledHour(H + HOUR + 10 * 60 * 1000)).toBe(H);
  });

  it('gives the missing hours of the last 48, oldest first', () => {
    database = testDatabase();
    const db = database.db;
    const now = H + HOUR + 15 * 60 * 1000; // newest settled: H
    const all = missingHours(db, now);
    expect(all).toHaveLength(PRICE_CATCHUP_MAX);
    expect(all[0]).toBe(H - 47 * HOUR);
    expect(all.at(-1)).toBe(H);
    storeHour(db, H - 47 * HOUR);
    storeHour(db, H - 2 * HOUR);
    const rest = missingHours(db, now);
    expect(rest).toHaveLength(46);
    expect(rest).not.toContain(H - 2 * HOUR);
    expect(rest[0]).toBe(H - 46 * HOUR);
  });

  it('never asks again for an hour pruning has passed, also with a clock that is behind', () => {
    database = testDatabase();
    const db = database.db;
    storeHours(db, H - 47 * HOUR, 48);
    expect(missingHours(db, H + HOUR + 15 * 60 * 1000)).toEqual([]);
    // The clock goes back three days: those hours were never stored, but
    // they are older than what is kept, so they are not fetched.
    expect(missingHours(db, H - 3 * DAY)).toEqual([]);
  });
});

describe('fetchMissingHours', () => {
  let database: Database | undefined;
  afterEach(() => {
    database?.close();
    database = undefined;
  });

  const silent = { info: () => undefined, warn: () => undefined, error: () => undefined };

  function setup(nowMs = H + HOUR + 15 * 60 * 1000) {
    database = testDatabase();
    const db = database.db;
    let clock = nowMs;
    const paths: string[] = [];
    // An Error is thrown as the request's failure; anything else is the response body.
    let fail: ((hourMs: number) => unknown) | undefined;
    const client: ExternalClient = {
      getJson(source, path) {
        paths.push(`${source} ${path}`);
        clock += 10_000; // the source's spacing
        const hourMs =
          Number(new URL(path, 'https://x.example').searchParams.get('timestamp')) * 1000;
        const result = fail?.(hourMs);
        if (result instanceof Error) return Promise.reject(result);
        if (result !== undefined) return Promise.resolve(result);
        return Promise.resolve(hourResponse(hourMs, { 4151: { low: [100, 1] } }));
      },
      getText() {
        return Promise.reject(new Error('getText is not used for prices'));
      },
    };
    const warnings: string[] = [];
    const log = { ...silent, warn: (_obj: object, msg: string) => void warnings.push(msg) };
    return {
      db,
      paths,
      warnings,
      failWith: (next: typeof fail) => (fail = next),
      run: (stopped?: () => boolean) =>
        fetchMissingHours({
          db,
          client,
          log,
          now: () => new Date(clock),
          ...(stopped ? { stopped } : {}),
        }),
      hours: () =>
        db
          .select()
          .from(priceHourFetches)
          .all()
          .map((row) => Date.parse(row.hourStart)),
      state: () => sourceState(db, 'WIKI_PRICES'),
    };
  }

  const ts = (hourMs: number) => `WIKI_PRICES ${HOUR_PATH}?timestamp=${String(hourMs / 1000)}`;

  it('fetches every missing hour once, oldest first, at most 48, without an id', async () => {
    const t = setup();
    expect(await t.run()).toBe(PRICE_CATCHUP_MAX);
    expect(t.paths).toHaveLength(PRICE_CATCHUP_MAX);
    expect(t.paths[0]).toBe(ts(H - 47 * HOUR));
    expect(t.paths.at(-1)).toBe(ts(H));
    expect(t.paths.every((path) => !path.includes('id='))).toBe(true);
    expect(t.hours()).toHaveLength(PRICE_CATCHUP_MAX);
    // Nothing left: a second run makes no request.
    expect(await t.run()).toBe(0);
    expect(t.paths).toHaveLength(PRICE_CATCHUP_MAX);
    expect(t.state()).toMatchObject({ lastError: null });
  });

  it('stops at the first failure, keeps what it stored, and records the error', async () => {
    const t = setup();
    t.failWith((hourMs) =>
      hourMs === H - 40 * HOUR ? new ExternalRequestError('HTTP 503 from the source') : undefined,
    );
    expect(await t.run()).toBe(7);
    expect(t.paths).toHaveLength(8);
    expect(t.hours()).toHaveLength(7);
    expect(t.state()).toMatchObject({ lastError: 'HTTP 503 from the source' });
    expect(t.warnings).toEqual(['Price update failed, keeping the prices stored so far']);
    // The next run starts again at the hour that failed.
    t.failWith(undefined);
    await t.run();
    expect(t.paths[8]).toBe(ts(H - 40 * HOUR));
    expect(t.hours()).toHaveLength(PRICE_CATCHUP_MAX);
    expect(t.state()).toMatchObject({ lastError: null });
  });

  it.each([
    ['a format error', () => ({ data: {}, timestamp: 0 }), 'unexpected format'],
    ['too few items', (hourMs: number) => hourResponse(hourMs, {}, 3), 'usable items'],
    ['another hour', (hourMs: number) => hourResponse(hourMs + HOUR), 'another hour'],
    ['an unexpected error', () => new Error('boom secret'), 'Unexpected error, see the server log'],
    ['a disabled source', () => new ExternalDisabledError('WIKI_PRICES'), 'Unexpected error'],
  ])('stores nothing for %s and shows only its own message', async (_name, reply, message) => {
    const t = setup();
    t.failWith(reply);
    expect(await t.run()).toBe(0);
    expect(t.paths).toHaveLength(1);
    expect(t.hours()).toEqual([]);
    expect(t.state()?.lastError).toContain(message);
    expect(t.state()?.lastError).not.toContain('secret');
  });

  it('ends between requests when stopped', async () => {
    const t = setup();
    let left = 3;
    expect(await t.run(() => left-- <= 0)).toBe(3);
    expect(t.paths).toHaveLength(3);
  });

  it('warns when an item was left out for its size', async () => {
    const t = setup();
    t.failWith((hourMs) =>
      hourMs === H ? hourResponse(hourMs, { 4151: { high: [MAX_HOUR_SUM, 9] } }) : undefined,
    );
    await t.run();
    expect(t.warnings).toEqual(['Price items left out of an hour: their sums were too large']);
    expect(FILLER_FROM).toBeGreaterThan(4151);
  });
});
