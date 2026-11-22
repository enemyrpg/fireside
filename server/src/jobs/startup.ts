import { systemClock, type Clock } from '../auth/api-keys.js';
import type { Db } from '../db/index.js';
import { PROJECTIONS, projectPending, type Projection } from '../projections/index.js';
import { startSessionTimeoutJob, type JobLogger, type RunningJob } from './session-timeout.js';

export interface BackgroundJobOptions {
  db: Db;
  log: JobLogger;
  now?: Clock;
  /** Overrides `PROJECTIONS`. Used by tests. */
  projections?: readonly Projection[];
}

/**
 * Work that runs once the server listens, so a large backlog doesn't keep it
 * from starting:
 * 1. project events stored but never projected (e.g. after a crash right
 *    after ingest). A failure is logged; the events stay pending for the
 *    next start;
 * 2. start the session timeout job. It runs after step 1, so it never closes
 *    a session whose newer heartbeats are still pending.
 */
export function startBackgroundJobs({
  db,
  log,
  now = systemClock,
  projections = PROJECTIONS,
}: BackgroundJobOptions): RunningJob {
  try {
    const { processed, failed } = projectPending(db, { projections, now, log });
    if (processed + failed.length > 0) {
      log.info({ processed, failed: failed.length }, 'Projected pending events');
    }
  } catch (error) {
    log.error({ err: error }, 'Could not project pending events');
  }
  return startSessionTimeoutJob({ db, log, now });
}
