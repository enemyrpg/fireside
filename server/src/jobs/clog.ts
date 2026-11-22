import { and, eq, gt, isNotNull, lte, ne } from 'drizzle-orm';
import { systemClock, type Clock } from '../auth/api-keys.js';
import {
  CLOG_SYNC_INTERVAL_MS,
  enabledClogSources,
  type ClogSourceRow,
  type ClogSyncer,
} from '../clog/sync.js';
import type { Db, Queryable } from '../db/index.js';
import { sessions } from '../db/schema.js';
import type { JobLogger, RunningJob } from './session-timeout.js';

/** How often the job checks which accounts are due a sync. */
export const CLOG_CHECK_INTERVAL_MS = 60_000;
/**
 * How long after a session ends its account is synced: time for the source's
 * own plugin to upload, and for the source's one-minute cache to pass.
 */
export const SESSION_END_DELAY_MS = 2 * 60 * 1000;

/**
 * Whether an account with a collection log source is due a sync:
 * - it has never been tried, or not since the source was last turned on;
 * - the last attempt is six hours old (or in the future: the clock changed);
 * - or a session of the account ended after the last attempt and at least two
 *   minutes ago. A world hop does not count: the player is still playing.
 */
export function isSyncDue(db: Queryable, row: ClogSourceRow, nowMs: number): boolean {
  if (row.lastAttemptAt === null) return true;
  const last = Date.parse(row.lastAttemptAt);
  if (Number.isNaN(last) || last > nowMs || nowMs - last >= CLOG_SYNC_INTERVAL_MS) return true;
  if (row.lastAttemptAt < row.enabledAt) return true;
  return (
    db
      .select({ id: sessions.id })
      .from(sessions)
      .where(
        and(
          eq(sessions.accountId, row.accountId),
          isNotNull(sessions.endedAt),
          ne(sessions.endReason, 'hop'),
          gt(sessions.endedAt, row.lastAttemptAt),
          lte(sessions.endedAt, new Date(nowMs - SESSION_END_DELAY_MS).toISOString()),
        ),
      )
      .limit(1)
      .get() !== undefined
  );
}

export interface ClogJobOptions {
  db: Db;
  syncer: ClogSyncer;
  log: JobLogger;
  now?: Clock;
  intervalMs?: number;
}

export interface ClogJob extends RunningJob {
  /** The round that is running, if any. For tests. */
  idle(): Promise<void>;
}

/**
 * Syncs the collection log of every account the owner has turned a source on
 * for, when it is due (`isSyncDue`), checked at start and every minute. One
 * account at a time. All state is in the database, so a restart causes no
 * extra requests. Does nothing at all while the source is off in `.env`.
 */
export function startClogJob({
  db,
  syncer,
  log,
  now = systemClock,
  intervalMs = CLOG_CHECK_INTERVAL_MS,
}: ClogJobOptions): ClogJob {
  let stopped = false;
  let running: Promise<void> | undefined;

  async function round(): Promise<void> {
    const rows = enabledClogSources(db);
    for (const row of rows) {
      if (stopped) return;
      if (!isSyncDue(db, row, now().getTime())) continue;
      await syncer.sync(row.accountId);
    }
  }

  const tick = () => {
    if (stopped || running || !syncer.sourceActive()) return;
    running = round()
      .catch((error: unknown) => {
        log.error({ err: error }, 'Collection log job failed');
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
