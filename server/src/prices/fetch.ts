import { and, eq, gte, isNotNull, lt, max, sql } from 'drizzle-orm';
import { z } from 'zod';
import { systemClock, type Clock } from '../auth/api-keys.js';
import type { Db, Queryable } from '../db/index.js';
import {
  priceDayHours,
  priceDays,
  priceHourFailures,
  priceHourFetches,
  priceHours,
} from '../db/schema.js';
import { ExternalRequestError, type ExternalClient } from '../external/client.js';
import { recordAttempt, recordFailure, recordSuccess } from '../external/state.js';
import type { JobLogger } from '../jobs/session-timeout.js';
import { inChunks } from '../projections/bank.js';

// Grand Exchange trades from the OSRS Wiki, one `/1h` bucket at a time
// (see docs/architecture.md#external-sources and
// docs/decisions/0021-prices-from-hourly-volume-weighted-averages.md). One
// request for every item per hour, never one per item, each hour fetched
// once, and never anything but JSON: no images.

/** `/1h` without `id`: every item's trades in one hour (`?timestamp=` its start). */
export const HOUR_PATH = '/api/v2/osrs/1h';

/** After a failed request, the next one waits this long. Also the interval Settings → Server shows. */
export const PRICES_INTERVAL_MS = 60 * 60 * 1000;

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/**
 * An hour is only asked for once it has been over this long: a bucket the
 * wiki is still filling would otherwise be stored, and it is never fetched
 * again.
 */
export const PRICE_HOUR_SETTLE_MS = 10 * 60 * 1000;

/** Hours kept: two 24 h windows, the current one and the one before. */
export const PRICE_HOURS_KEPT = 48;

/** Most hours one catch-up asks for: the same 48, so every kept hour can be filled. */
export const PRICE_CATCHUP_MAX = PRICE_HOURS_KEPT;

/** UTC days of sums kept, for 7 d and 30 d. */
export const PRICE_DAYS_KEPT = 35;

/**
 * Runs in which an hour's response was unusable before the hour is skipped:
 * never asked for again, and missing in the windows.
 */
export const PRICE_HOUR_MAX_FAILURES = 3;

/** A response with fewer items than this is treated as broken (a real hour has thousands). */
export const MIN_PRICE_ITEMS = 100;

/**
 * Largest value or volume one item may add in one hour. Every sum the server
 * makes (at most 35 days of 24 hours) then stays below 2^53, so it is exact.
 * Real trades are far below it; an item above it is left out of that hour.
 */
export const MAX_HOUR_SUM = Math.floor(Number.MAX_SAFE_INTEGER / 1024);

/** The response did not look like `/1h` for the hour asked for. Nothing was stored. */
export class PricesFormatError extends Error {
  override name = 'PricesFormatError';
}

export interface HourItem {
  itemId: number;
  /** Average price × volume, rounded to whole gp. */
  highValue: number;
  highVolume: number;
  lowValue: number;
  lowVolume: number;
}

export interface HourBucket {
  /** Start of the hour, ISO. */
  hourStart: string;
  items: HourItem[];
  /** Items left out because a sum would exceed `MAX_HOUR_SUM`. */
  skipped: number;
}

/** Averages may have up to two decimals; prices can exceed 32 bits. */
const wikiAverage = z.number().positive().max(Number.MAX_SAFE_INTEGER);
const wikiVolume = z.int().nonnegative().max(Number.MAX_SAFE_INTEGER);
/** Unix seconds, the start of an hour. */
const wikiHour = z.int().positive().max(99_999_999_999).multipleOf(3600);

/**
 * The response of `/1h`, exactly as the API gives it (checked against one
 * real response on 28 November 2026):
 * `{ "data": { "<item id>": { "avgHighPrice", "highPriceVolume", "avgLowPrice",
 * "lowPriceVolume" } }, "timestamp" }`. A side without trades has a `null`
 * average and volume 0; an item without any trade in the hour is not in
 * `data`. `timestamp` is the start of the hour, in Unix seconds. Strict on
 * purpose: if the API changes shape, the fetch fails, nothing is stored, and
 * Settings → Server shows the error, rather than prices being read wrongly.
 */
export const hourPricesSchema = z.strictObject({
  data: z.record(
    z.string().regex(/^(0|[1-9]\d{0,8})$/),
    z
      .strictObject({
        avgHighPrice: wikiAverage.nullable(),
        highPriceVolume: wikiVolume,
        avgLowPrice: wikiAverage.nullable(),
        lowPriceVolume: wikiVolume,
      })
      .refine(
        (entry) =>
          (entry.avgHighPrice === null) === (entry.highPriceVolume === 0) &&
          (entry.avgLowPrice === null) === (entry.lowPriceVolume === 0),
        { message: 'An average is null exactly when its volume is 0' },
      ),
  ),
  timestamp: wikiHour,
});

const value = (avg: number | null, volume: number) => (avg === null ? 0 : Math.round(avg * volume));

/**
 * Reads `/1h` for the hour starting at `hourStartMs`. Throws
 * `PricesFormatError` if the response has another shape, is for another
 * hour, or has too few items to be a full hour.
 */
export function parseHourBucket(json: unknown, hourStartMs: number): HourBucket {
  const result = hourPricesSchema.safeParse(json);
  if (!result.success) {
    // Where it went wrong and Zod's own code. Never values from the response.
    const [issue] = result.error.issues;
    const where = issue?.path.map(String).join('.') ?? '';
    throw new PricesFormatError(
      `The price response had an unexpected format${where === '' ? '' : ` at ${where}`}` +
        (issue ? `: ${issue.code}` : ''),
    );
  }
  if (result.data.timestamp * 1000 !== hourStartMs) {
    throw new PricesFormatError('The price response was for another hour');
  }
  const items: HourItem[] = [];
  let skipped = 0;
  for (const [key, entry] of Object.entries(result.data.data)) {
    const item = {
      itemId: Number(key),
      highValue: value(entry.avgHighPrice, entry.highPriceVolume),
      highVolume: entry.highPriceVolume,
      lowValue: value(entry.avgLowPrice, entry.lowPriceVolume),
      lowVolume: entry.lowPriceVolume,
    };
    if (item.highVolume === 0 && item.lowVolume === 0) continue;
    if (
      [item.highValue, item.highVolume, item.lowValue, item.lowVolume].some((n) => n > MAX_HOUR_SUM)
    ) {
      skipped += 1;
      continue;
    }
    items.push(item);
  }
  if (items.length < MIN_PRICE_ITEMS) {
    throw new PricesFormatError(`The price response had only ${String(items.length)} usable items`);
  }
  return { hourStart: new Date(hourStartMs).toISOString(), items, skipped };
}

const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** Start of the newest stored hour, as epoch ms, or `null` when none is stored. */
export function newestStoredHour(db: Queryable): number | null {
  const at = db
    .select({ at: max(priceHourFetches.hourStart) })
    .from(priceHourFetches)
    .get()?.at;
  return at == null ? null : Date.parse(at);
}

/**
 * Stores one bucket, adds it to its UTC day and prunes, in one transaction.
 * A bucket that is already stored changes nothing, so no hour is ever
 * counted twice in its day. Retention counts back from the newest stored
 * hour (a wiki timestamp), never from the clock. Returns whether it was new.
 */
export function storeHourBucket(db: Db, bucket: HourBucket, fetchedAt: Date): boolean {
  const day = bucket.hourStart.slice(0, 10);
  return db.transaction((tx) => {
    const inserted = tx
      .insert(priceHourFetches)
      .values({
        hourStart: bucket.hourStart,
        fetchedAt: fetchedAt.toISOString(),
        items: bucket.items.length,
      })
      .onConflictDoNothing()
      .run();
    if (inserted.changes === 0) return false;
    tx.delete(priceHourFailures).where(eq(priceHourFailures.hourStart, bucket.hourStart)).run();
    inChunks(
      bucket.items.map((item) => ({ hourStart: bucket.hourStart, ...item })),
      (chunk) => tx.insert(priceHours).values(chunk).run(),
    );
    inChunks(
      bucket.items.map((item) => ({ day, ...item })),
      (chunk) =>
        tx
          .insert(priceDays)
          .values(chunk)
          .onConflictDoUpdate({
            target: [priceDays.day, priceDays.itemId],
            set: {
              highValue: sql`${priceDays.highValue} + excluded.high_value`,
              highVolume: sql`${priceDays.highVolume} + excluded.high_volume`,
              lowValue: sql`${priceDays.lowValue} + excluded.low_value`,
              lowVolume: sql`${priceDays.lowVolume} + excluded.low_volume`,
            },
          })
          .run(),
    );
    tx.insert(priceDayHours)
      .values({ day, hours: 1 })
      .onConflictDoUpdate({
        target: priceDayHours.day,
        set: { hours: sql`${priceDayHours.hours} + 1` },
      })
      .run();
    prunePrices(tx);
    return true;
  });
}

/** Deletes hours and days older than what is kept. Only called when a bucket is stored. */
export function prunePrices(tx: Queryable): void {
  const newest = newestStoredHour(tx);
  if (newest === null) return;
  const firstHour = new Date(newest - (PRICE_HOURS_KEPT - 1) * HOUR_MS).toISOString();
  tx.delete(priceHours).where(lt(priceHours.hourStart, firstHour)).run();
  tx.delete(priceHourFetches).where(lt(priceHourFetches.hourStart, firstHour)).run();
  tx.delete(priceHourFailures).where(lt(priceHourFailures.hourStart, firstHour)).run();
  const firstDay = isoDay(newest - (PRICE_DAYS_KEPT - 1) * DAY_MS);
  tx.delete(priceDays).where(lt(priceDays.day, firstDay)).run();
  tx.delete(priceDayHours).where(lt(priceDayHours.day, firstDay)).run();
}

/** Start of the newest hour that ended at least `PRICE_HOUR_SETTLE_MS` before `nowMs`. */
export function latestSettledHour(nowMs: number): number {
  return Math.floor((nowMs - PRICE_HOUR_SETTLE_MS - HOUR_MS) / HOUR_MS) * HOUR_MS;
}

/**
 * The hours to fetch, oldest first, at most `PRICE_CATCHUP_MAX`: settled
 * hours among the last 48 that are neither stored nor skipped. Never an hour that pruning
 * has already passed (older than 48 hours before the newest stored one), so
 * a clock that is behind cannot make the server fetch, store and prune the
 * same hour again and again, or count it twice in its day.
 */
export function missingHours(db: Queryable, nowMs: number): number[] {
  const latest = latestSettledHour(nowMs);
  const newest = newestStoredHour(db);
  let first = latest - (PRICE_CATCHUP_MAX - 1) * HOUR_MS;
  if (newest !== null) first = Math.max(first, newest - (PRICE_HOURS_KEPT - 1) * HOUR_MS);
  if (first > latest) return [];
  const stored = new Set(
    db
      .select({ at: priceHourFetches.hourStart })
      .from(priceHourFetches)
      .where(
        and(
          gte(priceHourFetches.hourStart, new Date(first).toISOString()),
          lt(priceHourFetches.hourStart, new Date(latest + HOUR_MS).toISOString()),
        ),
      )
      .all()
      .map((row) => Date.parse(row.at)),
  );
  for (const row of db
    .select({ at: priceHourFailures.hourStart })
    .from(priceHourFailures)
    .where(isNotNull(priceHourFailures.skippedAt))
    .all()) {
    stored.add(Date.parse(row.at));
  }
  const hours: number[] = [];
  for (let hour = first; hour <= latest; hour += HOUR_MS) {
    if (!stored.has(hour)) hours.push(hour);
  }
  return hours.slice(0, PRICE_CATCHUP_MAX);
}

/**
 * Counts one failed run against an hour whose response was unusable, and
 * skips the hour at `PRICE_HOUR_MAX_FAILURES`. Called at most once per hour
 * and run: a run asks for each hour once.
 */
export function recordHourFailure(db: Db, hourMs: number, at: Date): void {
  const failedAt = at.toISOString();
  db.insert(priceHourFailures)
    .values({ hourStart: new Date(hourMs).toISOString(), failures: 1, lastFailedAt: failedAt })
    .onConflictDoUpdate({
      target: priceHourFailures.hourStart,
      set: {
        failures: sql`${priceHourFailures.failures} + 1`,
        lastFailedAt: failedAt,
      },
    })
    .run();
  db.update(priceHourFailures)
    .set({ skippedAt: failedAt })
    .where(
      and(
        eq(priceHourFailures.hourStart, new Date(hourMs).toISOString()),
        gte(priceHourFailures.failures, PRICE_HOUR_MAX_FAILURES),
        sql`${priceHourFailures.skippedAt} IS NULL`,
      ),
    )
    .run();
}

export interface FetchMissingOptions {
  db: Db;
  client: ExternalClient;
  log: JobLogger;
  now?: Clock;
  /** Checked before each request: true ends the catch-up there. */
  stopped?: () => boolean;
}

/**
 * One catch-up: fetches the missing hours one at a time, oldest first, each
 * stored as soon as it arrives, so a stop or crash keeps what was fetched.
 * The source's minimum interval in the client spaces the requests. An hour
 * whose response is unusable (`PricesFormatError`) is counted against that
 * hour (`recordHourFailure`) and the run goes on, so one bad hour never
 * holds back the newer ones. A network or HTTP error, or anything else,
 * ends the run and counts against no hour. Never throws: failures are logged
 * and stored for Settings → Server; what is stored stays. Returns the number
 * of hours stored.
 */
export async function fetchMissingHours({
  db,
  client,
  log,
  now = systemClock,
  stopped = () => false,
}: FetchMissingOptions): Promise<number> {
  const hours = missingHours(db, now().getTime());
  let stored = 0;
  let badHours = 0;
  let firstBad: unknown;
  for (const hour of hours) {
    if (stopped()) break;
    recordAttempt(db, 'WIKI_PRICES', now());
    try {
      const json = await client.getJson(
        'WIKI_PRICES',
        `${HOUR_PATH}?timestamp=${String(hour / 1000)}`,
      );
      const bucket = parseHourBucket(json, hour);
      const fetchedAt = now();
      if (storeHourBucket(db, bucket, fetchedAt)) stored += 1;
      recordSuccess(db, 'WIKI_PRICES', fetchedAt);
      if (bucket.skipped > 0) {
        log.warn(
          { hourStart: bucket.hourStart, items: bucket.skipped },
          'Price items left out of an hour: their sums were too large',
        );
      }
    } catch (error) {
      const badHour = error instanceof PricesFormatError;
      // Only messages we wrote ourselves are stored and shown.
      const message =
        error instanceof ExternalRequestError || badHour
          ? error.message
          : 'Unexpected error, see the server log';
      try {
        recordFailure(db, 'WIKI_PRICES', now(), message);
        if (badHour) recordHourFailure(db, hour, now());
      } catch (storeError) {
        log.error({ err: storeError }, 'Could not store the price update error');
        break;
      }
      if (badHour) {
        badHours += 1;
        firstBad ??= error;
        continue;
      }
      log.warn({ err: error }, 'Price update failed, keeping the prices stored so far');
      break;
    }
  }
  if (badHours > 0) {
    // One line per run, also when the API's shape changed and every hour fails.
    log.warn(
      { hours: badHours, err: firstBad },
      'An hour of prices had an unexpected response; going on with the next hours',
    );
  }
  if (stored > 0) log.info({ hours: stored }, 'Prices updated');
  return stored;
}
