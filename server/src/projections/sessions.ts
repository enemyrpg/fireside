import type {
  Event,
  EventType,
  SESSION_CLOSE_REASONS,
  SessionEndEvent,
  SessionStartEvent,
} from '@fireside/shared';
import { and, asc, desc, eq, isNotNull, isNull, lte, or } from 'drizzle-orm';
import type { Db, Queryable } from '../db/index.js';
import { accounts, events, sessionAfkPeriods, sessionHeartbeats, sessions } from '../db/schema.js';
import { compareEventRows, type Projection, type Stored } from './framework.js';
import { accountIdOf } from './lookup.js';
import { syncSessionSummary } from './session-summaries.js';

// `sessions`, `session_heartbeats` and `session_afk_periods`
// (see docs/architecture.md#sessions).
//
// Heartbeats and AFK periods are keyed inserts. The session row is refreshed
// from its projected events on every `session.*` event, with one pure
// function (`deriveSession`) that also decides the timeout from the clock.
// The timeout job (`closeTimedOutSessions`) calls the same refresh, so a late
// `session.end` or a late heartbeat just changes the inputs: it replaces a
// timeout, extends it, or reopens the session.

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

  const derived = deriveSession(
    {
      startedAt,
      world,
      lastHeartbeatAt,
      end: end && {
        at: end.occurredAt,
        reason: (JSON.parse(end.payload) as SessionEndEvent['payload']).reason,
      },
      afkPeriods,
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

  reset(tx) {
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
    };
  },
};
