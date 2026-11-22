import { systemClock, type Clock } from '../auth/api-keys.js';
import type { Db } from '../db/index.js';
import { closeTimedOutSessions } from '../projections/sessions.js';

/** How often the job looks for sessions without heartbeats. */
export const SESSION_TIMEOUT_INTERVAL_MS = 60_000;

/** The part of a pino/Fastify logger the job uses. */
export interface JobLogger {
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
  error(obj: object, msg: string): void;
}

export interface SessionTimeoutJobOptions {
  db: Db;
  log: JobLogger;
  now?: Clock;
  intervalMs?: number;
}

export interface RunningJob {
  /** Stops the job. Safe to call more than once. */
  stop(): void;
}

/**
 * Closes sessions with no heartbeat for 10 minutes (`timeout`), once right
 * away and then every `intervalMs`. Errors are logged; the next run tries
 * again. See docs/architecture.md#sessions.
 */
export function startSessionTimeoutJob({
  db,
  log,
  now = systemClock,
  intervalMs = SESSION_TIMEOUT_INTERVAL_MS,
}: SessionTimeoutJobOptions): RunningJob {
  let stopped = false;

  const run = () => {
    if (stopped) return;
    try {
      const closed = closeTimedOutSessions(db, now());
      if (closed > 0) log.info({ closed }, 'Closed sessions without heartbeats (timeout)');
    } catch (error) {
      log.error({ err: error }, 'Session timeout job failed');
    }
  };

  run();
  const timer = setInterval(run, intervalMs);
  // Never keeps the process alive on its own.
  timer.unref();

  return {
    stop() {
      stopped = true;
      clearInterval(timer);
    },
  };
}
