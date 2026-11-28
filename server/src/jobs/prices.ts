import { isNull } from 'drizzle-orm';
import { systemClock, type Clock } from '../auth/api-keys.js';
import type { Config } from '../config.js';
import type { Db } from '../db/index.js';
import { sessions } from '../db/schema.js';
import type { ExternalClient } from '../external/client.js';
import { EXTERNAL_SOURCES, isSourceActive } from '../external/sources.js';
import { nextAttemptAt, sourceState } from '../external/state.js';
import {
  fetchMissingHours,
  latestSettledHour,
  missingHours,
  newestStoredHour,
  PRICES_INTERVAL_MS,
} from '../prices/fetch.js';
import type { JobLogger, RunningJob } from './session-timeout.js';

/** How often the job checks whether a catch-up is due. */
export const PRICES_CHECK_INTERVAL_MS = 60_000;

/**
 * With nobody reading prices and no session open, a catch-up still runs once
 * the newest stored hour is this far behind the newest settled one: one
 * batch of about 24 requests a day, so every UTC day gets all its hours and
 * 7 d / 30 d always come back (see
 * docs/decisions/0021-prices-from-hourly-volume-weighted-averages.md). It
 * stays well within the 48 hours a catch-up reaches, so no hour is lost
 * while the server runs.
 */
export const PRICES_BACKGROUND_AFTER_MS = 24 * 60 * 60 * 1000;

export interface PricesJobOptions {
  db: Db;
  config: Config;
  client: ExternalClient;
  log: JobLogger;
  now?: Clock;
  intervalMs?: number;
}

export interface PricesJob extends RunningJob {
  /**
   * Prices are being read (bank, summary, price movers, potion storage):
   * starts a catch-up in the background if an hour is missing and none is
   * running. Never waits and never throws; the reader goes on with the
   * stored prices.
   */
  requested(): void;
  /** The catch-up that is running, if any. For tests. */
  idle(): Promise<void>;
}

/**
 * Fetches GE trades while the server runs, when `PRICES_ENABLED` is on and
 * `USER_AGENT_CONTACT` is set. A catch-up (prices/fetch.ts) fetches every
 * missing settled hour of the last 48, oldest first, each once. It starts
 * when an hour is missing and:
 * - prices are read (`requested`) or a session is open (checked at start and
 *   every minute), or
 * - the newest stored hour is `PRICES_BACKGROUND_AFTER_MS` behind.
 * Never more than one catch-up at a time, and none within an hour of a failed
 * request. A new hour settles once an hour, so a catch-up that succeeded
 * makes at most one request an hour after it. What is stored is in the
 * database, so a restart fetches nothing twice. Does nothing at all when the
 * source is off.
 */
export function startPricesJob({
  db,
  config,
  client,
  log,
  now = systemClock,
  intervalMs = PRICES_CHECK_INTERVAL_MS,
}: PricesJobOptions): PricesJob {
  let stopped = false;
  let running: Promise<void> | undefined;

  if (!isSourceActive(config, 'WIKI_PRICES')) {
    if (config.prices.enabled) {
      log.warn(
        {},
        `${EXTERNAL_SOURCES.WIKI_PRICES.envName} is on, but USER_AGENT_CONTACT is not set: prices are not fetched`,
      );
    }
    return {
      stop() {
        stopped = true;
      },
      requested: () => undefined,
      idle: () => Promise.resolve(),
    };
  }

  /** Whether the last request failed less than an hour ago. */
  const backingOff = (nowMs: number) => {
    const row = sourceState(db, 'WIKI_PRICES');
    const failed =
      row?.lastErrorAt != null && row.lastAttemptAt != null && row.lastErrorAt >= row.lastAttemptAt;
    return failed && nextAttemptAt(row, PRICES_INTERVAL_MS, nowMs) > nowMs;
  };

  const backgroundDue = (nowMs: number) => {
    const newest = newestStoredHour(db);
    return newest === null || latestSettledHour(nowMs) - newest >= PRICES_BACKGROUND_AFTER_MS;
  };

  const sessionOpen = () =>
    db.select({ id: sessions.id }).from(sessions).where(isNull(sessions.endedAt)).limit(1).get() !==
    undefined;

  /**
   * Starts a catch-up if one is due. Checked and started in one synchronous
   * step, so requests that arrive together start one catch-up.
   */
  const startIf = (wanted: (nowMs: number) => boolean, what: string) => {
    if (stopped || running) return;
    try {
      const nowMs = now().getTime();
      if (missingHours(db, nowMs).length === 0 || backingOff(nowMs) || !wanted(nowMs)) return;
    } catch (error) {
      log.error({ err: error }, `Could not check whether prices are due (${what})`);
      return;
    }
    running = fetchMissingHours({ db, client, log, now, stopped: () => stopped })
      .then(() => undefined)
      .catch((error: unknown) => {
        log.error({ err: error }, 'Price update failed');
      })
      .finally(() => {
        running = undefined;
      });
  };

  const tick = () => {
    startIf((nowMs) => backgroundDue(nowMs) || sessionOpen(), 'check');
  };

  tick();
  const timer = setInterval(tick, intervalMs);
  // Never keeps the process alive on its own.
  timer.unref();

  return {
    stop() {
      stopped = true;
      clearInterval(timer);
    },
    requested() {
      startIf(() => true, 'read');
    },
    idle: () => running ?? Promise.resolve(),
  };
}
