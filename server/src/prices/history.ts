import { PRICE_MOVER_PERIODS, type PriceMoverPeriod } from '@fireside/shared';
import { and, count, eq, gte, lt, lte, max, sql } from 'drizzle-orm';
import type { Queryable } from '../db/index.js';
import { priceDayHours, priceDays, priceHourFetches, priceHours } from '../db/schema.js';
import { newestStoredHour } from './fetch.js';
import { windowPrice, type TradeSums } from './rule.js';

// Price windows over the stored `/1h` buckets (prices/fetch.ts), for bank
// values and Price movers. Everything counts from the end of the newest
// stored hour, not from the clock: the change is between two known windows
// also when the newest one is old. See
// docs/decisions/0021-prices-from-hourly-volume-weighted-averages.md.

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** Hours in the current window, and in the 24 h baseline before it. */
export const PRICE_WINDOW_HOURS = 24;

/** Days of the first fallback, for items without trades in the current window. */
export const PRICE_FALLBACK_DAYS = 7;

/** How far back each period compares: 24 h with the hours before, 7 d and 30 d with a UTC day. */
export const PRICE_MOVER_AGO_MS: Record<PriceMoverPeriod, number> = {
  '24h': DAY_MS,
  '7d': 7 * DAY_MS,
  '30d': 30 * DAY_MS,
};

const iso = (ms: number) => new Date(ms).toISOString();
const isoDay = (ms: number) => iso(ms).slice(0, 10);

const sums = {
  highValue: sql<number>`sum(high_value)`,
  highVolume: sql<number>`sum(high_volume)`,
  lowValue: sql<number>`sum(low_value)`,
  lowVolume: sql<number>`sum(low_volume)`,
};

function pricesOf(rows: readonly (TradeSums & { itemId: number })[]): Map<number, number> {
  const byItem = new Map<number, number>();
  for (const row of rows) {
    const each = windowPrice(row);
    if (each !== null) byItem.set(row.itemId, each);
  }
  return byItem;
}

/** The price of every item traded in the hours [`fromMs`, `toMs`). */
export function hourWindowPrices(db: Queryable, fromMs: number, toMs: number): Map<number, number> {
  return pricesOf(
    db
      .select({ itemId: priceHours.itemId, ...sums })
      .from(priceHours)
      .where(and(gte(priceHours.hourStart, iso(fromMs)), lt(priceHours.hourStart, iso(toMs))))
      .groupBy(priceHours.itemId)
      .all(),
  );
}

/** How many hours in [`fromMs`, `toMs`) are stored. */
export function storedHours(db: Queryable, fromMs: number, toMs: number): number {
  return (
    db
      .select({ n: count() })
      .from(priceHourFetches)
      .where(
        and(
          gte(priceHourFetches.hourStart, iso(fromMs)),
          lt(priceHourFetches.hourStart, iso(toMs)),
        ),
      )
      .get()?.n ?? 0
  );
}

/** The price of every item traded on the UTC days from `fromDay` to `toDay`, both included. */
function dayWindowPrices(db: Queryable, fromDay: string, toDay: string): Map<number, number> {
  return pricesOf(
    db
      .select({ itemId: priceDays.itemId, ...sums })
      .from(priceDays)
      .where(and(gte(priceDays.day, fromDay), lte(priceDays.day, toDay)))
      .groupBy(priceDays.itemId)
      .all(),
  );
}

/** Each item's price on the newest stored UTC day it traded. */
function lastDayPrices(db: Queryable): Map<number, number> {
  const newest = db
    .select({ itemId: priceDays.itemId, day: max(priceDays.day).as('newest_day') })
    .from(priceDays)
    .groupBy(priceDays.itemId)
    .as('newest');
  return pricesOf(
    db
      .select({
        itemId: priceDays.itemId,
        highValue: priceDays.highValue,
        highVolume: priceDays.highVolume,
        lowValue: priceDays.lowValue,
        lowVolume: priceDays.lowVolume,
      })
      .from(priceDays)
      .innerJoin(newest, and(eq(priceDays.itemId, newest.itemId), eq(priceDays.day, newest.day)))
      .all(),
  );
}

/** Where a current price comes from, best first. */
export type CurrentPriceFrom = 'HOURS' | 'WEEK' | 'LAST_DAY';

export interface CurrentWindow {
  /** End of the newest stored hour (epoch ms): the current window is the 24 hours before it. */
  endMs: number;
  /** Whether all 24 hours of the current window are stored. */
  complete: boolean;
  /** Items traded in the current window: the only prices Price movers compares. */
  hours: Map<number, number>;
  /** Every item with a price, and where it comes from. */
  prices: Map<number, { each: number; from: CurrentPriceFrom }>;
}

/** The last window per database, with the stored state it was computed from. */
const cache = new WeakMap<Queryable, { key: string; window: CurrentWindow | null }>();

/**
 * The current prices: the 24 h window up to the newest stored hour; for an
 * item without trades in it, the last 7 UTC days; then its newest day with
 * trades in the 35 kept. `null` while nothing is stored. Bank reads come in
 * groups (bank, summary, movers, potion storage), so the result is kept
 * until another hour is stored.
 */
export function currentWindow(db: Queryable): CurrentWindow | null {
  const state = db
    .select({
      newest: max(priceHourFetches.hourStart),
      stored: max(priceHourFetches.fetchedAt),
      hours: count(),
    })
    .from(priceHourFetches)
    .get();
  const days = db
    .select({ n: count(), hours: sql<number>`sum(hours)` })
    .from(priceDayHours)
    .get();
  const key = JSON.stringify([state, days]);
  const cached = cache.get(db);
  if (cached?.key === key) return cached.window;

  const newest = newestStoredHour(db);
  let window: CurrentWindow | null = null;
  if (newest !== null) {
    const endMs = newest + HOUR_MS;
    const fromMs = endMs - PRICE_WINDOW_HOURS * HOUR_MS;
    const hours = hourWindowPrices(db, fromMs, endMs);
    const lastDay = isoDay(newest);
    const week = dayWindowPrices(db, isoDay(newest - (PRICE_FALLBACK_DAYS - 1) * DAY_MS), lastDay);
    const prices = new Map<number, { each: number; from: CurrentPriceFrom }>();
    for (const [itemId, each] of lastDayPrices(db)) prices.set(itemId, { each, from: 'LAST_DAY' });
    for (const [itemId, each] of week) prices.set(itemId, { each, from: 'WEEK' });
    for (const [itemId, each] of hours) prices.set(itemId, { each, from: 'HOURS' });
    window = {
      endMs,
      complete: storedHours(db, fromMs, endMs) === PRICE_WINDOW_HOURS,
      hours,
      prices,
    };
  }
  cache.set(db, { key, window });
  return window;
}

/**
 * The UTC day a 7 d or 30 d period compares with: the one whose middle is
 * nearest to the middle of the current window, `agoMs` earlier. The period
 * is then its label ± 12 hours.
 */
export function baselineDay(endMs: number, agoMs: number): string {
  const target = endMs - (PRICE_WINDOW_HOURS * HOUR_MS) / 2 - agoMs;
  return isoDay(target);
}

export interface PriceBaseline {
  period: PriceMoverPeriod;
  /** End of the window compared with. */
  baselineAt: string;
  priceOf: Map<number, number>;
}

/**
 * The periods that have a baseline, shortest first. None while the current
 * window has a missing hour. 24 h needs all 24 hours before it; 7 d and 30 d
 * need all 24 hours of their UTC day. A period without one is left out,
 * never compared with an incomplete window.
 */
export function priceBaselines(db: Queryable, window: CurrentWindow): PriceBaseline[] {
  if (!window.complete) return [];
  const baselines: PriceBaseline[] = [];
  for (const period of PRICE_MOVER_PERIODS) {
    const agoMs = PRICE_MOVER_AGO_MS[period];
    if (period === '24h') {
      const toMs = window.endMs - agoMs;
      const fromMs = toMs - PRICE_WINDOW_HOURS * HOUR_MS;
      if (storedHours(db, fromMs, toMs) !== PRICE_WINDOW_HOURS) continue;
      baselines.push({
        period,
        baselineAt: iso(toMs),
        priceOf: hourWindowPrices(db, fromMs, toMs),
      });
      continue;
    }
    const day = baselineDay(window.endMs, agoMs);
    const hours = db
      .select({ hours: priceDayHours.hours })
      .from(priceDayHours)
      .where(eq(priceDayHours.day, day))
      .get()?.hours;
    if (hours !== PRICE_WINDOW_HOURS) continue;
    baselines.push({
      period,
      baselineAt: iso(Date.parse(`${day}T00:00:00.000Z`) + DAY_MS),
      priceOf: dayWindowPrices(db, day, day),
    });
  }
  return baselines;
}
