import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { systemClock, type Clock } from '../auth/api-keys.js';
import type { Db } from '../db/index.js';
import { itemPrices } from '../db/schema.js';
import { ExternalRequestError, type ExternalClient } from '../external/client.js';
import { recordAttempt, recordFailure, recordSuccess } from '../external/state.js';
import type { JobLogger } from '../jobs/session-timeout.js';
import { inChunks } from '../projections/bank.js';
import { recordPriceHistory, type ClockJump } from './history.js';

// Latest Grand Exchange prices from the OSRS Wiki
// (see docs/architecture.md#external-sources). One request for every item,
// never one per item, and never anything but JSON: no images.

/** `/latest` without `id`: the latest high and low price of every traded item. */
export const PRICES_PATH = '/api/v2/osrs/latest';

/** At most one attempt per hour, failed ones included. */
export const PRICES_INTERVAL_MS = 60 * 60 * 1000;

/** Year 5138: anything larger is not Unix seconds. */
const MAX_UNIX_SECONDS = 99_999_999_999;

/** A response with fewer valid items than this is treated as broken. */
export const MIN_PRICE_ITEMS = 100;

/** The response did not look like `/latest`. Nothing was stored. */
export class PricesFormatError extends Error {
  override name = 'PricesFormatError';
}

export interface FetchedPrice {
  itemId: number;
  high: number | null;
  highTime: string | null;
  low: number | null;
  lowTime: string | null;
}

const wikiPrice = z.int().nonnegative().max(Number.MAX_SAFE_INTEGER);
/** Unix time in seconds. */
const wikiTime = z.int().positive().max(MAX_UNIX_SECONDS);

/**
 * The response of `/latest`, exactly as the API gives it (confirmed against
 * the real API on 16 November 2026):
 * `{ "data": { "<item id>": { "high", "highTime", "low", "lowTime" } } }`.
 * Prices are whole gp and times Unix seconds; a side that has never been seen
 * is `null`. Strict on purpose: if the API changes shape, the fetch fails,
 * the last good prices stay, and Settings → Server shows the error, rather
 * than prices being read wrongly.
 */
export const latestPricesSchema = z.strictObject({
  data: z.record(
    z.string().regex(/^(0|[1-9]\d{0,8})$/),
    z.strictObject({
      high: wikiPrice.nullable(),
      highTime: wikiTime.nullable(),
      low: wikiPrice.nullable(),
      lowTime: wikiTime.nullable(),
    }),
  ),
});

const iso = (seconds: number | null) =>
  seconds === null ? null : new Date(seconds * 1000).toISOString();

/**
 * Reads `/latest` (see `latestPricesSchema`). Items with neither a high nor
 * a low are left out. Throws `PricesFormatError` if the response has another
 * shape, or too few items to be a full price list.
 */
export function parseLatestPrices(json: unknown): FetchedPrice[] {
  const result = latestPricesSchema.safeParse(json);
  if (!result.success) {
    // Where it went wrong and Zod's own message. Never values from the response.
    const [issue] = result.error.issues;
    const where = issue?.path.map(String).join('.') ?? '';
    throw new PricesFormatError(
      `The price response had an unexpected format${where === '' ? '' : ` at ${where}`}` +
        (issue ? `: ${issue.code}` : ''),
    );
  }
  const prices: FetchedPrice[] = [];
  for (const [key, entry] of Object.entries(result.data.data)) {
    if (entry.high === null && entry.low === null) continue;
    prices.push({
      itemId: Number(key),
      high: entry.high,
      highTime: entry.high === null ? null : iso(entry.highTime),
      low: entry.low,
      lowTime: entry.low === null ? null : iso(entry.lowTime),
    });
  }
  if (prices.length < MIN_PRICE_ITEMS) {
    throw new PricesFormatError(
      `The price response had only ${String(prices.length)} usable items`,
    );
  }
  return prices;
}

/**
 * Stores the prices in one transaction. Items that are not in `prices` keep
 * the row they had. The same transaction adds the fetch to the price history
 * and prunes it (prices/history.ts), whatever caused the fetch: this is the
 * only place prices are stored, and the history is never pruned on read.
 * Returns the two times if the fetch does not follow on from the one stored
 * before it (more than a day after it, or before it), for a warning.
 */
export function storePrices(
  db: Db,
  prices: readonly FetchedPrice[],
  fetchedAt: Date,
): ClockJump | null {
  const at = fetchedAt.toISOString();
  return db.transaction((tx) => {
    inChunks(
      prices.map((row) => ({ ...row, fetchedAt: at })),
      (chunk) =>
        tx
          .insert(itemPrices)
          .values(chunk)
          .onConflictDoUpdate({
            target: itemPrices.itemId,
            set: {
              high: sql`excluded.high`,
              highTime: sql`excluded.high_time`,
              low: sql`excluded.low`,
              lowTime: sql`excluded.low_time`,
              fetchedAt: sql`excluded.fetched_at`,
            },
          })
          .run(),
    );
    return recordPriceHistory(tx, prices, fetchedAt);
  });
}

/** Databases whose latest fetch was a clock jump that has been warned about. */
const jumpWarned = new WeakSet<Db>();

export interface RefreshPricesOptions {
  db: Db;
  client: ExternalClient;
  log: JobLogger;
  now?: Clock;
}

/**
 * One fetch of all prices. Never throws: a failure is logged and stored for
 * Settings → Server, and the prices from the last good fetch stay as they are.
 * Returns whether new prices were stored.
 */
export async function refreshPrices({
  db,
  client,
  log,
  now = systemClock,
}: RefreshPricesOptions): Promise<boolean> {
  recordAttempt(db, 'WIKI_PRICES', now());
  try {
    const prices = parseLatestPrices(await client.getJson('WIKI_PRICES', PRICES_PATH));
    const fetchedAt = now();
    const jump = storePrices(db, prices, fetchedAt);
    recordSuccess(db, 'WIKI_PRICES', fetchedAt);
    // One warning when it starts, not one per fetch while it lasts.
    if (jump && !jumpWarned.has(db)) {
      log.warn(
        jump,
        'The price fetch is more than a day after the previous stored one, or before it (server off, or a wrong clock). Stored as usual',
      );
    }
    if (jump) jumpWarned.add(db);
    else jumpWarned.delete(db);
    log.info({ items: prices.length }, 'Prices updated');
    return true;
  } catch (error) {
    // Only messages we wrote ourselves are stored and shown.
    const message =
      error instanceof ExternalRequestError || error instanceof PricesFormatError
        ? error.message
        : 'Unexpected error, see the server log';
    try {
      recordFailure(db, 'WIKI_PRICES', now(), message);
    } catch (storeError) {
      log.error({ err: storeError }, 'Could not store the price update error');
    }
    log.warn({ err: error }, 'Price update failed, keeping the last prices');
    return false;
  }
}
