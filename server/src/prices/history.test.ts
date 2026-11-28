import { afterEach, describe, expect, it } from 'vitest';
import type { Database } from '../db/index.js';
import { testDatabase } from '../test-utils.js';
import {
  baselineDay,
  currentWindow,
  PRICE_MOVER_AGO_MS,
  priceBaselines,
  type CurrentWindow,
} from './history.js';
import { DAY, HOUR, storeHour, storeHours, type Trades } from './testing.js';

// Windows over stored hours and days. Synthetic trades only (prices/testing.ts).

const WHIP = 4151;
const SUPERMIX = 11_433;
const BOW = 20_997;

describe('price windows', () => {
  let database: Database | undefined;
  afterEach(() => {
    database?.close();
    database = undefined;
  });
  const setup = () => (database = testDatabase()).db;

  /** The current window; the test fails if there is none. */
  const windowOf = (db: Parameters<typeof currentWindow>[0]): CurrentWindow => {
    const window = currentWindow(db);
    if (window === null) throw new Error('no window');
    return window;
  };
  const periods = (db: Parameters<typeof currentWindow>[0]) =>
    priceBaselines(db, windowOf(db)).map(({ period, baselineAt }) => ({ period, baselineAt }));

  const E = Date.parse('2026-11-20T15:00:00.000Z');

  it('has no window before any hour is stored', () => {
    const db = setup();
    expect(currentWindow(db)).toBeNull();
  });

  it('prices each item over the 24 hours up to the newest stored one', () => {
    const db = setup();
    // 23 hours at 100, then the newest at 200: hours before the window are not counted.
    storeHour(db, E - 30 * HOUR, { [WHIP]: { low: [1_000_000, 1] } });
    storeHours(db, E - 24 * HOUR, 23, () => ({ [WHIP]: { low: [100, 1] } }));
    storeHour(db, E - HOUR, { [WHIP]: { low: [200, 1] } });
    const window = windowOf(db);
    expect(window.endMs).toBe(E);
    expect(window.complete).toBe(true);
    // (23 × 100 + 200) ÷ 24 = 104.17
    expect(window.prices.get(WHIP)).toEqual({ each: 104, from: 'HOURS' });
    expect(window.hours.get(WHIP)).toBe(104);
  });

  it('keeps an illiquid item near its price when one side was stale and one odd trade comes in', () => {
    const db = setup();
    // Insta-sells around 2K for a day; no insta-buys at all (the stale side
    // is not in `/1h`, so it plays no part).
    const sells = (hourMs: number): Record<number, Trades> => ({
      [SUPERMIX]: { low: [1_800 + ((hourMs / HOUR) % 5) * 100, 3] },
    });
    storeHours(db, E - 24 * HOUR, 24, sells);
    const before = windowOf(db).prices.get(SUPERMIX)?.each ?? 0;
    expect(before).toBeGreaterThan(1_800);
    expect(before).toBeLessThan(2_300);
    // Then one insta-buy at 821 750 and a few more at 73K in the next hours.
    storeHour(db, E, { [SUPERMIX]: { high: [821_750, 1], low: [2_000, 3] } });
    storeHour(db, E + HOUR, { [SUPERMIX]: { high: [73_000, 9], low: [1_900, 3] } });
    const after = windowOf(db).prices.get(SUPERMIX)?.each ?? 0;
    // The side with more trades wins: no −95 % / +36 000 % move.
    expect(Math.abs(after - before) / before).toBeLessThan(0.1);
  });

  it('keeps an expensive liquid item stable between fetches', () => {
    const db = setup();
    // About 200 trades a day, both sides, ±5M around 1.5B from hour to hour.
    const bow = (hourMs: number): Record<number, Trades> => {
      const swing = (((hourMs / HOUR) % 3) - 1) * 5_000_000;
      return {
        [BOW]: { high: [1_505_000_000 + swing, 4], low: [1_495_000_000 - swing, 4] },
      };
    };
    storeHours(db, E - 24 * HOUR, 24, bow);
    const prices: number[] = [windowOf(db).prices.get(BOW)?.each ?? 0];
    for (let i = 0; i < 6; i++) {
      // One hour with a single odd insta-buy 30M above the rest.
      const odd: Record<number, Trades> =
        i === 2
          ? { [BOW]: { high: [1_530_000_000, 1], low: [1_495_000_000, 4] } }
          : bow(E + i * HOUR);
      storeHour(db, E + i * HOUR, odd);
      prices.push(windowOf(db).prices.get(BOW)?.each ?? 0);
    }
    for (let i = 1; i < prices.length; i++) {
      const move = Math.abs((prices[i] ?? 0) - (prices[i - 1] ?? 0)) / (prices[i - 1] ?? 1);
      expect(move).toBeLessThan(0.001);
    }
  });

  it('falls back to the last 7 days, then the newest day with trades, for items without trades now', () => {
    const db = setup();
    // 10 days ago: two items traded.
    storeHour(db, E - 10 * DAY, { 1: { low: [500, 1] }, 2: { low: [700, 1] } });
    // 3 days ago: only item 1, at another price.
    storeHour(db, E - 3 * DAY, { 1: { low: [300, 1] } });
    // The last day: item 3 only.
    storeHours(db, E - 24 * HOUR, 24, () => ({ 3: { high: [40, 1] } }));
    const { prices } = windowOf(db);
    expect(prices.get(3)).toEqual({ each: 40, from: 'HOURS' });
    expect(prices.get(1)).toEqual({ each: 300, from: 'WEEK' });
    expect(prices.get(2)).toEqual({ each: 700, from: 'LAST_DAY' });
    // Never traded in the 35 days: no price, so the snapshot price is used.
    expect(prices.get(4)).toBeUndefined();
  });

  it('shows 24 h only when both windows have all 24 hours', () => {
    const db = setup();
    storeHours(db, E - 47 * HOUR, 47);
    expect(windowOf(db).complete).toBe(true);
    expect(periods(db)).toEqual([]);
    storeHour(db, E - 48 * HOUR);
    expect(periods(db)).toEqual([{ period: '24h', baselineAt: '2026-11-19T15:00:00.000Z' }]);
  });

  it('shows no period while the current window has a missing hour', () => {
    const db = setup();
    storeHours(db, E - 48 * HOUR, 48);
    storeHour(db, E + HOUR); // E itself is missing
    expect(windowOf(db).complete).toBe(false);
    expect(periods(db)).toEqual([]);
  });

  it('compares 7 d and 30 d with the UTC day nearest to the label, and only a complete one', () => {
    const db = setup();
    // Day 7 days before the window's middle (20 Nov 03:00 → 13 Nov), complete.
    expect(baselineDay(E, PRICE_MOVER_AGO_MS['7d'])).toBe('2026-11-13');
    storeHours(db, Date.parse('2026-11-13T00:00:00.000Z'), 24);
    // 30 days: 21 Oct, with one hour missing.
    expect(baselineDay(E, PRICE_MOVER_AGO_MS['30d'])).toBe('2026-10-21');
    storeHours(db, Date.parse('2026-10-21T00:00:00.000Z'), 23);
    storeHours(db, E - 48 * HOUR, 48);
    expect(periods(db)).toEqual([
      { period: '24h', baselineAt: '2026-11-19T15:00:00.000Z' },
      { period: '7d', baselineAt: '2026-11-14T00:00:00.000Z' },
    ]);
  });

  it('keeps 7 d and 30 d within 12 hours of their label at every hour of the day', () => {
    for (let hour = 0; hour < 24; hour++) {
      const endMs = E + hour * HOUR;
      for (const period of ['7d', '30d'] as const) {
        const agoMs = PRICE_MOVER_AGO_MS[period];
        const dayMiddle = Date.parse(`${baselineDay(endMs, agoMs)}T12:00:00.000Z`);
        const windowMiddle = endMs - 12 * HOUR;
        expect(Math.abs(windowMiddle - agoMs - dayMiddle)).toBeLessThanOrEqual(12 * HOUR);
      }
    }
  });

  it('after a gap: 24 h back once two windows are filled, 7 d missing exactly for the days lost', () => {
    const db = setup();
    const nov = (day: number, hour = 0) =>
      Date.parse('2026-11-01T00:00:00.000Z') + (day - 1) * DAY + hour * HOUR;
    const names = () => periods(db).map((row) => row.period);
    // 1–4 November complete; 5–7 November lost (more than 48 hours without
    // use); the catch-up then fills from 8 November.
    storeHours(db, nov(1), 4 * 24);
    storeHours(db, nov(8), 24);
    // 9 Nov 00:00: no 24 h yet (the window before is lost), but 7 d
    // compares the complete current day with 1 November.
    expect(names()).toEqual(['7d']);
    storeHours(db, nov(9), 24 + 14);
    // 10 Nov 14:00: two full windows, and 7 d compares with 3 November.
    expect(names()).toEqual(['24h', '7d']);
    storeHours(db, nov(10, 14), 24);
    // 11 Nov 14:00 → 4 November, complete.
    expect(names()).toEqual(['24h', '7d']);
    storeHours(db, nov(11, 14), 24);
    // 12 Nov 14:00 → 5 November, lost: 7 d is left out, never compared with a gap.
    expect(names()).toEqual(['24h']);
    storeHours(db, nov(12, 14), 3 * 24);
    // 15 Nov 14:00 → 8 November: back.
    expect(names()).toEqual(['24h', '7d']);
  });
});
