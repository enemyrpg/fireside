import { systemClock, type Clock } from '../auth/api-keys.js';
import type { Config } from '../config.js';
import type { Db } from '../db/index.js';
import type { ExternalClient } from '../external/client.js';
import { EXTERNAL_SOURCES, isSourceActive } from '../external/sources.js';
import { nextAttemptAt, sourceState } from '../external/state.js';
import { PRICES_INTERVAL_MS, refreshPrices } from '../prices/fetch.js';
import type { JobLogger, RunningJob } from './session-timeout.js';

/** How often the job checks whether a fetch is due. */
export const PRICES_CHECK_INTERVAL_MS = 60_000;

export interface PricesJobOptions {
  db: Db;
  config: Config;
  client: ExternalClient;
  log: JobLogger;
  now?: Clock;
  intervalMs?: number;
}

export interface PricesJob extends RunningJob {
  /** The fetch that is running, if any. For tests. */
  idle(): Promise<void>;
}

/**
 * Fetches GE prices while the server runs, when `PRICES_ENABLED` is on and
 * `USER_AGENT_CONTACT` is set: once when the last attempt is at least an hour
 * old (checked at start and every minute), so never more than once an hour.
 * The time of the last attempt is in the database, so a restart does not
 * cause an extra fetch. Does nothing at all when the source is off.
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
      idle: () => Promise.resolve(),
    };
  }

  const tick = () => {
    if (stopped || running) return;
    try {
      const nowMs = now().getTime();
      if (nextAttemptAt(sourceState(db, 'WIKI_PRICES'), PRICES_INTERVAL_MS, nowMs) > nowMs) return;
    } catch (error) {
      log.error({ err: error }, 'Could not check when prices were last fetched');
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

  tick();
  const timer = setInterval(tick, intervalMs);
  // Never keeps the process alive on its own.
  timer.unref();

  return {
    stop() {
      stopped = true;
      clearInterval(timer);
    },
    idle: () => running ?? Promise.resolve(),
  };
}
