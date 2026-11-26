import { PRICE_MOVER_PERIODS, type PriceMoverPeriod } from '@fireside/shared';
import { asc, desc, eq, gt, inArray, lte, sql } from 'drizzle-orm';
import type { Queryable } from '../db/index.js';
import { itemPriceHistory } from '../db/schema.js';
import { inChunks } from '../projections/bank.js';
import { currentPrice } from '../read/prices.js';

// `item_price_history`: the prices of earlier fetches, for Price movers. Nothing here knows how
// often prices are fetched, and retention does not look at the clock or at the times at all: it
// keeps a number of fetches in the order they were stored, so a wrong clock can never delete more
// than the same number of ordinary fetches would, and real fetches are kept again as soon as the
// clock is right. A baseline is the stored fetch nearest to the time asked for, within reach of it,
// so fetches at irregular times (or on demand) only make a period come and go, never wrong.

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** The most recently stored fetches kept, whatever their times: 48 hours of hourly fetches. */
export const PRICE_HISTORY_HOURLY_FETCHES = 48;

/** The most recently stored first-fetches-of-a-UTC-day kept as well: 35 days of daily ones. */
export const PRICE_HISTORY_DAILY_FETCHES = 35;

/**
 * How far back each period looks, and how far from that time the stored fetch
 * compared against may be. Earlier is allowed generously, later hardly at
 * all, so a period is at most 2 hours shorter than its label: "7 d" on a
 * fresh instance first shows when the oldest fetch is (almost) 7 days old.
 * 24 hours is compared with the fetches of the last 48: the price job leaves
 * less than 4 hours between two (jobs/prices.ts), so one is always within 2
 * hours. 7 and 30 days are compared with the first fetch of each UTC day,
 * which lands between midnight and almost 4 hours after it, so two of them
 * can be up to about 28 hours apart: with 2 hours after the target allowed,
 * 26 hours before it keep one always in reach (a "7 d" baseline is then at
 * most 7 d 26 h old). See docs/decisions/0019-prices-fetched-on-demand.md.
 */
export const PRICE_MOVER_WINDOWS: Record<
  PriceMoverPeriod,
  { agoMs: number; earlierMs: number; laterMs: number }
> = {
  '24h': { agoMs: DAY_MS, earlierMs: 2 * HOUR_MS, laterMs: 2 * HOUR_MS },
  '7d': { agoMs: 7 * DAY_MS, earlierMs: 26 * HOUR_MS, laterMs: 2 * HOUR_MS },
  '30d': { agoMs: 30 * DAY_MS, earlierMs: 26 * HOUR_MS, laterMs: 2 * HOUR_MS },
};

/**
 * A fetch stamped more than this after the one stored before it, or any time
 * before it, is worth a warning: the server was off, or the clock is wrong.
 * It is stored and pruned like any other.
 */
export const PRICE_HISTORY_JUMP_MS = DAY_MS;

export interface HistoryPrice {
  itemId: number;
  high: number | null;
  low: number | null;
}

/** One stored fetch: its time and its place in the order the fetches were stored. */
export interface StoredFetch {
  at: string;
  seq: number;
}

/**
 * The stored fetches in the order they were stored (`seq`), which is not the
 * order of their times when the clock has been wrong.
 */
export function storedFetches(tx: Queryable): StoredFetch[] {
  return tx
    .select({ at: itemPriceHistory.fetchedAt, seq: sql<number>`min(${itemPriceHistory.seq})` })
    .from(itemPriceHistory)
    .groupBy(itemPriceHistory.fetchedAt)
    .all()
    .sort((a, b) => a.seq - b.seq);
}

/** A fetch whose time does not follow on from the fetch stored before it. */
export interface ClockJump {
  fetchedAt: string;
  /** The fetch stored before it. */
  previousAt: string;
}

/**
 * Stores one fetch and prunes what is no longer kept. Call inside the
 * transaction that stores the prices themselves. Returns the two times if
 * the fetch is more than a day after the one stored before it, or before
 * it, for a warning; nothing else depends on it.
 */
export function recordPriceHistory(
  tx: Queryable,
  prices: readonly HistoryPrice[],
  fetchedAt: Date,
): ClockJump | null {
  const at = fetchedAt.toISOString();
  // The most recently stored fetch always survives pruning (it is among the
  // newest 48), so the highest `seq` only ever goes up.
  const previous = storedFetches(tx).at(-1);
  const seq = (previous?.seq ?? 0) + 1;
  inChunks(
    prices.map(({ itemId, high, low }) => ({ fetchedAt: at, itemId, high, low, seq })),
    (chunk) => tx.insert(itemPriceHistory).values(chunk).onConflictDoNothing().run(),
  );
  prunePriceHistory(tx);
  if (previous === undefined) return null;
  const sincePrevious = fetchedAt.getTime() - Date.parse(previous.at);
  return sincePrevious > PRICE_HISTORY_JUMP_MS || sincePrevious < 0
    ? { fetchedAt: at, previousAt: previous.at }
    : null;
}

/**
 * Deletes every fetch that is neither among the 48 most recently stored nor
 * among the 35 most recently stored first-fetches-of-a-UTC-day. "Most
 * recently stored" is by `seq`, never by time and never by the clock: one
 * stored fetch pushes out at most one fetch of each kind, however its time
 * is stamped, and fetches stamped ahead by a wrong clock do not outrank the
 * real ones stored after them. Which fetch is the first of its UTC day does
 * come from the times: the earliest stored one of that day.
 * Returns the number of fetches deleted.
 */
export function prunePriceHistory(tx: Queryable): number {
  const fetches = storedFetches(tx);
  const keep = new Set(fetches.slice(-PRICE_HISTORY_HOURLY_FETCHES).map((fetch) => fetch.at));
  const firstOfDay = new Map<string, StoredFetch>();
  for (const fetch of fetches) {
    const day = fetch.at.slice(0, 10);
    const first = firstOfDay.get(day);
    if (first === undefined || fetch.at < first.at) firstOfDay.set(day, fetch);
  }
  const dailies = [...firstOfDay.values()].sort((a, b) => a.seq - b.seq);
  for (const fetch of dailies.slice(-PRICE_HISTORY_DAILY_FETCHES)) keep.add(fetch.at);
  const gone = fetches.filter((fetch) => !keep.has(fetch.at)).map((fetch) => fetch.at);
  inChunks(gone, (chunk) =>
    tx.delete(itemPriceHistory).where(inArray(itemPriceHistory.fetchedAt, chunk)).run(),
  );
  return gone.length;
}

/**
 * The stored fetch nearest to `targetMs` that is at most `earlierMs` before
 * it or `laterMs` after it, and before `before` (the fetch the current
 * prices are from). `null` when there is none: the period is then simply not
 * shown.
 */
export function baselineFetch(
  db: Queryable,
  targetMs: number,
  { earlierMs, laterMs }: { earlierMs: number; laterMs: number },
  before: string,
): string | null {
  const target = new Date(targetMs).toISOString();
  const earlier = db
    .select({ at: itemPriceHistory.fetchedAt })
    .from(itemPriceHistory)
    .where(lte(itemPriceHistory.fetchedAt, target))
    .orderBy(desc(itemPriceHistory.fetchedAt))
    .limit(1)
    .get()?.at;
  const later = db
    .select({ at: itemPriceHistory.fetchedAt })
    .from(itemPriceHistory)
    .where(gt(itemPriceHistory.fetchedAt, target))
    .orderBy(asc(itemPriceHistory.fetchedAt))
    .limit(1)
    .get()?.at;
  const distance = (at: string) => Math.abs(Date.parse(at) - targetMs);
  const inReach = [
    earlier !== undefined && distance(earlier) <= earlierMs ? earlier : undefined,
    later !== undefined && distance(later) <= laterMs ? later : undefined,
  ].filter((at): at is string => at !== undefined && at < before);
  // The nearest of the two; the earlier one on a tie.
  return inReach.sort((a, b) => distance(a) - distance(b))[0] ?? null;
}

/** The price of every item in one stored fetch, by the same rule as current prices. */
export function pricesOfFetch(db: Queryable, fetchedAt: string): Map<number, number> {
  const byItem = new Map<number, number>();
  const rows = db
    .select()
    .from(itemPriceHistory)
    .where(eq(itemPriceHistory.fetchedAt, fetchedAt))
    .all();
  for (const row of rows) {
    const each = currentPrice(row.high, row.low);
    if (each !== null) byItem.set(row.itemId, each);
  }
  return byItem;
}

export interface PriceBaseline {
  period: PriceMoverPeriod;
  baselineAt: string;
  priceOf: Map<number, number>;
}

/**
 * The periods that have a baseline, shortest first. `currentAt` is when the
 * current prices were fetched: a period reaches back from then, not from the
 * clock, so the change is between two known prices also when the newest
 * fetch is old.
 */
export function priceBaselines(db: Queryable, currentAt: string): PriceBaseline[] {
  const currentMs = Date.parse(currentAt);
  const baselines: PriceBaseline[] = [];
  for (const period of PRICE_MOVER_PERIODS) {
    const { agoMs, ...reach } = PRICE_MOVER_WINDOWS[period];
    const baselineAt = baselineFetch(db, currentMs - agoMs, reach, currentAt);
    if (baselineAt === null) continue;
    baselines.push({ period, baselineAt, priceOf: pricesOfFetch(db, baselineAt) });
  }
  return baselines;
}
