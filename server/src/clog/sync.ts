import type { ClogSync, ClogSyncStatus } from '@fireside/shared';
import { and, desc, eq } from 'drizzle-orm';
import { systemClock, type Clock } from '../auth/api-keys.js';
import type { Config } from '../config.js';
import type { Db, Queryable } from '../db/index.js';
import { accountClogSources, accountNames, accounts, externalSnapshots } from '../db/schema.js';
import { isSourceActive } from '../external/sources.js';
import { recordAttempt, recordFailure, recordSuccess } from '../external/state.js';
import type { JobLogger } from '../jobs/session-timeout.js';
import { storeExternalSnapshot } from './project.js';
import type { ClogFailure, ClogProvider, RawBody, SnapshotKind } from './provider.js';
import { recordClogRead } from './reads.js';
import { lookupName } from './runeprofile.js';

// One account's collection log sync (see
// docs/architecture.md#external-sources). Only accounts with a row in
// `account_clog_sources` (the owner's opt-in) are ever looked up, by the
// account's current name from our own name history.

/** Shortest time between two sync attempts for one account, "Sync now" included. */
export const MIN_SYNC_INTERVAL_MS = 60_000;
/** Scheduled sync when nothing else has caused one. */
export const CLOG_SYNC_INTERVAL_MS = 6 * 60 * 60 * 1000;
/**
 * The activity feed is read from this long before the last read, since the
 * source caches the feed and the collection log separately (60 s each).
 */
export const FEED_OVERLAP_MS = 10 * 60 * 1000;

export type ClogSourceRow = typeof accountClogSources.$inferSelect;

/**
 * The account's collection log source, or `null` when it has none or the
 * owner has turned it off. Only an account with a row here is ever looked up.
 */
export function clogSourceRow(db: Queryable, accountId: number): ClogSourceRow | null {
  return (
    db
      .select()
      .from(accountClogSources)
      .where(and(eq(accountClogSources.accountId, accountId), eq(accountClogSources.enabled, true)))
      .get() ?? null
  );
}

/** Every account with a source turned on. */
export function enabledClogSources(db: Queryable): ClogSourceRow[] {
  return db.select().from(accountClogSources).where(eq(accountClogSources.enabled, true)).all();
}

/** Earliest time of the next attempt for the account, in ms. `nowMs` or earlier means now. */
export function nextSyncAllowedMs(row: ClogSourceRow, nowMs: number): number {
  if (row.lastAttemptAt === null) return nowMs;
  const last = Date.parse(row.lastAttemptAt);
  // A last attempt in the future means the clock was changed.
  if (Number.isNaN(last) || last > nowMs) return nowMs;
  return last + MIN_SYNC_INTERVAL_MS;
}

/** The sync state as the API gives it. */
export function clogSyncState(
  row: ClogSourceRow,
  { sourceActive, syncing, nowMs }: { sourceActive: boolean; syncing: boolean; nowMs: number },
): ClogSync {
  const next = nextSyncAllowedMs(row, nowMs);
  const status: ClogSyncStatus = !sourceActive
    ? 'SOURCE_OFF'
    : syncing
      ? 'SYNCING'
      : ((row.status as ClogSyncStatus | null) ?? 'NEVER_SYNCED');
  return {
    status,
    lastAttemptAt: row.lastAttemptAt,
    lastSuccessAt: row.lastSuccessAt,
    lastChangedAt: row.lastChangedAt,
    nextSyncAllowedAt: next > nowMs ? new Date(next).toISOString() : null,
  };
}

/** Failures of the source itself, shown under Settings → Server. Fixed texts only. */
const SOURCE_ERRORS: Partial<Record<ClogFailure, string>> = {
  RATE_LIMITED: 'HTTP 429',
  INVALID_API_KEY: 'The API key was refused (HTTP 401)',
  UNAVAILABLE: 'No usable answer (network error, timeout or HTTP 5xx)',
  INVALID_RESPONSE: 'The response had an unexpected format',
};

export type SyncStart =
  | { started: true }
  /** `RUNNING`: a sync of the account is already running. */
  | { started: false; reason: 'NO_SOURCE' | 'SOURCE_OFF' | 'RUNNING' }
  | { started: false; reason: 'TOO_SOON'; retryAt: Date };

export interface ClogSyncer {
  /** Starts a sync in the background, unless the account is not due one. */
  start(accountId: number): SyncStart;
  /** As `start`, and resolves when the sync is over. Never rejects. */
  sync(accountId: number): Promise<SyncStart>;
  isSyncing(accountId: number): boolean;
  /** Whether the source is on in `.env`. */
  sourceActive(): boolean;
  /** Resolves when no sync is running. For tests. */
  idle(): Promise<void>;
  /**
   * For shutdown: no new sync starts, a running one makes no further request
   * and stores nothing. Waits for it at most `waitMs`, so closing the server
   * never hangs on a slow source.
   */
  shutdown(waitMs?: number): Promise<void>;
}

/** How long `shutdown` waits for a running sync by default. */
export const SHUTDOWN_WAIT_MS = 3_000;

/** Stored and shown when a sync fails in a way we did not foresee. */
const UNEXPECTED_ERROR = 'Unexpected error, see the server log';

export interface ClogSyncerOptions {
  db: Db;
  config: Config;
  provider: ClogProvider;
  log: JobLogger;
  now?: Clock;
}

export function createClogSyncer({
  db,
  config,
  provider,
  log,
  now = systemClock,
}: ClogSyncerOptions): ClogSyncer {
  const running = new Map<number, Promise<void>>();
  let stopped = false;
  const sourceActive = () => isSourceActive(config, provider.source);

  function setStatus(accountId: number, values: Partial<ClogSourceRow>): void {
    db.update(accountClogSources)
      .set(values)
      .where(eq(accountClogSources.accountId, accountId))
      .run();
  }

  function latestHash(tx: Queryable, accountId: number): string | null {
    return (
      tx
        .select({ contentHash: externalSnapshots.contentHash })
        .from(externalSnapshots)
        .where(
          and(
            eq(externalSnapshots.accountId, accountId),
            eq(externalSnapshots.source, provider.source),
            eq(externalSnapshots.kind, 'COLLECTION_LOG' satisfies SnapshotKind),
          ),
        )
        .orderBy(desc(externalSnapshots.id))
        .limit(1)
        .get()?.contentHash ?? null
    );
  }

  /** Stores a body unchanged and applies it. */
  function store(
    tx: Queryable,
    accountId: number,
    kind: SnapshotKind,
    raw: RawBody,
    fetchedAt: string,
  ): void {
    storeExternalSnapshot(tx, { source: provider.source, kind, accountId, fetchedAt, ...raw }, log);
  }

  /** A feed page is stored once: the same page read again adds nothing. */
  function feedPageStored(tx: Queryable, accountId: number, contentHash: string): boolean {
    return (
      tx
        .select({ id: externalSnapshots.id })
        .from(externalSnapshots)
        .where(
          and(
            eq(externalSnapshots.accountId, accountId),
            eq(externalSnapshots.source, provider.source),
            eq(externalSnapshots.kind, 'ACTIVITIES' satisfies SnapshotKind),
            eq(externalSnapshots.contentHash, contentHash),
          ),
        )
        .limit(1)
        .get() !== undefined
    );
  }

  async function run(accountId: number, row: ClogSourceRow): Promise<void> {
    const startedAt = now();
    // Before the request, so a crash mid-sync still counts as an attempt.
    setStatus(accountId, { lastAttemptAt: startedAt.toISOString() });

    const account = db.select().from(accounts).where(eq(accounts.id, accountId)).get();
    const name = lookupName(account?.displayName ?? null);
    // The current name period: the guard runs once for each.
    const period = db
      .select({ firstSeenAt: accountNames.firstSeenAt })
      .from(accountNames)
      .where(eq(accountNames.accountId, accountId))
      .orderBy(desc(accountNames.firstSeenAt), desc(accountNames.firstEventId))
      .limit(1)
      .get();
    // Without a name, or without a record of when we first saw it, the guard
    // cannot run: nothing is looked up.
    if (name === null || period === undefined) {
      setStatus(accountId, { status: 'NO_NAME' satisfies ClogSyncStatus });
      return;
    }
    const guardSince = period.firstSeenAt !== row.verifiedNamePeriod ? period.firstSeenAt : null;

    const feedSyncedMs = row.feedSyncedAt === null ? null : Date.parse(row.feedSyncedAt);
    // Due when its history was never read, or when the read after the latest change failed.
    const feedDue =
      feedSyncedMs === null ||
      (row.lastChangedAt !== null && Date.parse(row.lastChangedAt) > feedSyncedMs);

    recordAttempt(db, 'RUNEPROFILE', startedAt);
    const result = await provider.fetch({
      name,
      guardSince,
      knownHash: latestHash(db, accountId),
      feedDue,
      feedFrom:
        feedSyncedMs === null ? null : new Date(feedSyncedMs - FEED_OVERLAP_MS).toISOString(),
      cancelled: () => stopped,
    });
    // The server is stopping: the database may already be closed.
    if (stopped) return;
    const at = now();
    const fetchedAt = at.toISOString();

    // Turned off while the request was out (also if it was turned on again
    // since: that is a new opt-in, and this sync was not started for it).
    // Nothing is stored.
    const current = clogSourceRow(db, accountId);
    if (current?.enabledAt !== row.enabledAt) return;

    // Paths and codes only: never a value, a name or the body.
    if (result.formatProblem) {
      log.warn(
        {
          accountId,
          source: provider.source,
          endpoint: result.formatProblem.endpoint,
          issues: result.formatProblem.issues,
        },
        'A collection log response had an unexpected format',
      );
    }

    if (!result.ok) {
      setStatus(accountId, {
        status: result.status,
        ...(result.guardPassed && guardSince !== null ? { verifiedNamePeriod: guardSince } : {}),
      });
      const sourceError = SOURCE_ERRORS[result.status];
      if (sourceError !== undefined) recordFailure(db, 'RUNEPROFILE', at, sourceError);
      // The source answered, e.g. "no such profile". `SOURCE_OFF` made no request.
      else if (result.status !== 'SOURCE_OFF') recordSuccess(db, 'RUNEPROFILE', at);
      log.warn({ accountId, status: result.status }, 'Collection log sync failed');
      return;
    }

    let storedPages = 0;
    db.transaction(
      (tx) => {
        // Also when unchanged: the time it was read is what ties a later new
        // item to the session in between.
        recordClogRead(tx, accountId, fetchedAt);
        if (result.collectionLog) {
          store(tx, accountId, 'COLLECTION_LOG', result.collectionLog, fetchedAt);
        }
        // Oldest page first, so the stored order is the order things happened in.
        for (const page of [...result.feedPages].reverse()) {
          if (feedPageStored(tx, accountId, page.contentHash)) continue;
          store(tx, accountId, 'ACTIVITIES', page, fetchedAt);
          storedPages++;
        }
        tx.update(accountClogSources)
          .set({
            status: 'OK' satisfies ClogSyncStatus,
            lastSuccessAt: fetchedAt,
            ...(result.collectionLog ? { lastChangedAt: fetchedAt } : {}),
            ...(guardSince !== null ? { verifiedNamePeriod: guardSince } : {}),
            // The feed was read up to when this sync started.
            ...(result.feedRead && (result.collectionLog !== null || feedDue)
              ? { feedSyncedAt: fetchedAt }
              : {}),
          })
          .where(eq(accountClogSources.accountId, accountId))
          .run();
      },
      { behavior: 'immediate' },
    );
    const feedError = result.feedFailure === null ? undefined : SOURCE_ERRORS[result.feedFailure];
    if (feedError === undefined) recordSuccess(db, 'RUNEPROFILE', at);
    else recordFailure(db, 'RUNEPROFILE', at, feedError);
    log.info(
      {
        accountId,
        changed: result.collectionLog !== null,
        feedPages: storedPages,
        ...(result.feedFailure === null ? {} : { feedFailure: result.feedFailure }),
      },
      'Collection log synced',
    );
  }

  function begin(accountId: number): SyncStart {
    if (stopped) return { started: false, reason: 'SOURCE_OFF' };
    if (running.has(accountId)) return { started: false, reason: 'RUNNING' };
    const row = clogSourceRow(db, accountId);
    if (row?.source !== provider.source) return { started: false, reason: 'NO_SOURCE' };
    if (!sourceActive()) return { started: false, reason: 'SOURCE_OFF' };
    const nowMs = now().getTime();
    const next = nextSyncAllowedMs(row, nowMs);
    if (next > nowMs) return { started: false, reason: 'TOO_SOON', retryAt: new Date(next) };

    const done = (async () => {
      await run(accountId, row);
    })()
      .catch((error: unknown) => {
        // Cancelled, or failed because the server is stopping.
        if (stopped) return;
        log.error({ err: error, accountId }, 'Collection log sync failed unexpectedly');
        try {
          if (clogSourceRow(db, accountId)?.enabledAt === row.enabledAt) {
            setStatus(accountId, { status: 'UNAVAILABLE' satisfies ClogSyncStatus });
          }
          // Settings → Server must not show the source as fine.
          recordFailure(db, 'RUNEPROFILE', now(), UNEXPECTED_ERROR);
        } catch (storeError) {
          log.error({ err: storeError }, 'Could not store the collection log sync status');
        }
      })
      .finally(() => {
        running.delete(accountId);
      });
    running.set(accountId, done);
    return { started: true };
  }

  return {
    start: begin,
    async sync(accountId) {
      const result = begin(accountId);
      await running.get(accountId);
      return result;
    },
    isSyncing: (accountId) => running.has(accountId),
    sourceActive,
    async idle() {
      while (running.size > 0) await Promise.all(running.values());
    },
    async shutdown(waitMs = SHUTDOWN_WAIT_MS) {
      stopped = true;
      if (running.size === 0) return;
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, waitMs);
        timer.unref();
      });
      await Promise.race([Promise.all(running.values()), timeout]);
      clearTimeout(timer);
    },
  };
}

/**
 * Turns the account's source on or off. The row is kept either way: turning
 * it off only stops the lookups, and turning it on again goes on from the
 * same state, so the minute limit holds and the feed's history is not read
 * again. Turning it on when it already is changes nothing.
 */
export function setClogSource(
  db: Queryable,
  accountId: number,
  source: ClogSourceRow['source'] | null,
  now: Date,
): void {
  if (source === null) {
    db.update(accountClogSources)
      .set({ enabled: false })
      .where(eq(accountClogSources.accountId, accountId))
      .run();
    return;
  }
  const enabledAt = now.toISOString();
  db.insert(accountClogSources)
    .values({ accountId, source, enabled: true, enabledAt })
    .onConflictDoUpdate({
      target: accountClogSources.accountId,
      set: { source, enabled: true, enabledAt },
      // Only a source that is off is turned on.
      setWhere: eq(accountClogSources.enabled, false),
    })
    .run();
}
