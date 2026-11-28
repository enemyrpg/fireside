import type { Db } from '../db/index.js';
import { recordSuccess } from '../external/state.js';
import { MIN_PRICE_ITEMS, parseHourBucket, storeHourBucket } from './fetch.js';

// Small hand-made `/1h` responses for tests, in the shape the wiki gives
// (prices/fetch.ts). Synthetic numbers only: never copied wiki data.

export const HOUR = 60 * 60 * 1000;
export const DAY = 24 * HOUR;

/** One side's trades in an hour: [average price, volume]. */
export type Side = readonly [avg: number, volume: number];

export interface Trades {
  high?: Side;
  low?: Side;
}

/** IDs of the filler items every response has, so it is a full hour. */
export const FILLER_FROM = 900_000;

/** The JSON of `/1h` for the hour starting at `hourMs`, with `items` and the filler. */
export function hourResponse(
  hourMs: number,
  items: Readonly<Record<number, Trades>> = {},
  filler = MIN_PRICE_ITEMS,
): { data: Record<string, unknown>; timestamp: number } {
  const data: Record<string, unknown> = {};
  for (let i = 0; i < filler; i++) {
    data[String(FILLER_FROM + i)] = {
      avgHighPrice: 11,
      highPriceVolume: 1,
      avgLowPrice: 9,
      lowPriceVolume: 1,
    };
  }
  for (const [id, { high, low }] of Object.entries(items)) {
    data[id] = {
      avgHighPrice: high?.[0] ?? null,
      highPriceVolume: high?.[1] ?? 0,
      avgLowPrice: low?.[0] ?? null,
      lowPriceVolume: low?.[1] ?? 0,
    };
  }
  return { data, timestamp: hourMs / 1000 };
}

/**
 * Stores the hour starting at `hourMs` as a successful fetch would, and
 * records the success at `fetchedAtMs` (default: 15 minutes after the hour).
 */
export function storeHour(
  db: Db,
  hourMs: number,
  items: Readonly<Record<number, Trades>> = {},
  fetchedAtMs = hourMs + HOUR + 15 * 60 * 1000,
): void {
  storeHourBucket(db, parseHourBucket(hourResponse(hourMs, items), hourMs), new Date(fetchedAtMs));
  recordSuccess(db, 'WIKI_PRICES', new Date(fetchedAtMs));
}

/** Stores `count` consecutive hours from `firstHourMs`, each with `itemsAt(hourMs)`. */
export function storeHours(
  db: Db,
  firstHourMs: number,
  count: number,
  itemsAt: (hourMs: number) => Readonly<Record<number, Trades>> = () => ({}),
): void {
  for (let i = 0; i < count; i++) {
    const hourMs = firstHourMs + i * HOUR;
    storeHour(db, hourMs, itemsAt(hourMs));
  }
}
