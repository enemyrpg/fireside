import { isNull } from 'drizzle-orm';
import { systemClock, type Clock } from '../auth/api-keys.js';
import type { Config } from '../config.js';
import type { Db } from '../db/index.js';
import { sessions } from '../db/schema.js';
import type { ExternalClient } from '../external/client.js';
import { EXTERNAL_SOURCES, isSourceActive } from '../external/sources.js';
import { nextAttemptAt, sourceState } from '../external/state.js';
import { PRICES_INTERVAL_MS, refreshPrices } from '../prices/fetch.js';
import type { JobLogger, RunningJob } from './session-timeout.js';

/** How often the job checks whether a fetch is due. */
export const PRICES_CHECK_INTERVAL_MS = 60_000;

/**
 * Longest time between two attempts, whether anyone needs prices or not, so
 * Price movers have history (see docs/decisions/0019-prices-fetched-on-demand.md).
 * The 24 h period compares with a stored fetch at most 2 hours from exactly a
 * day before the current one (`PRICE_MOVER_WINDOWS` in prices/history.ts):
 * with less than 4 hours between fetches, every moment has one within 2
 * hours, so the period always shows unless a fetch failed. 3 h 55 min, not
 * 4 h, because the job only checks once a minute: a gap then stays at most
 * 3 h 56 min. 7 d and 30 d only need one fetch a day.
 */
export const PRICES_HISTORY_INTERVAL_MS = 3 * 60 * 60 * 1000 + 55 * 60 * 1000;

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
   * starts a fetch in the background if the last attempt is at least an hour
   * old and none is running. Never waits and never throws; the reader goes
   * on with the stored prices.
   */
  requested(): void;
  /** The fetch that is running, if any. For tests. */
  idle(): Promise<void>;
}

/**
 * Fetches GE prices while the server runs, when `PRICES_ENABLED` is on and
 * `USER_AGENT_CONTACT` is set, only when they are needed:
 * - when prices are read (`requested`) or a session is open (checked at start
 *   and every minute), if the last attempt is at least an hour old;
 * - and whenever the last attempt is `PRICES_HISTORY_INTERVAL_MS` old, for
 *   the price history (an hour, if that attempt failed).
 * Never more than one fetch at a time and never more than once an hour,
 * failed attempts included. The time of the last attempt is in the
 * database, so a restart does not cause an extra fetch. Does nothing at all
 * when the source is off.
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

  /** Whether the last attempt is at least `minAgeMs` old (or there was none). */
  const attemptOlderThan = (minAgeMs: number, nowMs: number) =>
    nextAttemptAt(sourceState(db, 'WIKI_PRICES'), minAgeMs, nowMs) <= nowMs;

  /**
   * How long after the last attempt the history fetch is due: an hour after a
   * failed one, as before on-demand fetching, so one error from the wiki does
   * not leave almost 8 hours between two stored fetches (a hole in the 24 h
   * Price movers period a day later).
   */
  const historyInterval = () => {
    const row = sourceState(db, 'WIKI_PRICES');
    const failed =
      row?.lastErrorAt != null && row.lastAttemptAt != null && row.lastErrorAt >= row.lastAttemptAt;
    return failed ? PRICES_INTERVAL_MS : PRICES_HISTORY_INTERVAL_MS;
  };

  const sessionOpen = () =>
    db.select({ id: sessions.id }).from(sessions).where(isNull(sessions.endedAt)).limit(1).get() !==
    undefined;

  /**
   * Starts a fetch if `due` says so. Checked and started in one synchronous
   * step, so requests that arrive together start one fetch.
   */
  const startIf = (due: (nowMs: number) => boolean, what: string) => {
    if (stopped || running) return;
    try {
      if (!due(now().getTime())) return;
    } catch (error) {
      log.error({ err: error }, `Could not check whether prices are due (${what})`);
      return;
    }
    running = refreshPrices({ db, client, log, now })
      .then(() => undefined)
      .catch((error: unknown) => {
        log.error({ err: error }, 'Price update failed');
      })
      .finally(() => {
        running = undefined;
      });
  };

  const tick = () => {
    startIf(
      (nowMs) =>
        attemptOlderThan(historyInterval(), nowMs) ||
        (attemptOlderThan(PRICES_INTERVAL_MS, nowMs) && sessionOpen()),
      'check',
    );
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
      startIf((nowMs) => attemptOlderThan(PRICES_INTERVAL_MS, nowMs), 'read');
    },
    idle: () => running ?? Promise.resolve(),
  };
}
