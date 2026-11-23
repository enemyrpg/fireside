import {
  compareSkills,
  type AfkPeriod,
  type Page,
  type Session,
  type SessionCloseReason,
  type SessionDetailResponse,
  type SessionKc,
  type SessionLoot,
  type SessionNeighbors,
  type SessionSummary,
  type SessionXp,
} from '@fireside/shared';
import { and, asc, desc, eq, gt, gte, inArray, lt, or, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import type { Queryable } from '../db/index.js';
import {
  kcObservations,
  lootEvents,
  lootItems,
  sessionSummaries,
  sessions,
  xpSnapshots,
  type SessionRow,
  type SessionSummaryRow,
} from '../db/schema.js';
import { bossKc } from '../projections/session-summaries.js';
import { afkPeriodsOfSession } from './afk-periods.js';
import { cursorParts, decodeCursor, encodeCursor } from './cursor.js';
import { apiSource } from './loot.js';
import { sessionCollectionLog, tiedClogItems } from './session-clog.js';
import { gainStart, skillsOf } from './xp.js';

// `GET …/sessions` and `GET /sessions/:sessionId`. Reads `sessions`,
// `session_summaries`, `session_afk_periods` and `session_afk_estimates`, `xp_snapshots`, `loot_events` and
// `kc_observations`, and for the collection log `clog_obtained`, `clog_reads` and
// `clog_snapshots`.

const compareText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

function apiSummary(row: SessionSummaryRow | null): SessionSummary | null {
  if (!row) return null;
  return {
    xpGainedTotal: row.xpGainedTotal,
    xpGainedBySkill: JSON.parse(row.xpGainedBySkill) as Record<string, number>,
    lootGeValue: row.lootGeValue,
    lootCount: row.lootCount,
    kcGainedByBoss: JSON.parse(row.kcGainedByBoss) as Record<string, number>,
  };
}

/** `newCollectionLogCount` is from `tiedClogItems` (server/src/read/session-clog.ts). */
export function apiSession(
  row: SessionRow,
  summary: SessionSummaryRow | null,
  newCollectionLogCount: number,
): Session {
  return {
    id: row.id,
    accountId: row.accountId,
    startedAt: row.startedAt,
    endedAt: row.endedAt,
    endReason: row.endReason as SessionCloseReason | null,
    world: row.world,
    durationSeconds: row.durationSeconds,
    activeSeconds: row.activeSeconds,
    afkSeconds: row.afkSeconds,
    // A summary only exists while the session is closed.
    summary: apiSummary(summary),
    newCollectionLogCount,
  };
}

/** Sessions with their summaries, as the API gives them, with the collection log count. */
export function apiSessions(
  db: Queryable,
  rows: readonly { session: SessionRow; summary: SessionSummaryRow | null }[],
): Session[] {
  const clog = tiedClogItems(
    db,
    rows.map((row) => row.session),
  );
  return rows.map((row) =>
    apiSession(row.session, row.summary, clog.get(row.session.id)?.length ?? 0),
  );
}

// --- List ---------------------------------------------------------------------

/** Cursor key: the last session's (`started_at`, `id`). */
const sessionCursorSchema = z.tuple([cursorParts.timestamp, cursorParts.eventId]);

export interface SessionsOptions {
  /** The accounts to list: owned account IDs, resolved by the route. */
  accountIds: readonly number[];
  /** Sessions with `started_at` in `[from, to)`. Either end may be open. */
  from?: string | undefined;
  to?: string | undefined;
  cursor?: string | undefined;
  limit: number;
}

/** Sessions newest first (`started_at`, then `id`), with their summaries. */
export function listSessions(db: Queryable, options: SessionsOptions): Page<Session> {
  const conditions: (SQL | undefined)[] = [inArray(sessions.accountId, options.accountIds)];
  if (options.from !== undefined) conditions.push(gte(sessions.startedAt, options.from));
  if (options.to !== undefined) conditions.push(lt(sessions.startedAt, options.to));
  if (options.cursor !== undefined) {
    const [at, id] = decodeCursor(options.cursor, sessionCursorSchema);
    conditions.push(
      or(lt(sessions.startedAt, at), and(eq(sessions.startedAt, at), lt(sessions.id, id))),
    );
  }

  const rows = db
    .select({ session: sessions, summary: sessionSummaries })
    .from(sessions)
    .leftJoin(sessionSummaries, eq(sessionSummaries.sessionId, sessions.id))
    .where(and(...conditions))
    .orderBy(desc(sessions.startedAt), desc(sessions.id))
    .limit(options.limit + 1)
    .all();

  const page = rows.slice(0, options.limit);
  const last = page.at(-1)?.session;
  return {
    items: apiSessions(db, page),
    nextCursor:
      rows.length > options.limit && last ? encodeCursor([last.startedAt, last.id]) : null,
  };
}

// --- Detail -------------------------------------------------------------------

function sessionSnapshotId(
  db: Queryable,
  sessionId: string,
  which: 'first' | 'last',
): number | undefined {
  const order = which === 'first' ? asc : desc;
  return db
    .select({ id: xpSnapshots.id })
    .from(xpSnapshots)
    .where(eq(xpSnapshots.sessionId, sessionId))
    .orderBy(order(xpSnapshots.takenAt), order(xpSnapshots.eventId))
    .limit(1)
    .get()?.id;
}

/**
 * XP per skill from the session's first to its last snapshot. Skills in both
 * with a gain, also unknown ones. A drop in XP or level (odd data) gives no
 * gain, as in gains and the summary.
 */
function sessionXp(db: Queryable, sessionId: string): SessionXp[] {
  const firstId = sessionSnapshotId(db, sessionId, 'first');
  const lastId = sessionSnapshotId(db, sessionId, 'last');
  if (firstId === undefined || lastId === undefined || firstId === lastId) return [];
  const first = skillsOf(db, firstId);
  const xp: SessionXp[] = [];
  for (const [skill, end] of skillsOf(db, lastId)) {
    const start = first.get(skill);
    if (!start) continue;
    const from = gainStart(start, end);
    const xpGained = end.xp - from.xp;
    if (xpGained > 0) xp.push({ skill, xpGained, startLevel: from.level, endLevel: end.level });
  }
  return xp.sort((a, b) => compareSkills(a.skill, b.skill));
}

/** Loot events in the session, oldest first, items in payload order. */
function sessionLoot(db: Queryable, sessionId: string): SessionLoot[] {
  const rows = db
    .select({
      id: lootEvents.id,
      occurredAt: lootEvents.occurredAt,
      sourceType: lootEvents.sourceType,
      sourceName: lootEvents.sourceName,
      killCount: lootEvents.killCount,
      geValue: lootEvents.totalGeValue,
      haValue: lootEvents.totalHaValue,
      itemId: lootItems.itemId,
      name: lootItems.itemName,
      quantity: lootItems.quantity,
      gePriceEach: lootItems.gePriceEach,
      haPriceEach: lootItems.haPriceEach,
    })
    .from(lootEvents)
    .innerJoin(lootItems, eq(lootItems.lootEventId, lootEvents.id))
    .where(eq(lootEvents.sessionId, sessionId))
    .orderBy(asc(lootEvents.occurredAt), asc(lootEvents.eventId), asc(lootItems.position))
    .all();

  const loot: SessionLoot[] = [];
  for (const row of rows) {
    let current = loot.at(-1);
    if (current?.id !== row.id) {
      current = {
        id: row.id,
        occurredAt: row.occurredAt,
        source: apiSource(row.sourceType, row.sourceName),
        killCount: row.killCount,
        geValue: row.geValue,
        haValue: row.haValue,
        items: [],
      };
      loot.push(current);
    }
    current.items.push({
      itemId: row.itemId,
      name: row.name,
      quantity: row.quantity,
      gePriceEach: row.gePriceEach,
      haPriceEach: row.haPriceEach,
    });
  }
  return loot;
}

/** KC per boss seen in the session, by boss name. Same rule as the summary. */
function sessionKc(db: Queryable, sessionId: string): SessionKc[] {
  const bosses = db
    .selectDistinct({ boss: kcObservations.boss })
    .from(kcObservations)
    .where(eq(kcObservations.sessionId, sessionId))
    .all()
    .map((row) => row.boss)
    .sort(compareText);
  const kc: SessionKc[] = [];
  for (const boss of bosses) {
    const found = bossKc(db, sessionId, boss);
    if (!found) continue;
    // Never negative: a lower KC than before (odd data) starts at the end.
    const start = Math.min(found.start, found.end);
    kc.push({ boss, startKillCount: start, endKillCount: found.end, gained: found.end - start });
  }
  return kc;
}

/**
 * AFK periods clipped to the session (`started_at` to `ended_at`, or the last
 * heartbeat while open, like `duration_seconds`). Overlapping or touching
 * periods are merged, so they add up to `afkSeconds` (before rounding down).
 */
function clippedAfkPeriods(db: Queryable, session: SessionRow): AfkPeriod[] {
  if (session.durationSeconds === 0) return [];
  const start = Date.parse(session.startedAt);
  const end = Date.parse(session.endedAt ?? session.lastHeartbeatAt);
  const clipped = afkPeriodsOfSession(db, session.id)
    .map((period) => ({
      start: Math.max(Date.parse(period.startedAt), start),
      end: Math.min(Date.parse(period.endedAt), end),
    }))
    .filter((period) => period.start < period.end)
    .sort((a, b) => a.start - b.start);

  const merged: { start: number; end: number }[] = [];
  for (const period of clipped) {
    const last = merged.at(-1);
    if (last && period.start <= last.end) last.end = Math.max(last.end, period.end);
    else merged.push({ ...period });
  }
  return merged.map((period) => ({
    startedAt: new Date(period.start).toISOString(),
    endedAt: new Date(period.end).toISOString(),
  }));
}

/**
 * The sessions just before and after `session` for the same account, in list
 * order (`started_at`, then `id`), so equal start times are ordered by ID.
 * Two lookups on (`account_id`, `started_at`).
 */
function sessionNeighbors(db: Queryable, session: SessionRow): SessionNeighbors {
  const { accountId, startedAt, id } = session;
  const older = db
    .select({ id: sessions.id })
    .from(sessions)
    .where(
      and(
        eq(sessions.accountId, accountId),
        or(
          lt(sessions.startedAt, startedAt),
          and(eq(sessions.startedAt, startedAt), lt(sessions.id, id)),
        ),
      ),
    )
    .orderBy(desc(sessions.startedAt), desc(sessions.id))
    .limit(1)
    .get();
  const newer = db
    .select({ id: sessions.id })
    .from(sessions)
    .where(
      and(
        eq(sessions.accountId, accountId),
        or(
          gt(sessions.startedAt, startedAt),
          and(eq(sessions.startedAt, startedAt), gt(sessions.id, id)),
        ),
      ),
    )
    .orderBy(asc(sessions.startedAt), asc(sessions.id))
    .limit(1)
    .get();
  return { olderId: older?.id ?? null, newerId: newer?.id ?? null };
}

/**
 * One session in detail, or `undefined` if there is no session with this ID
 * on one of `accountIds` (the caller's own accounts): another user's session
 * is not found, the same as an unknown ID.
 */
export function sessionDetail(
  db: Queryable,
  accountIds: readonly number[],
  sessionId: string,
): SessionDetailResponse | undefined {
  // Session IDs are stored in lower case (see ingest).
  const id = sessionId.toLowerCase();
  const row = db
    .select({ session: sessions, summary: sessionSummaries })
    .from(sessions)
    .leftJoin(sessionSummaries, eq(sessionSummaries.sessionId, sessions.id))
    .where(and(eq(sessions.id, id), inArray(sessions.accountId, accountIds)))
    .get();
  if (!row) return undefined;
  const collectionLog = sessionCollectionLog(db, row.session);
  return {
    session: apiSession(row.session, row.summary, collectionLog.items.length),
    neighbors: sessionNeighbors(db, row.session),
    xp: sessionXp(db, id),
    loot: sessionLoot(db, id),
    kc: sessionKc(db, id),
    afkPeriods: clippedAfkPeriods(db, row.session),
    collectionLog,
  };
}
