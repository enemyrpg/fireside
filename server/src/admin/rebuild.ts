import { performance } from 'node:perf_hooks';
import { systemClock, type Clock } from '../auth/api-keys.js';
import { rebuildClog } from '../clog/project.js';
import type { Db } from '../db/index.js';
import {
  PROJECTIONS,
  rebuildProjections,
  reprocessFailed,
  type Projection,
  type ProjectionFailure,
  type ProjectionLogger,
  type ProjectionResult,
} from '../projections/index.js';
import { recordCurrentVersions } from '../projections/versions.js';

// Shared by `pnpm cli rebuild|reprocess` and `POST /api/v1/admin/rebuild`.
// Both run synchronously: the HTTP server waits until they finish.

/** The part of a pino/Fastify logger used here. */
export interface AdminLogger extends ProjectionLogger {
  info(obj: object, msg: string): void;
}

export interface AdminRunOptions {
  /** Overrides `PROJECTIONS`. Used by tests. */
  projections?: readonly Projection[];
  now?: Clock;
  log?: AdminLogger;
}

export interface AdminRunResult {
  processed: number;
  failed: ProjectionFailure[];
  /** Wall time, in whole milliseconds. */
  durationMs: number;
}

function timed(
  run: () => ProjectionResult,
  message: string,
  log: AdminLogger | undefined,
): AdminRunResult {
  const start = performance.now();
  const { processed, failed } = run();
  const durationMs = Math.round(performance.now() - start);
  log?.info({ processed, failed: failed.length, durationMs }, message);
  return { processed, failed, durationMs };
}

/**
 * Empties every derived table and rebuilds it from `events` in one
 * transaction, with one `now` for session timeouts. Failed events are tried
 * again. Account IDs are kept. See docs/architecture.md#rebuild.
 */
export function rebuildDerivedTables(
  db: Db,
  { projections = PROJECTIONS, now = systemClock, log }: AdminRunOptions = {},
): AdminRunResult {
  return timed(
    () => {
      const result = rebuildProjections(db, { projections, now, ...(log ? { log } : {}) });
      // The collection log tables are derived from `external_snapshots`, not
      // from events, so they are rebuilt on their own.
      const clog = db.transaction(
        (tx) => {
          const counts = rebuildClog(tx, log);
          // Everything was just built with the current rules.
          recordCurrentVersions(tx, projections, now);
          return counts;
        },
        { behavior: 'immediate' },
      );
      if (clog.applied + clog.skipped > 0) {
        log?.info(
          { snapshots: clog.applied, skipped: clog.skipped },
          'Rebuilt the collection log from stored external snapshots',
        );
      }
      return result;
    },
    'Rebuilt derived tables',
    log,
  );
}

/** Tries only the events whose projection failed, e.g. after a fix. */
export function retryFailedEvents(
  db: Db,
  { projections = PROJECTIONS, now = systemClock, log }: AdminRunOptions = {},
): AdminRunResult {
  return timed(
    () => reprocessFailed(db, { projections, now, ...(log ? { log } : {}) }),
    'Retried failed events',
    log,
  );
}
