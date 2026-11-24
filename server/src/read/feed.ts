import {
  CLOG_ALL_PETS_PAGE,
  compareFeedEntries,
  FEED_TYPES,
  feedTypeRank,
  type FeedClogEntry,
  type FeedDropEntry,
  type FeedEntry,
  type FeedLevelEntry,
  type FeedResponse,
  type FeedSessionEntry,
  type FeedType,
} from '@fireside/shared';
import { and, asc, desc, eq, inArray, isNotNull, lt, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import type { Queryable } from '../db/index.js';
import {
  clogItems,
  clogObtained,
  clogSnapshots,
  lootEvents,
  lootItems,
  sessionSummaries,
  sessions,
  xpSnapshotSkills,
  xpSnapshots,
} from '../db/schema.js';
import { ApiError } from '../errors.js';
import { cursorParts, decodeCursor, encodeCursor } from './cursor.js';
import { dropRows, type DropRow } from './loot.js';
import { pets } from './pets.js';
import { clogPlaces, latestClogCounts, sessionOfClogItem } from './session-clog.js';
import { apiSessions } from './sessions.js';

// `GET …/feed`: sessions, drops worth at least `minValue`, new
// collection log items, level-ups and pets, newest first, for "Latest" on Home.
// Computed on read from the derived tables, so it is the same after a
// `rebuild`; entry IDs and the cursor use only keys from the raw data.
//
// Each type is a source that gives its entries before a time, newest first,
// and all of its entries at one time. A page takes `limit + 1` entries from
// every source requested, plus the rest of the group at the last time each
// source returned (so equal times are never cut in a different order than the
// feed's), merges them in feed order and keeps `limit`. A source's entries
// that were not fetched are all older than `limit + 1` entries of its own, so
// they can't belong on the page.

/** Cursor: the last entry's (`at`, type rank, `id`). */
const feedCursorSchema = z.tuple([
  cursorParts.timestamp,
  z
    .int()
    .min(0)
    .max(FEED_TYPES.length - 1),
  z.string().min(1).max(200),
]);

interface Source {
  /** Up to about `limit` newest entries with `at < before` (all when `before` is undefined). */
  before(before: string | undefined, limit: number): FeedEntry[];
  /** Every entry with exactly this `at`. */
  at(at: string): FeedEntry[];
}

export interface FeedOptions {
  accountIds: readonly number[];
  types: readonly FeedType[];
  minValue: number;
  cursor?: string | undefined;
  limit: number;
}

// --- Sessions -------------------------------------------------------------------

/** A closed session's end, an open one's last heartbeat. */
const sessionAt = sql<string>`coalesce(${sessions.endedAt}, ${sessions.lastHeartbeatAt})`;

function sessionSource(db: Queryable, accountIds: readonly number[]): Source {
  const read = (where: SQL, limit?: number): FeedEntry[] => {
    const query = db
      .select({ session: sessions, summary: sessionSummaries })
      .from(sessions)
      .leftJoin(sessionSummaries, eq(sessionSummaries.sessionId, sessions.id))
      .where(and(inArray(sessions.accountId, accountIds), where))
      .orderBy(desc(sessionAt), desc(sessions.id));
    const rows = limit === undefined ? query.all() : query.limit(limit).all();
    return apiSessions(db, rows).map((session, index): FeedSessionEntry => ({
      type: 'session',
      id: `session:${session.id}`,
      at: session.endedAt ?? rows[index]?.session.lastHeartbeatAt ?? session.startedAt,
      accountId: session.accountId,
      session,
    }));
  };
  return {
    before: (before, limit) =>
      read(before === undefined ? sql`1` : sql`${sessionAt} < ${before}`, limit),
    at: (at) => read(sql`${sessionAt} = ${at}`),
  };
}

// --- Collection log ---------------------------------------------------------------

/**
 * The first own drop of the item in the session: the one that made it new.
 * `null` when the session has none.
 */
function firstDropOf(
  db: Queryable,
  sessionId: string,
  itemId: number,
): { lootEventId: number; eventId: string; position: number; geValue: number } | null {
  return (
    db
      .select({
        lootEventId: lootEvents.id,
        eventId: lootEvents.eventId,
        position: lootItems.position,
        geValue: sql<number>`${lootItems.quantity} * ${lootItems.gePriceEach}`,
      })
      .from(lootEvents)
      .innerJoin(lootItems, eq(lootItems.lootEventId, lootEvents.id))
      .where(and(eq(lootEvents.sessionId, sessionId), eq(lootItems.itemId, itemId)))
      .orderBy(asc(lootEvents.occurredAt), asc(lootEvents.eventId), asc(lootItems.position))
      .limit(1)
      .get() ?? null
  );
}

/** Items in the account's latest collection log. */
const listedWhere = sql`EXISTS (SELECT 1 FROM ${clogItems} WHERE ${clogItems.accountId} = ${clogObtained.accountId} AND ${clogItems.itemId} = ${clogObtained.itemId})`;

/**
 * Items the feed shows as `clog`: listed in the latest collection log (so
 * they have a name and page), of an account with a stored collection log (so
 * a total), and not pets. All in SQL, so every row read becomes an entry and
 * a page of `limit + 1` rows is `limit + 1` entries.
 */
const clogEntryWhere = and(
  isNotNull(clogObtained.firstSeenAt),
  listedWhere,
  sql`EXISTS (SELECT 1 FROM ${clogSnapshots} WHERE ${clogSnapshots.accountId} = ${clogObtained.accountId})`,
  sql`NOT EXISTS (SELECT 1 FROM ${clogItems} WHERE ${clogItems.accountId} = ${clogObtained.accountId} AND ${clogItems.itemId} = ${clogObtained.itemId} AND ${clogItems.page} = ${CLOG_ALL_PETS_PAGE})`,
);

interface ClogRow {
  accountId: number;
  itemId: number;
  at: string;
  approximate: boolean;
}

/**
 * Whether a drop is the one a `clog` entry stands for: the item is a new
 * collection log item the feed shows, tied to the drop's session, and this is
 * its first own drop there.
 */
function isClogDrop(db: Queryable, row: DropRow): boolean {
  const { drop } = row;
  const item = db
    .select({ at: clogObtained.firstSeenAt, approximate: clogObtained.approximate })
    .from(clogObtained)
    .where(
      and(
        eq(clogObtained.accountId, drop.accountId),
        eq(clogObtained.itemId, drop.itemId),
        clogEntryWhere,
      ),
    )
    .get();
  if (item?.at == null) return false;
  const sessionId = sessionOfClogItem(db, {
    accountId: drop.accountId,
    itemId: drop.itemId,
    at: item.at,
    approximate: item.approximate,
  });
  if (sessionId !== drop.sessionId) return false;
  const first = firstDropOf(db, sessionId, drop.itemId);
  return first?.eventId === row.eventId && first.position === row.position;
}

function clogSource(db: Queryable, accountIds: readonly number[]): Source {
  const places = new Map<number, ReturnType<typeof clogPlaces>>();
  const totals = new Map<number, number | null>();
  const placeOf = (accountId: number, itemId: number) => {
    let map = places.get(accountId);
    if (!map) {
      map = clogPlaces(db, accountId);
      places.set(accountId, map);
    }
    return map.get(itemId);
  };
  const totalOf = (accountId: number) => {
    if (!totals.has(accountId))
      totals.set(accountId, latestClogCounts(db, accountId)?.total ?? null);
    return totals.get(accountId) ?? null;
  };
  /**
   * The account's listed items in the order they were obtained (no time
   * first, then time and item ID), read once per request.
   */
  const orders = new Map<number, { at: string | null; itemId: number }[]>();
  const orderOf = (accountId: number) => {
    let order = orders.get(accountId);
    if (!order) {
      order = db
        .select({ at: clogObtained.firstSeenAt, itemId: clogObtained.itemId })
        .from(clogObtained)
        .where(and(eq(clogObtained.accountId, accountId), listedWhere))
        .all()
        .sort((a, b) =>
          a.at === b.at
            ? a.itemId - b.itemId
            : a.at === null
              ? -1
              : b.at === null
                ? 1
                : a.at < b.at
                  ? -1
                  : 1,
        );
      orders.set(accountId, order);
    }
    return order;
  };
  /** Unique listed items the account had up to and including this one. */
  const obtainedAfter = (row: ClogRow) => {
    const order = orderOf(row.accountId);
    // Binary search for the first item after (at, itemId).
    let low = 0;
    let high = order.length;
    while (low < high) {
      const mid = (low + high) >> 1;
      const item = order[mid];
      const before =
        item !== undefined &&
        (item.at === null || item.at < row.at || (item.at === row.at && item.itemId <= row.itemId));
      if (before) low = mid + 1;
      else high = mid;
    }
    return low;
  };

  const entry = (row: ClogRow): FeedClogEntry[] => {
    const place = placeOf(row.accountId, row.itemId);
    const total = totalOf(row.accountId);
    if (!place || total === null) return [];
    const sessionId = sessionOfClogItem(db, row);
    const drop = sessionId === null ? null : firstDropOf(db, sessionId, row.itemId);
    return [
      {
        type: 'clog',
        id: `clog:${String(row.accountId)}.${String(row.itemId)}`,
        at: row.at,
        accountId: row.accountId,
        itemId: row.itemId,
        name: place.name,
        tab: place.tab,
        page: place.page,
        approximate: row.approximate,
        sessionId,
        obtainedAfter: Math.min(obtainedAfter(row), total),
        total,
        drop: drop === null ? null : { lootEventId: drop.lootEventId, geValue: drop.geValue },
      },
    ];
  };
  const read = (where: SQL, limit?: number): FeedEntry[] => {
    const query = db
      .select({
        accountId: clogObtained.accountId,
        itemId: clogObtained.itemId,
        at: clogObtained.firstSeenAt,
        approximate: clogObtained.approximate,
      })
      .from(clogObtained)
      .where(and(inArray(clogObtained.accountId, accountIds), clogEntryWhere, where))
      .orderBy(desc(clogObtained.firstSeenAt));
    const rows = limit === undefined ? query.all() : query.limit(limit).all();
    return rows.flatMap((row) => (row.at === null ? [] : entry({ ...row, at: row.at })));
  };
  return {
    before: (before, limit) =>
      read(before === undefined ? sql`1` : lt(clogObtained.firstSeenAt, before), limit),
    at: (at) => read(eq(clogObtained.firstSeenAt, at)),
  };
}

// --- Drops ------------------------------------------------------------------------

function dropSource(
  db: Queryable,
  accountIds: readonly number[],
  minValue: number,
  withClog: boolean,
): Source {
  const entry = (row: DropRow): FeedDropEntry[] => {
    const isNew = isClogDrop(db, row);
    // The clog entry stands for both when the feed has clog entries.
    if (isNew && withClog) return [];
    return [
      {
        type: 'drop',
        id: `drop:${row.eventId}.${String(row.position)}`,
        at: row.drop.occurredAt,
        accountId: row.drop.accountId,
        drop: row.drop,
        newCollectionLog: isNew,
      },
    ];
  };
  return {
    before(before, limit) {
      // Some rows may be left out (clog drops), so read on until enough are kept.
      const out: FeedEntry[] = [];
      let after: readonly [string, string, number] | undefined;
      for (;;) {
        const rows = dropRows(db, {
          accountIds,
          minValue,
          ...(before === undefined ? {} : { to: before }),
          after,
          limit,
        });
        for (const row of rows) out.push(...entry(row));
        const last = rows.at(-1);
        if (rows.length < limit || !last || out.length >= limit) return out;
        after = [last.drop.occurredAt, last.eventId, last.position];
      }
    },
    at(at) {
      const end = new Date(Date.parse(at) + 1).toISOString();
      return dropRows(db, { accountIds, minValue, from: at, to: end, limit: 1_000_000 }).flatMap(
        entry,
      );
    },
  };
}

// --- Level-ups ----------------------------------------------------------------------

/** Closed sessions read per query when walking back for level-ups. */
const LEVEL_SESSION_BATCH = 200;

interface LevelRow {
  sessionId: string;
  accountId: number;
  endedAt: string;
  skill: string;
  fromLevel: number;
  toLevel: number;
}

/**
 * Level-ups of a batch of closed sessions, newest first: per skill in both the
 * session's first and last XP snapshot, a higher level and more XP at the
 * end. The same rule as `sessionXp` (an `endLevel` above `startLevel` with
 * `xpGained > 0`), in one query per batch instead of four per session.
 */
function levelRows(
  db: Queryable,
  accountIds: readonly number[],
  where: SQL,
  limit: number,
  offset: number,
): { rows: LevelRow[]; sessions: number } {
  const batch = db
    .select({ id: sessions.id, accountId: sessions.accountId, endedAt: sessions.endedAt })
    .from(sessions)
    .where(and(inArray(sessions.accountId, accountIds), isNotNull(sessions.endedAt), where))
    .orderBy(desc(sessions.endedAt), desc(sessions.id))
    .limit(limit)
    .offset(offset)
    .all();
  if (batch.length === 0) return { rows: [], sessions: 0 };
  const ids = batch.map((row) => row.id);
  const levels = db.all<{
    sessionId: string;
    skill: string;
    fromLevel: number;
    toLevel: number;
  }>(sql`
    SELECT s.id AS sessionId, l.skill AS skill, f.level AS fromLevel, l.level AS toLevel
    FROM ${sessions} s
    JOIN ${xpSnapshotSkills} f ON f.snapshot_id = (
      SELECT x.id FROM ${xpSnapshots} x WHERE x.session_id = s.id
      ORDER BY x.taken_at, x.event_id LIMIT 1)
    JOIN ${xpSnapshotSkills} l ON l.snapshot_id = (
      SELECT x.id FROM ${xpSnapshots} x WHERE x.session_id = s.id
      ORDER BY x.taken_at DESC, x.event_id DESC LIMIT 1) AND l.skill = f.skill
    WHERE s.id IN ${ids} AND l.level > f.level AND l.xp > f.xp`);
  const bySession = new Map<string, typeof levels>();
  for (const level of levels) {
    bySession.set(level.sessionId, [...(bySession.get(level.sessionId) ?? []), level]);
  }
  const rows = batch.flatMap((session) =>
    (bySession.get(session.id) ?? []).map((level) => ({
      ...level,
      accountId: session.accountId,
      endedAt: session.endedAt ?? '',
    })),
  );
  return { rows, sessions: batch.length };
}

function levelSource(db: Queryable, accountIds: readonly number[]): Source {
  const entry = (row: LevelRow): FeedLevelEntry => ({
    type: 'level',
    id: `level:${row.sessionId}.${row.skill}`,
    at: row.endedAt,
    accountId: row.accountId,
    sessionId: row.sessionId,
    skill: row.skill,
    fromLevel: row.fromLevel,
    toLevel: row.toLevel,
  });
  return {
    before(before, limit) {
      // Sessions without a level-up are many: walk back in batches.
      const where = before === undefined ? sql`1` : lt(sessions.endedAt, before);
      const out: FeedEntry[] = [];
      for (let offset = 0; ; offset += LEVEL_SESSION_BATCH) {
        const batch = levelRows(db, accountIds, where, LEVEL_SESSION_BATCH, offset);
        out.push(...batch.rows.map(entry));
        if (out.length >= limit || batch.sessions < LEVEL_SESSION_BATCH) return out;
      }
    },
    at: (at) => levelRows(db, accountIds, eq(sessions.endedAt, at), 1_000_000, 0).rows.map(entry),
  };
}

// --- Pets ---------------------------------------------------------------------------

function petSource(db: Queryable, accountIds: readonly number[]): Source {
  // Few rows per account, read once per request.
  let all: FeedEntry[] | undefined;
  const entries = () =>
    (all ??= pets(db, accountIds)
      .pets.flatMap((pet) =>
        pet.obtainedAt === null
          ? []
          : [
              {
                type: 'pet' as const,
                id: `pet:${String(pet.accountId)}.${String(pet.itemId)}`,
                at: pet.obtainedAt,
                accountId: pet.accountId,
                pet,
              },
            ],
      )
      .sort(compareFeedEntries));
  return {
    before: (before, limit) =>
      entries()
        .filter((entry) => before === undefined || entry.at < before)
        .slice(0, limit),
    at: (at) => entries().filter((entry) => entry.at === at),
  };
}

// --- The feed -----------------------------------------------------------------------

/** One page of the feed for the given (owned) accounts. */
export function feed(db: Queryable, options: FeedOptions): FeedResponse {
  const { accountIds, types, limit } = options;
  if (accountIds.length === 0) return { items: [], nextCursor: null };
  const cursor =
    options.cursor === undefined ? undefined : decodeCursor(options.cursor, feedCursorSchema);
  const after = (entry: FeedEntry) => {
    if (cursor === undefined) return true;
    const [at, rank, id] = cursor;
    return compareFeedEntries({ at, type: typeOfRank(rank), id }, entry) < 0;
  };

  // A Map, not an object: the query schema already limits `types`, but a
  // lookup here can never reach an inherited property such as `constructor`.
  const sources = new Map<FeedType, () => Source>([
    ['session', () => sessionSource(db, accountIds)],
    ['level', () => levelSource(db, accountIds)],
    ['clog', () => clogSource(db, accountIds)],
    ['pet', () => petSource(db, accountIds)],
    ['drop', () => dropSource(db, accountIds, options.minValue, types.includes('clog'))],
  ]);

  const candidates: FeedEntry[] = [];
  for (const type of types) {
    const makeSource = sources.get(type);
    if (makeSource === undefined) {
      throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', [
        { path: 'query.types', message: `Unknown feed type: ${type}` },
      ]);
    }
    const source = makeSource();
    const before = cursor?.[0];
    if (before !== undefined) candidates.push(...source.at(before).filter(after));
    let rows = source.before(before, limit + 1);
    const last = rows.at(-1);
    if (rows.length > limit && last) {
      // Complete the group at the last time, so it is cut in feed order.
      rows = [...rows.filter((entry) => entry.at !== last.at), ...source.at(last.at)];
    }
    candidates.push(...rows);
  }
  candidates.sort(compareFeedEntries);
  const page = candidates.slice(0, limit);
  const last = page.at(-1);
  return {
    items: page,
    nextCursor:
      candidates.length > limit && last
        ? encodeCursor([last.at, feedTypeRank(last.type), last.id])
        : null,
  };
}

function typeOfRank(rank: number): FeedType {
  return FEED_TYPES[rank] ?? 'drop';
}
