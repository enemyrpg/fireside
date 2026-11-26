import { afterEach, describe, expect, it } from 'vitest';
import type { Database } from '../db/index.js';
import { itemPriceHistory, itemPrices } from '../db/schema.js';
import { PRICES_HISTORY_INTERVAL_MS } from '../jobs/prices.js';
import { testDatabase } from '../test-utils.js';
import { PRICES_INTERVAL_MS, storePrices } from './fetch.js';
import {
  baselineFetch,
  PRICE_HISTORY_DAILY_FETCHES,
  PRICE_HISTORY_HOURLY_FETCHES,
  PRICE_MOVER_WINDOWS,
  priceBaselines,
  pricesOfFetch,
  prunePriceHistory,
} from './history.js';

// The price history is written by `storePrices`, whatever caused the fetch.
// Retention counts fetches and never looks at the clock, and baselines do not
// assume one fetch an hour: the tests feed fetches at irregular times
// (on-demand fetching) and with a wrong clock.

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const at = (iso: string) => new Date(iso);

describe('price history', () => {
  let database: Database | undefined;
  afterEach(() => {
    database?.close();
    database = undefined;
  });

  function setup() {
    database = testDatabase();
    const db = database.db;
    /** One fetch of two items; the price says when it was fetched. */
    const fetch = (iso: string, price = 100) => {
      storePrices(
        db,
        [
          { itemId: 4151, high: price + 10, highTime: iso, low: price - 10, lowTime: iso },
          { itemId: 11832, high: null, highTime: null, low: price * 2, lowTime: iso },
        ],
        at(iso),
      );
    };
    /** As `fetch`, returning what `storePrices` reports (a skipped prune, or `null`). */
    const store = (iso: string) =>
      storePrices(db, [{ itemId: 4151, high: 110, highTime: iso, low: 90, lowTime: iso }], at(iso));
    const times = () =>
      db
        .selectDistinct({ at: itemPriceHistory.fetchedAt })
        .from(itemPriceHistory)
        .orderBy(itemPriceHistory.fetchedAt)
        .all()
        .map((row) => row.at);
    const periods = (currentAt: string) =>
      priceBaselines(db, currentAt).map(({ period, baselineAt }) => ({ period, baselineAt }));
    return { db, fetch, store, times, periods };
  }

  it('stores every fetch next to the latest prices, with the same values', () => {
    const t = setup();
    t.fetch('2026-11-20T10:00:00.000Z', 100);
    t.fetch('2026-11-20T13:20:00.000Z', 150);
    expect(t.db.select().from(itemPrices).all()).toHaveLength(2);
    expect(t.db.select().from(itemPriceHistory).all()).toEqual([
      { fetchedAt: '2026-11-20T10:00:00.000Z', itemId: 4151, high: 110, low: 90, seq: 1 },
      { fetchedAt: '2026-11-20T10:00:00.000Z', itemId: 11832, high: null, low: 200, seq: 1 },
      { fetchedAt: '2026-11-20T13:20:00.000Z', itemId: 4151, high: 160, low: 140, seq: 2 },
      { fetchedAt: '2026-11-20T13:20:00.000Z', itemId: 11832, high: null, low: 300, seq: 2 },
    ]);
    // The same price rule as current prices: the midpoint, or the side there is.
    expect(pricesOfFetch(t.db, '2026-11-20T10:00:00.000Z')).toEqual(
      new Map([
        [4151, 100],
        [11832, 200],
      ]),
    );
  });

  /** `count` fetch times from `from`, `stepMs` apart. */
  const series = (from: string, count: number, stepMs = HOUR) =>
    Array.from({ length: count }, (_, i) => new Date(Date.parse(from) + i * stepMs).toISOString());
  /** The first fetch time of each UTC day. */
  const dayFirsts = (times: readonly string[]) =>
    times.filter((iso, i) => i === 0 || times[i - 1]?.slice(0, 10) !== iso.slice(0, 10));

  it('keeps the newest 48 fetches and the newest 35 first-of-a-UTC-day fetches', () => {
    const t = setup();
    // 40 days of hourly fetches, starting mid-day.
    const all = series('2026-10-12T09:20:00.000Z', 40 * 24);
    for (const iso of all) t.fetch(iso);
    const kept = t.times();
    const hourly = all.slice(-PRICE_HISTORY_HOURLY_FETCHES);
    const daily = dayFirsts(all).slice(-PRICE_HISTORY_DAILY_FETCHES);
    expect(daily).toHaveLength(35);
    expect(kept).toEqual([...new Set([...daily, ...hourly])].sort());
    // The last two days' first fetches are among the 48 as well.
    expect(kept).toHaveLength(48 + 35 - 2);
    // Each kept fetch still has every item, and pruning again changes nothing.
    expect(t.db.select().from(itemPriceHistory).all()).toHaveLength(kept.length * 2);
    expect(prunePriceHistory(t.db)).toBe(0);
  });

  it('deletes no more for 10 fetches on a clock two months ahead than for 10 normal ones', () => {
    // A month and a half of hourly fetches, then 10 more: as usual in one
    // database, stamped two months ahead in the other. Both cross one midnight.
    const base = series('2026-10-05T00:20:00.000Z', 46 * 24 + 21);
    expect(base.at(-1)).toBe('2026-11-20T20:20:00.000Z');
    const run = (more: readonly string[]) => {
      const t = setup();
      for (const iso of base) t.fetch(iso);
      const before = t.times();
      for (const iso of more) t.fetch(iso);
      const after = new Set(t.times());
      const deleted = before.filter((iso) => !after.has(iso));
      database?.close();
      database = undefined;
      return { before, deleted, after: [...after] };
    };
    const normal = run(series('2026-11-20T21:20:00.000Z', 10));
    const ahead = run(series('2027-01-20T21:20:00.000Z', 10));
    // 10 normal fetches a day apart, for the most 10 fetches can push out.
    const daily = run(series('2026-11-21T20:20:00.000Z', 10, DAY));

    // One stored fetch pushes out at most one of the 48 and one of the 35.
    // Hourly: nine of the 48 (the tenth is the first of its day, so it stays
    // as a daily) and one daily for the new UTC day.
    expect(normal.deleted).toHaveLength(10);
    // The jump itself starts one more UTC day, so one more daily goes: 11.
    expect(ahead.deleted).toHaveLength(11);
    expect(ahead.deleted.length).toBeLessThanOrEqual(daily.deleted.length);
    expect(daily.deleted).toHaveLength(19);
    // Everything else real is still there: 33 of the 35 daily fetches and
    // 38 of the 48 newest. By age every real fetch would have been deleted.
    const real = ahead.after.filter((iso) => iso < '2027');
    expect(real).toHaveLength(ahead.before.length - 11);
    expect(dayFirsts(real)).toHaveLength(33);
    expect(real.filter((iso) => iso > '2026-11-19T06:20:00.000Z')).toHaveLength(38);
  });

  it('keeps real fetches again right after a clock that was ahead for 60 fetches, and 24 h is back after a real day', () => {
    const t = setup();
    // Three days of real hourly fetches.
    const real = series('2026-11-10T00:20:00.000Z', 72);
    for (const iso of real) t.fetch(iso);
    // The clock is two months ahead for 60 fetches: more than the 48 kept.
    for (const iso of series('2027-01-13T00:20:00.000Z', 60)) t.fetch(iso);
    // Every one of the 48 most recently stored is stamped ahead now.
    expect(t.times().filter((iso) => iso > '2027')).toHaveLength(48 + 1);
    // The real days are all still there as daily fetches.
    expect(t.times().filter((iso) => iso < '2027')).toEqual([
      '2026-11-10T00:20:00.000Z',
      '2026-11-11T00:20:00.000Z',
      '2026-11-12T00:20:00.000Z',
    ]);

    // The clock is put right, 60 real hours after the last real fetch.
    const corrected = series('2026-11-15T12:20:00.000Z', 50);
    /** The 24 h baseline as of the fetch at `iso`, if there is one. */
    const dayBaseline = (iso: string) =>
      t.periods(iso).find(({ period }) => period === '24h')?.baselineAt;
    corrected.forEach((iso, hour) => {
      t.fetch(iso);
      // Every real fetch since the correction is kept from then on (up to the
      // 48 kept anyway), though all of them are older than the stamped ones.
      const kept = t.times().filter((time) => time >= '2026-11-15T12:20:00.000Z' && time < '2027');
      const newest = corrected.slice(Math.max(0, hour + 1 - 48), hour + 1);
      expect(kept, iso).toEqual(expect.arrayContaining(newest));
      // Beyond 48, only the first fetch of the day of the correction stays, as a daily.
      expect(
        kept.filter((time) => !newest.includes(time)),
        iso,
      ).toEqual(hour < 48 ? [] : ['2026-11-15T12:20:00.000Z']);
      // 24 h needs a real fetch from about a day before. The last one before
      // the correction is 60 hours back, so it returns 22 real hours after
      // the correction (2 hours after the target is in reach), then stays:
      // not after two months.
      expect(dayBaseline(iso), iso).toBe(hour < 22 ? undefined : corrected[Math.max(0, hour - 24)]);
    });
    // 7 d reaches the real daily fetches from before the wrong clock.
    expect(t.periods(corrected[49] ?? '')).toEqual([
      { period: '24h', baselineAt: corrected[25] },
      { period: '7d', baselineAt: '2026-11-10T00:20:00.000Z' },
    ]);
    // The stamped fetches were pushed out by count, as any 50 fetches would
    // push out older ones: the last 48 stored are all real, and the stamped
    // ones left are first fetches of their UTC days.
    expect(t.times().filter((iso) => iso > '2027')).toEqual([
      '2027-01-13T00:20:00.000Z',
      '2027-01-14T00:20:00.000Z',
      '2027-01-15T00:20:00.000Z',
    ]);
    // Nothing is ever compared with them: a baseline is before the current fetch.
    expect(t.db.select().from(itemPriceHistory).all()).toHaveLength(t.times().length * 2);
  });

  it('keeps 35 daily fetches through a 10-day outage', () => {
    const t = setup();
    const before = series('2026-10-01T00:20:00.000Z', 40 * 24);
    for (const iso of before) t.fetch(iso);
    const daily = () => dayFirsts(t.times());
    expect(daily()).toHaveLength(35);
    expect(before.at(-1)).toBe('2026-11-09T23:20:00.000Z');
    // The server is off for 10 days, then fetches hourly again.
    const after = series('2026-11-20T03:20:00.000Z', 30);
    for (const iso of after) {
      t.fetch(iso);
      expect(daily(), iso).toHaveLength(35);
    }
    // Two new days pushed out the two oldest. By age (35 days before the
    // newest fetch) the nine before 17 October would be gone as well.
    expect(daily()[0]).toBe('2026-10-08T00:20:00.000Z');
    expect(daily().filter((iso) => iso < '2026-10-17')).toHaveLength(9);
    expect(daily().slice(-3)).toEqual([
      '2026-11-09T00:20:00.000Z',
      '2026-11-20T03:20:00.000Z',
      '2026-11-21T00:20:00.000Z',
    ]);
  });

  it('never keeps more than 48 + 35 fetch times, however irregular the fetches', () => {
    const t = setup();
    const times = [
      // Several a day at odd times, for 60 days …
      ...Array.from({ length: 60 }, (_, day) =>
        [0.2, 3.7, 4.1, 11, 11.4, 19.9, 23.8].map((hour) =>
          new Date(Date.parse('2026-06-01T00:00:00.000Z') + day * DAY + hour * HOUR).toISOString(),
        ),
      ).flat(),
      // … then one every 3 days, for 150 days.
      ...series('2026-08-01T10:00:00.000Z', 50, 3 * DAY),
    ];
    let most = 0;
    for (const iso of times) {
      t.fetch(iso);
      most = Math.max(most, t.times().length);
      expect(t.times().length, iso).toBeLessThanOrEqual(
        PRICE_HISTORY_HOURLY_FETCHES + PRICE_HISTORY_DAILY_FETCHES,
      );
    }
    // The bound is reached while there are several fetches a day …
    expect(most).toBeGreaterThan(70);
    // … and with one fetch every 3 days the newest 48 are all there is to keep.
    expect(t.times()).toEqual(times.slice(-48));
  });

  it('reports a fetch more than a day after the one stored before it, or before it, and stores it', () => {
    const t = setup();
    expect(t.store('2026-11-10T05:00:00.000Z')).toBeNull();
    // Exactly one day later is fine; a moment more is reported.
    expect(t.store('2026-11-11T05:00:00.000Z')).toBeNull();
    expect(t.store('2026-11-12T05:00:00.001Z')).toEqual({
      fetchedAt: '2026-11-12T05:00:00.001Z',
      previousAt: '2026-11-11T05:00:00.000Z',
    });
    // The clock went back: any time before the previous one.
    expect(t.store('2026-11-12T04:59:00.000Z')).toEqual({
      fetchedAt: '2026-11-12T04:59:00.000Z',
      previousAt: '2026-11-12T05:00:00.001Z',
    });
    // Reported or not, each one is stored.
    expect(t.times()).toHaveLength(4);
  });

  it('shows a period only while a stored fetch is near enough to that long ago', () => {
    const t = setup();
    const now = '2026-11-21T12:00:00.000Z';
    // Nothing but the current fetch: no period.
    t.fetch(now);
    expect(t.periods(now)).toEqual([]);

    database?.close();
    const u = setup();
    for (const iso of [
      '2026-10-21T20:00:00.000Z', // 30 d 16 h ago: within 26 h before 30 days
      '2026-11-13T00:10:00.000Z', // 8 d 12 h ago: more than 26 h before 7 days (the 14th is missing)
      '2026-11-20T15:30:00.000Z', // 20 h 30 min ago: more than 2 h after 24 hours
      '2026-11-21T05:00:00.000Z',
      now,
    ]) {
      u.fetch(iso);
    }
    expect(u.periods(now)).toEqual([{ period: '30d', baselineAt: '2026-10-21T20:00:00.000Z' }]);

    // Three hours later the fetch of the 20th is 23 h 30 min before the newest one.
    const later = '2026-11-21T15:00:00.000Z';
    u.fetch(later);
    expect(u.periods(later)).toEqual([
      { period: '24h', baselineAt: '2026-11-20T15:30:00.000Z' },
      { period: '30d', baselineAt: '2026-10-21T20:00:00.000Z' },
    ]);
  });

  it('reaches 26 hours back from the target but only 2 hours forward, never to the current fetch', () => {
    const t = setup();
    t.fetch('2026-11-14T02:00:00.000Z');
    t.fetch('2026-11-15T00:30:00.000Z');
    t.fetch('2026-11-21T12:00:00.000Z');
    const reach = PRICE_MOVER_WINDOWS['7d'];
    expect(reach).toMatchObject({ earlierMs: 26 * HOUR, laterMs: 2 * HOUR });
    const current = '2026-11-21T12:00:00.000Z';
    const target = Date.parse('2026-11-14T12:00:00.000Z');
    // 10 h before the target; the one 12 h 30 min after it is out of reach.
    expect(baselineFetch(t.db, target, reach, current)).toBe('2026-11-14T02:00:00.000Z');
    // 21 h before against 1 h 30 min after: the nearer one.
    expect(baselineFetch(t.db, target + 11 * HOUR, reach, current)).toBe(
      '2026-11-15T00:30:00.000Z',
    );
    // 25 h before: still in reach.
    expect(baselineFetch(t.db, Date.parse('2026-11-16T01:30:00.000Z'), reach, current)).toBe(
      '2026-11-15T00:30:00.000Z',
    );
    // 3 h after the target, or 26 h 30 min before it: neither.
    expect(baselineFetch(t.db, Date.parse('2026-11-13T23:00:00.000Z'), reach, current)).toBeNull();
    expect(baselineFetch(t.db, Date.parse('2026-11-16T03:00:00.000Z'), reach, current)).toBeNull();
    // The current fetch is never its own baseline, however near.
    expect(baselineFetch(t.db, Date.parse(current) - HOUR, reach, current)).toBeNull();
  });

  it('never shows a period much shorter than its label on a fresh instance', () => {
    const t = setup();
    const first = Date.parse('2026-11-14T06:00:00.000Z');
    // Hourly from the first fetch on.
    const until = first + 7 * DAY + HOUR;
    for (let ms = first; ms <= until; ms += HOUR) t.fetch(new Date(ms).toISOString());
    const periodsAt = (ms: number) =>
      t.periods(new Date(ms).toISOString()).map(({ period }) => period);
    // 6 d 6 h after the first fetch: 18 h short of a week, so no "7 d".
    expect(periodsAt(first + 6 * DAY + 6 * HOUR)).toEqual(['24h']);
    // Still none 3 h short.
    expect(periodsAt(first + 7 * DAY - 3 * HOUR)).toEqual(['24h']);
    // At 7 days the first fetch is the baseline.
    expect(t.periods(new Date(first + 7 * DAY).toISOString())).toEqual([
      { period: '24h', baselineAt: new Date(first + 6 * DAY).toISOString() },
      { period: '7d', baselineAt: '2026-11-14T06:00:00.000Z' },
    ]);
  });

  it('follows 24 hours, 7 days and 30 days of hourly fetches, at every hour of the day', () => {
    const t = setup();
    const start = Date.parse('2026-10-20T00:20:00.000Z');
    const end = Date.parse('2026-11-21T12:20:00.000Z');
    for (let ms = start; ms <= end; ms += HOUR) t.fetch(new Date(ms).toISOString());
    // The newest 48 fetches, and the first of each of the 31 days before them.
    const times = t.times();
    expect(times.filter((iso) => Date.parse(iso) > end - 48 * HOUR)).toHaveLength(48);
    expect(times).toHaveLength(48 + 31);
    expect(t.periods(new Date(end).toISOString())).toEqual([
      { period: '24h', baselineAt: '2026-11-20T12:20:00.000Z' },
      // 12 h before the target; the next day's first fetch is 12 h after it, out of reach.
      { period: '7d', baselineAt: '2026-11-14T00:20:00.000Z' },
      { period: '30d', baselineAt: '2026-10-22T00:20:00.000Z' },
    ]);
    // One fetch per day is always in reach: no hour of the day loses 7 d or 30 d.
    for (let hour = 0; hour < 24; hour++) {
      const current = new Date(end - hour * HOUR).toISOString();
      expect(
        t.periods(current).map(({ period }) => period),
        current,
      ).toEqual(['24h', '7d', '30d']);
    }
  });
  /**
   * 40 days as the price job fetches (jobs/prices.ts), checked every minute: on
   * a read when the last fetch is an hour old, and with `historyMs`, whenever
   * the last fetch is that old. Reads come at random times, 0–6 a day.
   * Returns the time of each whole hour from day 32 on (30 days and the 26 hours before them exist) with the periods shown
   * then, counted from the newest fetch.
   */
  function simulate(historyMs: number | null) {
    const t = setup();
    const start = Date.parse('2026-10-01T00:00:00.000Z');
    let seed = 13;
    const random = () => (seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31) / 2 ** 31;
    const reads = new Set<number>();
    for (let day = 0; day < 40; day++) {
      const count = Math.floor(random() * 7);
      for (let i = 0; i < count; i++) {
        reads.add(start + day * DAY + Math.floor(random() * 24 * 60) * MINUTE);
      }
    }
    let last = -Infinity;
    const checks: { at: number; current: number; periods: ReturnType<typeof priceBaselines> }[] =
      [];
    for (let ms = start; ms < start + 40 * DAY; ms += MINUTE) {
      const since = ms - last;
      if (
        (historyMs !== null && since >= historyMs) ||
        (reads.has(ms) && since >= PRICES_INTERVAL_MS)
      ) {
        t.fetch(new Date(ms).toISOString());
        last = ms;
      }
      if (ms >= start + 32 * DAY && ms % HOUR === 0) {
        checks.push({
          at: ms,
          current: last,
          periods: priceBaselines(t.db, new Date(last).toISOString()),
        });
      }
    }
    return checks;
  }

  /** Every baseline is within its period's reach of the time it stands for. */
  function expectInReach(checks: ReturnType<typeof simulate>) {
    for (const { current, periods } of checks) {
      for (const { period, baselineAt } of periods) {
        const { agoMs, earlierMs, laterMs } = PRICE_MOVER_WINDOWS[period];
        const offset = Date.parse(baselineAt) - (current - agoMs);
        expect(offset, `${period} at ${new Date(current).toISOString()}`).toBeGreaterThanOrEqual(
          -earlierMs,
        );
        expect(offset, `${period} at ${new Date(current).toISOString()}`).toBeLessThanOrEqual(
          laterMs,
        );
      }
    }
  }

  it('shows 24 hours, 7 days and 30 days at every hour with on-demand fetches and the history fetch', () => {
    const checks = simulate(PRICES_HISTORY_INTERVAL_MS);
    expect(checks).toHaveLength(8 * 24);
    for (const { at, periods } of checks) {
      expect(
        periods.map(({ period }) => period),
        new Date(at).toISOString(),
      ).toEqual(['24h', '7d', '30d']);
    }
    expectInReach(checks);
  });

  it('leaves periods out without the history fetch, but never compares with a fetch out of reach', () => {
    const checks = simulate(null);
    const shown = (period: string) =>
      checks.filter(({ periods }) => periods.some((baseline) => baseline.period === period)).length;
    // Reads alone rarely fall a day apart within two hours.
    expect(shown('24h')).toBeLessThan(checks.length / 2);
    expectInReach(checks);
  });
});
