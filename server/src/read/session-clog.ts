import { continuesHop, type SessionClogItem } from '@fireside/shared';
import { and, asc, desc, eq, gte, isNotNull, lt, lte, or } from 'drizzle-orm';
import type { Queryable } from '../db/index.js';
import { clogItems, clogObtained, clogReads, clogSnapshots, sessions } from '../db/schema.js';

// New collection log items per session. Computed on read from
// `clog_obtained`, `clog_reads`, `clog_snapshots` and `sessions`, so it needs
// no rebuild and is the same after one. The rule:
//
// - An exact time (from the activity feed) belongs to the account's session
//   whose span contains it: `[started_at, ended_at]`, or up to the last
//   heartbeat while the session is open. Between two hop parts, or outside
//   every session: no session.
// - An approximate time is the time `t` of the sync that first saw the item.
//   It belongs to session S only when the sync is S's post-session sync and
//   the item can't be from an earlier session:
//   - S is the account's latest session started at or before `t`, it ended
//     at or before `t` (so nothing was open or started since) and not with
//     `hop`, and `t` is at most `POST_SESSION_SYNC_WINDOW_MS` after its end;
//   - the session before S's hop chain ended at or before the previous
//     successful read (`clog_reads`; without one, the previous stored
//     collection log), so S's chain is the only play between the two reads.
//   An earlier session whose own sync failed lies between the two reads, and
//   then the item is tied to no session rather than a guessed one.

/**
 * How long after a session's end its post-session sync may come. A timed-out
 * session's `ended_at` is its last heartbeat, and it is only closed 10 minutes
 * later (`SESSION_TIMEOUT_MS`); the sync follows 2 minutes after that
 * (`SESSION_END_DELAY_MS`), at the next one-minute check. 15 minutes covers
 * that with some slack.
 */
export const POST_SESSION_SYNC_WINDOW_MS = 15 * 60_000;

/** The session columns the rule needs. */
interface Span {
  id: string;
  accountId: number;
  startedAt: string;
  endedAt: string | null;
  endReason: string | null;
  lastHeartbeatAt: string;
}

const spanColumns = {
  id: sessions.id,
  accountId: sessions.accountId,
  startedAt: sessions.startedAt,
  endedAt: sessions.endedAt,
  endReason: sessions.endReason,
  lastHeartbeatAt: sessions.lastHeartbeatAt,
};

/** A new collection log item with a time, as `clog_obtained` has it. */
export interface DatedClogItem {
  accountId: number;
  itemId: number;
  at: string;
  approximate: boolean;
}

const end = (span: Span) => span.endedAt ?? span.lastHeartbeatAt;

/** The account's latest session started at or before `at` (same order as the list). */
function latestStartedBy(db: Queryable, accountId: number, at: string): Span | undefined {
  return db
    .select(spanColumns)
    .from(sessions)
    .where(and(eq(sessions.accountId, accountId), lte(sessions.startedAt, at)))
    .orderBy(desc(sessions.startedAt), desc(sessions.id))
    .limit(1)
    .get();
}

/** The account's session just before `span` in list order. */
function previousSession(db: Queryable, span: Span): Span | undefined {
  // Strictly before in list order, also when another session has the same start.
  return db
    .select(spanColumns)
    .from(sessions)
    .where(
      and(
        eq(sessions.accountId, span.accountId),
        or(
          lt(sessions.startedAt, span.startedAt),
          and(eq(sessions.startedAt, span.startedAt), lt(sessions.id, span.id)),
        ),
      ),
    )
    .orderBy(desc(sessions.startedAt), desc(sessions.id))
    .limit(1)
    .get();
}

/** The latest successful read of the account's collection log before `at`, if any. */
function previousRead(db: Queryable, accountId: number, at: string): string | undefined {
  const read = db
    .select({ at: clogReads.readAt })
    .from(clogReads)
    .where(and(eq(clogReads.accountId, accountId), lt(clogReads.readAt, at)))
    .orderBy(desc(clogReads.readAt))
    .limit(1)
    .get()?.at;
  // Older databases have no recorded reads: the previous stored collection log
  // is then the latest time known to be before the item.
  const stored = db
    .select({ at: clogSnapshots.takenAt })
    .from(clogSnapshots)
    .where(and(eq(clogSnapshots.accountId, accountId), lt(clogSnapshots.takenAt, at)))
    .orderBy(desc(clogSnapshots.takenAt), desc(clogSnapshots.snapshotId))
    .limit(1)
    .get()?.at;
  if (read === undefined) return stored;
  if (stored === undefined) return read;
  return read > stored ? read : stored;
}

/** The session an item is tied to, or `null`. */
export function sessionOfClogItem(db: Queryable, item: DatedClogItem): string | null {
  const latest = latestStartedBy(db, item.accountId, item.at);
  if (!latest) return null;
  if (!item.approximate) return end(latest) >= item.at ? latest.id : null;

  // Approximate: `item.at` is the time of the sync that first saw the item.
  const session = latest;
  if (session.endedAt === null || session.endedAt > item.at) return null;
  if (session.endReason === 'hop') return null;
  if (Date.parse(item.at) - Date.parse(session.endedAt) > POST_SESSION_SYNC_WINDOW_MS) return null;
  const readBefore = previousRead(db, item.accountId, item.at);
  if (readBefore === undefined) return null;
  // Back to the first part of the hop chain, then the session before it.
  let first = session;
  let before = previousSession(db, first);
  while (before && continuesHop(before, first)) {
    first = before;
    before = previousSession(db, first);
  }
  if (before && end(before) > readBefore) return null;
  return session.id;
}

/**
 * Dated new items of the accounts first seen in `[from, to]`, also those the
 * latest collection log no longer lists (callers that show items skip them).
 */
function datedItems(db: Queryable, accountId: number, from: string, to: string): DatedClogItem[] {
  return db
    .select({
      itemId: clogObtained.itemId,
      at: clogObtained.firstSeenAt,
      approximate: clogObtained.approximate,
    })
    .from(clogObtained)
    .where(
      and(
        eq(clogObtained.accountId, accountId),
        isNotNull(clogObtained.firstSeenAt),
        gte(clogObtained.firstSeenAt, from),
        lte(clogObtained.firstSeenAt, to),
      ),
    )
    .all()
    .flatMap((row) =>
      row.at === null
        ? []
        : [{ accountId, itemId: row.itemId, at: row.at, approximate: row.approximate }],
    );
}

/** Where each item first appears in the account's latest collection log, in the game's order. */
export interface ClogPlace {
  name: string;
  tab: string;
  page: string;
  pageObtained: number;
  pageTotal: number;
}

/** Name and first page of every item in the account's latest collection log, with page counts. */
export function clogPlaces(db: Queryable, accountId: number): Map<number, ClogPlace> {
  const rows = db
    .select({
      itemId: clogItems.itemId,
      name: clogItems.name,
      tabPosition: clogItems.tabPosition,
      pagePosition: clogItems.pagePosition,
      tab: clogItems.tab,
      page: clogItems.page,
      quantity: clogItems.quantity,
    })
    .from(clogItems)
    .where(eq(clogItems.accountId, accountId))
    .orderBy(asc(clogItems.tabPosition), asc(clogItems.pagePosition), asc(clogItems.position))
    .all();
  const pages = new Map<string, { obtained: number; total: number }>();
  for (const row of rows) {
    const key = `${String(row.tabPosition)}.${String(row.pagePosition)}`;
    const page = pages.get(key) ?? { obtained: 0, total: 0 };
    page.total += 1;
    if (row.quantity > 0) page.obtained += 1;
    pages.set(key, page);
  }
  const places = new Map<number, ClogPlace>();
  for (const row of rows) {
    if (places.has(row.itemId)) continue;
    const page = pages.get(`${String(row.tabPosition)}.${String(row.pagePosition)}`);
    places.set(row.itemId, {
      name: row.name,
      tab: row.tab,
      page: row.page,
      pageObtained: page?.obtained ?? 0,
      pageTotal: page?.total ?? 1,
    });
  }
  return places;
}

/** Item IDs in the account's latest collection log. */
function listedItems(db: Queryable, accountId: number): Set<number> {
  return new Set(
    db
      .selectDistinct({ itemId: clogItems.itemId })
      .from(clogItems)
      .where(eq(clogItems.accountId, accountId))
      .all()
      .map((row) => row.itemId),
  );
}

/**
 * The new collection log items tied to each of `spans`, by session ID, oldest
 * first (then by item ID). Only items the latest collection log lists, as on
 * the Collection log page and in Weekly. One query per account for the items,
 * then a few indexed lookups per item.
 */
export function tiedClogItems(db: Queryable, spans: readonly Span[]): Map<string, DatedClogItem[]> {
  const tied = new Map<string, DatedClogItem[]>(spans.map((span) => [span.id, []]));
  const byAccount = new Map<number, Span[]>();
  for (const span of spans)
    byAccount.set(span.accountId, [...(byAccount.get(span.accountId) ?? []), span]);
  for (const [accountId, accountSpans] of byAccount) {
    const from = accountSpans.reduce(
      (min, span) => (span.startedAt < min ? span.startedAt : min),
      accountSpans[0]?.startedAt ?? '',
    );
    const lastEnd = accountSpans.reduce((max, span) => (end(span) > max ? end(span) : max), '');
    const to = new Date(Date.parse(lastEnd) + POST_SESSION_SYNC_WINDOW_MS).toISOString();
    const items = datedItems(db, accountId, from, to);
    if (items.length === 0) continue;
    const listed = listedItems(db, accountId);
    for (const item of items) {
      if (!listed.has(item.itemId)) continue;
      const sessionId = sessionOfClogItem(db, item);
      if (sessionId !== null) tied.get(sessionId)?.push(item);
    }
  }
  for (const list of tied.values()) {
    list.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.itemId - b.itemId));
  }
  return tied;
}

/** Unique items obtained and in total in the account's latest collection log. */
export function latestClogCounts(
  db: Queryable,
  accountId: number,
): { obtained: number; total: number } | null {
  return (
    db
      .select({ obtained: clogSnapshots.obtained, total: clogSnapshots.total })
      .from(clogSnapshots)
      .where(eq(clogSnapshots.accountId, accountId))
      .orderBy(desc(clogSnapshots.takenAt), desc(clogSnapshots.snapshotId))
      .limit(1)
      .get() ?? null
  );
}

/** The session's collection log section for `GET /sessions/:id`. */
export function sessionCollectionLog(
  db: Queryable,
  span: Span,
): { obtained: number | null; total: number | null; items: SessionClogItem[] } {
  const counts = latestClogCounts(db, span.accountId);
  const items = tiedClogItems(db, [span]).get(span.id) ?? [];
  const places = items.length > 0 ? clogPlaces(db, span.accountId) : new Map<number, ClogPlace>();
  return {
    obtained: counts?.obtained ?? null,
    total: counts?.total ?? null,
    items: items.flatMap((item) => {
      const place = places.get(item.itemId);
      if (!place) return [];
      return [{ itemId: item.itemId, ...place, at: item.at, approximate: item.approximate }];
    }),
  };
}
