import {
  fromLocal,
  periodAt,
  periodKey,
  type CalendarDay,
  type PeriodUnit,
  type PlaytimeTotals,
} from '@fireside/shared';
import { and, asc, eq, gte, inArray, lt } from 'drizzle-orm';
import type { Queryable } from '../db/index.js';
import { sessionHeartbeats, sessions } from '../db/schema.js';
import { afkPeriodsOverlapping } from './afk-periods.js';

// Play time from heartbeats. The one rule for the calendar and screen time, so
// they always
// show the same numbers:
// - Each heartbeat is one minute (60 s), placed at its own `at`.
// - It is AFK if an AFK period of the same session (real or estimated, see
//   read/afk-periods.ts) has `started_at <= at < ended_at`, otherwise active.
// - Local days, weeks and hours come from `at` in `TZ`, so a session across
//   midnight (or a DST change) is split by its heartbeats.

/** Seconds one heartbeat stands for. */
export const HEARTBEAT_SECONDS = 60;

export interface HeartbeatMinute {
  at: string;
  sessionId: string;
  afk: boolean;
}

/** A heartbeat minute with the world it was played on. */
export interface WorldMinute extends HeartbeatMinute {
  world: number;
  /** JSON array of world types, as stored. */
  worldTypes: string;
  /** `null` when the world list wasn't loaded. */
  location: string | null;
  activity: string | null;
}

export interface PlaytimeFilter {
  /** The accounts to read: owned account IDs, resolved by the route. */
  accountIds: readonly number[];
  /** Half-open `[from, to)` in UTC. */
  from: string;
  to: string;
}

/**
 * Heartbeats in `[from, to)`, oldest first, each marked active or AFK.
 * The AFK periods that can matter are read once and checked here, which is
 * much faster than a correlated subquery per heartbeat.
 */
export function heartbeatMinutes(db: Queryable, filter: PlaytimeFilter): HeartbeatMinute[] {
  const isAfk = afkCheck(db, filter);
  // Rows as `[at, sessionId]` arrays: noticeably faster than objects for
  // tens of thousands of heartbeats.
  const rows = heartbeatRows(db, filter, false) as [string, string][];
  return rows.map(([at, sessionId]) => ({ at, sessionId, afk: isAfk(sessionId, at) }));
}

/** Times (`at`) of the heartbeats in `[from, to)`, oldest first, without the AFK check. */
export function heartbeatTimes(db: Queryable, filter: PlaytimeFilter): string[] {
  return (heartbeatRows(db, filter, false) as [string, string][]).map(([at]) => at);
}

/** `heartbeatMinutes` with world, world types, location and activity. */
export function worldMinutes(db: Queryable, filter: PlaytimeFilter): WorldMinute[] {
  const isAfk = afkCheck(db, filter);
  const rows = heartbeatRows(db, filter, true) as [
    string,
    string,
    number,
    string,
    string | null,
    string | null,
  ][];
  return rows.map(([at, sessionId, world, worldTypes, location, activity]) => ({
    at,
    sessionId,
    afk: isAfk(sessionId, at),
    world,
    worldTypes,
    location,
    activity,
  }));
}

/** Heartbeat rows in `[from, to)` as arrays, sorted by `at`. */
function heartbeatRows(db: Queryable, filter: PlaytimeFilter, withWorld: boolean): unknown[][] {
  const inRange = [gte(sessionHeartbeats.at, filter.from), lt(sessionHeartbeats.at, filter.to)];
  const base = { at: sessionHeartbeats.at, sessionId: sessionHeartbeats.sessionId };
  const columns = withWorld
    ? {
        ...base,
        world: sessionHeartbeats.world,
        worldTypes: sessionHeartbeats.worldTypes,
        location: sessionHeartbeats.worldLocation,
        activity: sessionHeartbeats.worldActivity,
      }
    : base;
  return db
    .select(columns)
    .from(sessionHeartbeats)
    .innerJoin(sessions, eq(sessions.id, sessionHeartbeats.sessionId))
    .where(and(inArray(sessions.accountId, filter.accountIds), ...inRange))
    .orderBy(asc(sessionHeartbeats.at))
    .values();
}

/** Reads the AFK periods that overlap the range and returns an AFK check for a heartbeat. */
function afkCheck(
  db: Queryable,
  filter: PlaytimeFilter,
): (sessionId: string, at: string) => boolean {
  const periods = new Map<string, { startedAt: string; endedAt: string }[]>();
  const afkRows = afkPeriodsOverlapping(db, filter.accountIds, filter.from, filter.to);
  for (const { sessionId, ...period } of afkRows) {
    const list = periods.get(sessionId);
    if (list) list.push(period);
    else periods.set(sessionId, [period]);
  }
  // Timestamps share one format, so string comparison is chronological.
  return (sessionId, at) =>
    (periods.get(sessionId) ?? []).some((p) => p.startedAt <= at && at < p.endedAt);
}

/** Minutes of one local period: `[start, end)` in UTC milliseconds. */
export interface PeriodMinutes<T> {
  start: number;
  end: number;
  minutes: T[];
}

/**
 * Sorted minutes grouped by local period (`TZ`), oldest first. Only periods
 * with minutes. A period across a DST change has 23 or 25 hours (days).
 */
export function groupByPeriod<T extends { at: string }>(
  minutes: readonly T[],
  unit: PeriodUnit,
  timeZone: string,
): PeriodMinutes<T>[] {
  const groups: PeriodMinutes<T>[] = [];
  let group: PeriodMinutes<T> | undefined;
  for (const minute of minutes) {
    const ms = Date.parse(minute.at);
    // Rows are sorted, so a new period starts only when we pass the current one's end.
    if (!group || ms >= group.end) {
      group = { ...periodAt(ms, unit, timeZone), minutes: [] };
      groups.push(group);
    }
    group.minutes.push(minute);
  }
  return groups;
}

/** Played, active and AFK seconds of `minutes`. */
export function playtimeOf(minutes: readonly HeartbeatMinute[]): PlaytimeTotals {
  const afk = minutes.reduce((count, minute) => count + (minute.afk ? 1 : 0), 0);
  return {
    playedSeconds: minutes.length * HEARTBEAT_SECONDS,
    activeSeconds: (minutes.length - afk) * HEARTBEAT_SECONDS,
    afkSeconds: afk * HEARTBEAT_SECONDS,
  };
}

/** `[start, end)` of a local year in UTC milliseconds. */
export function localYear(year: number, timeZone: string): { start: number; end: number } {
  return {
    start: fromLocal({ year, month: 1, day: 1 }, 0, 0, timeZone),
    end: fromLocal({ year: year + 1, month: 1, day: 1 }, 0, 0, timeZone),
  };
}

/**
 * Play time per local day for heartbeats in `[from, to)` (UTC), oldest first.
 * Only days with play time. A day only partly inside the range counts only
 * its heartbeats inside it.
 */
export function calendarDays(
  db: Queryable,
  filter: PlaytimeFilter,
  timeZone: string,
): CalendarDay[] {
  return groupByPeriod(heartbeatMinutes(db, filter), 'day', timeZone).map((day) => ({
    date: periodKey(day.start, 'day', timeZone),
    ...playtimeOf(day.minutes),
    sessionCount: new Set(day.minutes.map((minute) => minute.sessionId)).size,
  }));
}
