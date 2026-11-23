import type {
  Event,
  EventType,
  SESSION_CLOSE_REASONS,
  SessionEndEvent,
  SessionStartEvent,
} from '@fireside/shared';
import { and, asc, desc, eq, isNotNull, isNull, lte, or, sql } from 'drizzle-orm';
import type { Db, Queryable } from '../db/index.js';
import {
  accounts,
  events,
  sessionAfkEstimates,
  sessionAfkPeriods,
  sessionHeartbeats,
  sessions,
} from '../db/schema.js';
import { weeklySummariesProjection } from './weekly-summaries.js';
import { compareEventRows, type Projection, type Stored } from './framework.js';
import { accountIdOf } from './lookup.js';
import { syncSessionSummary } from './session-summaries.js';

// `sessions`, `session_heartbeats`, `session_afk_periods` and
// `session_afk_estimates` (see docs/architecture.md#sessions).
//
// Heartbeats and AFK periods are keyed inserts. AFK estimates are rewritten
// for the session on every refresh, from its idle heartbeats and AFK periods. The session row is refreshed
// from its projected events on every `session.*` event, with one pure
// function (`deriveSession`) that also decides the timeout from the clock.
// The timeout job (`closeTimedOutSessions`) calls the same refresh, so a late
// `session.end` or a late heartbeat just changes the inputs: it replaces a
// timeout, extends it, or reopens the session.

/**
 * Rules version of this projection (see projections/versions.ts). 2: AFK
 * estimated from idle heartbeats.
 */
export const SESSIONS_VERSION = 2;

/** A session with no heartbeat for this long is closed with `timeout`. */
export const SESSION_TIMEOUT_MS = 10 * 60_000;

type SessionEventType = Extract<EventType, `session.${string}`>;

/** Why a session closed: a `session.end` reason, or `timeout`. */
export type SessionCloseReason = (typeof SESSION_CLOSE_REASONS)[number];

/** Every `session.*` type in the contract shapes the session row; nothing else does. */
function isSessionEventType(type: EventType): type is SessionEventType {
  return type.startsWith('session.');
}

export interface TimeRange {
  startedAt: string;
  endedAt: string;
}

/** What the session row is computed from. */
export interface SessionFacts {
  startedAt: string;
  world: number | null;
  /** Latest heartbeat, or `startedAt` if there is none later. */
  lastHeartbeatAt: string;
  /** The first `session.end`, if any. */
  end?: { at: string; reason: SessionEndEvent['payload']['reason'] } | undefined;
  afkPeriods: readonly TimeRange[];
}

export interface DerivedSession {
  endedAt: string | null;
  endReason: SessionCloseReason | null;
  durationSeconds: number;
  afkSeconds: number;
  activeSeconds: number;
}

/**
 * Seconds covered by `periods` inside `[from, to]`. Overlapping periods are
 * counted once.
 */
export function afkSecondsWithin(periods: readonly TimeRange[], from: string, to: string): number {
  const start = Date.parse(from);
  const end = Date.parse(to);
  const clipped = periods
    .map((period) => ({
      start: Math.max(Date.parse(period.startedAt), start),
      end: Math.min(Date.parse(period.endedAt), end),
    }))
    .filter((period) => period.start < period.end)
    .sort((a, b) => a.start - b.start);

  let totalMs = 0;
  let run: { start: number; end: number } | undefined;
  for (const period of clipped) {
    if (run && period.start <= run.end) {
      run.end = Math.max(run.end, period.end);
    } else {
      if (run) totalMs += run.end - run.start;
      run = { ...period };
    }
  }
  if (run) totalMs += run.end - run.start;
  return Math.floor(totalMs / 1000);
}

/**
 * The AFK estimate of a session. Each run of consecutive idle heartbeats
 * covers `[first, last]`, minus every part a real `session.afk` period
 * (`[startedAt, endedAt)`) covers. The parts left with a length above zero are
 * the estimate. The plugin sets `idle` only during an AFK period, so idle time
 * after a real period's end belongs to a new period, even within one run.
 */
export function estimateAfkPeriods(
  idleRuns: readonly TimeRange[],
  realPeriods: readonly TimeRange[],
): TimeRange[] {
  const real = realPeriods
    .map((period) => ({ start: Date.parse(period.startedAt), end: Date.parse(period.endedAt) }))
    .filter((period) => period.start < period.end)
    .sort((a, b) => a.start - b.start);
  const estimates: TimeRange[] = [];
  for (const run of idleRuns) {
    let from = Date.parse(run.startedAt);
    const to = Date.parse(run.endedAt);
    for (const period of real) {
      if (period.end <= from) continue;
      if (period.start >= to) break;
      if (period.start > from) estimates.push(rangeOf(from, period.start));
      from = Math.max(from, period.end);
      if (from >= to) break;
    }
    if (from < to) estimates.push(rangeOf(from, to));
  }
  return estimates;
}

function rangeOf(start: number, end: number): TimeRange {
  return { startedAt: new Date(start).toISOString(), endedAt: new Date(end).toISOString() };
}

/**
 * The derived columns of a session. A real `session.end` always wins.
 * Without one, the session is closed with `timeout` at its last heartbeat
 * once `now` is `SESSION_TIMEOUT_MS` past it, and open before that.
 */
export function deriveSession(facts: SessionFacts, now: Date): DerivedSession {
  let endedAt: string | null = null;
  let endReason: SessionCloseReason | null = null;
  if (facts.end) {
    endedAt = facts.end.at;
    endReason = facts.end.reason;
  } else if (now.getTime() - Date.parse(facts.lastHeartbeatAt) >= SESSION_TIMEOUT_MS) {
    endedAt = facts.lastHeartbeatAt;
    endReason = 'timeout';
  }

  // An open session counts up to its last heartbeat, so the row doesn't
  // depend on the clock until it times out.
  const until = endedAt ?? facts.lastHeartbeatAt;
  const durationSeconds = Math.max(
    0,
    Math.floor((Date.parse(until) - Date.parse(facts.startedAt)) / 1000),
  );
  const afkSeconds =
    durationSeconds === 0 ? 0 : afkSecondsWithin(facts.afkPeriods, facts.startedAt, until);
  return {
    endedAt,
    endReason,
    durationSeconds,
    afkSeconds,
    activeSeconds: durationSeconds - afkSeconds,
  };
}

interface EventRef {
  eventId: string;
  occurredAt: string;
  payload: string;
}

/**
 * The session's first event of `type` that is projected, or is `currentEventId`.
 * Failed and pending events are never read.
 */
function firstEvent(
  tx: Queryable,
  sessionId: string,
  type: SessionEventType,
  currentEventId: string | undefined,
): EventRef | undefined {
  const visible = currentEventId
    ? or(isNotNull(events.processedAt), eq(events.eventId, currentEventId))
    : isNotNull(events.processedAt);
  return tx
    .select({
      eventId: events.eventId,
      occurredAt: events.occurredAt,
      payload: events.payload,
    })
    .from(events)
    .where(and(eq(events.sessionId, sessionId), eq(events.type, type), visible))
    .orderBy(asc(events.occurredAt), asc(events.eventId))
    .limit(1)
    .get();
}

function heartbeatAt(tx: Queryable, sessionId: string, which: 'first' | 'last') {
  const order = which === 'first' ? asc : desc;
  return tx
    .select({
      eventId: sessionHeartbeats.eventId,
      occurredAt: sessionHeartbeats.at,
      world: sessionHeartbeats.world,
    })
    .from(sessionHeartbeats)
    .where(eq(sessionHeartbeats.sessionId, sessionId))
    .orderBy(order(sessionHeartbeats.at), order(sessionHeartbeats.eventId))
    .limit(1)
    .get();
}

/**
 * The session's runs of consecutive idle heartbeats (by `at`, then event ID),
 * as `[first, last]`. Runs of one heartbeat have no length and are left out.
 * Gaps and islands in SQL, so only the runs leave SQLite.
 */
function idleRuns(tx: Queryable, sessionId: string): TimeRange[] {
  return tx.all<TimeRange>(sql`
    SELECT min(at) AS startedAt, max(at) AS endedAt FROM (
      SELECT at, idle,
        row_number() OVER (ORDER BY at, event_id)
          - row_number() OVER (PARTITION BY idle ORDER BY at, event_id) AS run
      FROM ${sessionHeartbeats}
      WHERE session_id = ${sessionId}
    )
    WHERE idle = 1
    GROUP BY run
    HAVING min(at) < max(at)
    ORDER BY startedAt
  `);
}

/** Replaces the session's AFK estimate rows. Returns the estimate. */
function syncAfkEstimates(
  tx: Queryable,
  sessionId: string,
  realPeriods: readonly TimeRange[],
): TimeRange[] {
  const estimates = estimateAfkPeriods(idleRuns(tx, sessionId), realPeriods);
  tx.delete(sessionAfkEstimates).where(eq(sessionAfkEstimates.sessionId, sessionId)).run();
  if (estimates.length > 0) {
    tx.insert(sessionAfkEstimates)
      .values(estimates.map((estimate) => ({ sessionId, ...estimate })))
      .run();
  }
  return estimates;
}

/**
 * Recomputes the session row from its projected events (plus the event being
 * applied, if any). Deletes the row if no session event is visible. Returns
 * the row's derived columns, or `undefined` if it was deleted.
 */
export function refreshSession(
  tx: Queryable,
  sessionId: string,
  now: Date,
  currentEventId?: string,
): DerivedSession | undefined {
  const start = firstEvent(tx, sessionId, 'session.start', currentEventId);
  const end = firstEvent(tx, sessionId, 'session.end', currentEventId);
  const firstAfk = firstEvent(tx, sessionId, 'session.afk', currentEventId);
  const firstHeartbeat = heartbeatAt(tx, sessionId, 'first');
  const lastHeartbeat = heartbeatAt(tx, sessionId, 'last');

  // The account comes from the first start, else the earliest session event,
  // so the row doesn't depend on arrival order.
  const earliest = [start, firstHeartbeat, firstAfk, end]
    .filter((ref) => ref !== undefined)
    .sort(compareEventRows)[0];
  if (!earliest) {
    tx.delete(sessions).where(eq(sessions.id, sessionId)).run();
    return undefined;
  }
  const first = start ?? earliest;
  // A session's events all have one owner: ingest rejects another user's sessionId.
  const account = tx
    .select({ userId: events.userId, accountHash: events.accountHash })
    .from(events)
    .where(eq(events.eventId, first.eventId))
    .get();
  if (account === undefined) throw new Error('session event missing from events');

  const afkPeriods = tx
    .select({ startedAt: sessionAfkPeriods.startedAt, endedAt: sessionAfkPeriods.endedAt })
    .from(sessionAfkPeriods)
    .where(eq(sessionAfkPeriods.sessionId, sessionId))
    .all();
  // Without a start, the session starts at the earliest time it has seen:
  // its earliest event, or the start of an AFK period (an AFK event is sent
  // when the period ends, so its own time is too late).
  let startedAt = first.occurredAt;
  if (!start) {
    for (const period of afkPeriods) {
      if (period.startedAt < startedAt) startedAt = period.startedAt;
    }
  }
  const world = start
    ? (JSON.parse(start.payload) as SessionStartEvent['payload']).world
    : (firstHeartbeat?.world ?? null);
  const lastHeartbeatAt =
    lastHeartbeat && lastHeartbeat.occurredAt > startedAt ? lastHeartbeat.occurredAt : startedAt;
  const estimates = syncAfkEstimates(tx, sessionId, afkPeriods);

  const derived = deriveSession(
    {
      startedAt,
      world,
      lastHeartbeatAt,
      end: end && {
        at: end.occurredAt,
        reason: (JSON.parse(end.payload) as SessionEndEvent['payload']).reason,
      },
      afkPeriods: [...afkPeriods, ...estimates],
    },
    now,
  );
  const row = {
    accountId: accountIdOf(tx, account),
    startedAt,
    world,
    lastHeartbeatAt,
    ...derived,
  };
  tx.insert(sessions)
    .values({ id: sessionId, ...row })
    .onConflictDoUpdate({ target: sessions.id, set: row })
    .run();
  return derived;
}

/** Makes sure a session row exists, so heartbeat and AFK rows can reference it. */
function ensureSession(tx: Queryable, event: Stored<Event>): void {
  tx.insert(sessions)
    .values({
      id: event.sessionId,
      accountId: accountIdOf(tx, event),
      startedAt: event.occurredAt,
      lastHeartbeatAt: event.occurredAt,
      durationSeconds: 0,
      afkSeconds: 0,
      activeSeconds: 0,
    })
    .onConflictDoNothing()
    .run();
}

/**
 * Closes open sessions whose last heartbeat is at least `SESSION_TIMEOUT_MS`
 * before `now`, and builds their summaries. Returns how many were closed. Run every minute and at startup.
 */
export function closeTimedOutSessions(db: Db, now: Date): number {
  const cutoff = new Date(now.getTime() - SESSION_TIMEOUT_MS).toISOString();
  return db.transaction(
    (tx) => {
      const stale = tx
        .select({ id: sessions.id })
        .from(sessions)
        .where(and(isNull(sessions.endedAt), lte(sessions.lastHeartbeatAt, cutoff)))
        .all();
      let closed = 0;
      for (const { id } of stale) {
        if (refreshSession(tx, id, now)?.endReason === 'timeout') {
          syncSessionSummary(tx, id);
          closed += 1;
        }
      }
      return closed;
    },
    { behavior: 'immediate' },
  );
}

export const sessionsProjection: Projection = {
  name: 'sessions',
  version: SESSIONS_VERSION,

  apply(tx, event, { now }) {
    if (!isSessionEventType(event.type)) return;
    ensureSession(tx, event);

    if (event.type === 'session.heartbeat') {
      const { regionId, world, worldTypes, worldLocation, worldActivity, idle } = event.payload;
      tx.insert(sessionHeartbeats)
        .values({
          eventId: event.eventId,
          sessionId: event.sessionId,
          at: event.occurredAt,
          regionId,
          world,
          worldTypes: JSON.stringify(worldTypes),
          worldLocation,
          worldActivity,
          idle,
        })
        .run();
    } else if (event.type === 'session.afk') {
      tx.insert(sessionAfkPeriods)
        .values({
          eventId: event.eventId,
          sessionId: event.sessionId,
          startedAt: event.payload.startedAt,
          endedAt: event.payload.endedAt,
        })
        .run();
    }

    refreshSession(tx, event.sessionId, now, event.eventId);
  },

  recompute(tx, { now }) {
    const ids = tx.select({ id: sessions.id, endedAt: sessions.endedAt }).from(sessions).all();
    for (const { id, endedAt } of ids) {
      // A session that times out now gets its summary, as in the timeout job.
      if (refreshSession(tx, id, now)?.endReason === 'timeout' && endedAt === null) {
        syncSessionSummary(tx, id);
      }
    }
    // Weeks are a read cache of play time: empty it, the next read fills it.
    weeklySummariesProjection.reset(tx);
    return {
      tables: ['sessions', 'session_afk_estimates', 'session_summaries', 'weekly_summaries'],
      counts: { sessions: ids.length },
    };
  },

  reset(tx) {
    tx.delete(sessionAfkEstimates).run();
    tx.delete(sessionHeartbeats).run();
    tx.delete(sessionAfkPeriods).run();
    tx.delete(sessions).run();
  },

  snapshot(db) {
    return {
      sessions: db
        .select({
          id: sessions.id,
          userId: accounts.userId,
          accountHash: accounts.accountHash,
          startedAt: sessions.startedAt,
          endedAt: sessions.endedAt,
          endReason: sessions.endReason,
          world: sessions.world,
          lastHeartbeatAt: sessions.lastHeartbeatAt,
          durationSeconds: sessions.durationSeconds,
          afkSeconds: sessions.afkSeconds,
          activeSeconds: sessions.activeSeconds,
        })
        .from(sessions)
        .innerJoin(accounts, eq(sessions.accountId, accounts.id))
        .orderBy(asc(sessions.id))
        .all(),
      heartbeats: db
        .select({
          eventId: sessionHeartbeats.eventId,
          sessionId: sessionHeartbeats.sessionId,
          at: sessionHeartbeats.at,
          regionId: sessionHeartbeats.regionId,
          world: sessionHeartbeats.world,
          worldTypes: sessionHeartbeats.worldTypes,
          worldLocation: sessionHeartbeats.worldLocation,
          worldActivity: sessionHeartbeats.worldActivity,
          idle: sessionHeartbeats.idle,
        })
        .from(sessionHeartbeats)
        .orderBy(
          asc(sessionHeartbeats.sessionId),
          asc(sessionHeartbeats.at),
          asc(sessionHeartbeats.eventId),
        )
        .all(),
      afkPeriods: db
        .select({
          eventId: sessionAfkPeriods.eventId,
          sessionId: sessionAfkPeriods.sessionId,
          startedAt: sessionAfkPeriods.startedAt,
          endedAt: sessionAfkPeriods.endedAt,
        })
        .from(sessionAfkPeriods)
        .orderBy(asc(sessionAfkPeriods.sessionId), asc(sessionAfkPeriods.eventId))
        .all(),
      afkEstimates: db
        .select({
          sessionId: sessionAfkEstimates.sessionId,
          startedAt: sessionAfkEstimates.startedAt,
          endedAt: sessionAfkEstimates.endedAt,
        })
        .from(sessionAfkEstimates)
        .orderBy(asc(sessionAfkEstimates.sessionId), asc(sessionAfkEstimates.startedAt))
        .all(),
    };
  },
};
