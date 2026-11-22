import {
  addDays,
  daysBetween,
  fromLocal,
  localHourAt,
  periodKey,
  periodsBetween,
  toLocal,
  type Bucket,
  type HeatmapCell,
  type PlaytimeTotals,
  type ScreentimeBucket,
  type ScreentimeStats,
  type WorldTime,
} from '@fireside/shared';
import type { Queryable } from '../db/index.js';
import {
  groupByPeriod,
  HEARTBEAT_SECONDS,
  heartbeatMinutes,
  heartbeatTimes,
  playtimeOf,
  worldMinutes,
  type HeartbeatMinute,
} from './playtime.js';

// Screen time. All numbers come from heartbeats with the play-time rule in
// `playtime.ts`, so they always match the calendar for the same range.

/** Half-open `[from, to)` in UTC. */
export interface TimeRange {
  from: string;
  to: string;
}

/** Days in the default range: today and the 29 days before it. */
export const DEFAULT_RANGE_DAYS = 30;

const iso = (ms: number) => new Date(ms).toISOString();

/** Last 30 local days: local midnight 29 days ago until the next local midnight. */
export function defaultRange(nowMs: number, timeZone: string): TimeRange {
  const today = toLocal(nowMs, timeZone);
  return {
    from: iso(fromLocal(addDays(today, 1 - DEFAULT_RANGE_DAYS), 0, 0, timeZone)),
    to: iso(fromLocal(addDays(today, 1), 0, 0, timeZone)),
  };
}

/** Whether `ms` is the start of a local day. */
function isLocalMidnight(ms: number, timeZone: string): boolean {
  return fromLocal(toLocal(ms, timeZone), 0, 0, timeZone) === ms;
}

/**
 * The range just before `range`, of the same length. When both ends are
 * local midnights it is the same number of local days, so a week with a DST
 * change compares with the previous local week, not one shifted by an hour.
 */
export function previousRange(range: TimeRange, timeZone: string): TimeRange {
  const fromMs = Date.parse(range.from);
  const toMs = Date.parse(range.to);
  if (isLocalMidnight(fromMs, timeZone) && isLocalMidnight(toMs, timeZone)) {
    const first = toLocal(fromMs, timeZone);
    const days = daysBetween(first, toLocal(toMs, timeZone));
    return { from: iso(fromLocal(addDays(first, -days), 0, 0, timeZone)), to: range.from };
  }
  return { from: iso(fromMs - (toMs - fromMs)), to: range.from };
}

export interface ScreentimeResult {
  buckets: ScreentimeBucket[];
  totals: PlaytimeTotals;
  previous: PlaytimeTotals | null;
  stats: ScreentimeStats;
}

/** Active/AFK per period (every period overlapping the range), totals, previous range and stats. */
export function screentime(
  db: Queryable,
  accountIds: readonly number[],
  range: TimeRange,
  bucket: Bucket,
  timeZone: string,
  nowMs: number,
): ScreentimeResult {
  const minutes = heartbeatMinutes(db, { accountIds, ...range });
  const fromMs = Date.parse(range.from);
  const toMs = Date.parse(range.to);

  const groups = new Map(
    groupByPeriod(minutes, bucket, timeZone).map((group) => [group.start, group.minutes]),
  );
  const buckets = periodsBetween(fromMs, toMs, bucket, timeZone).map((period) => {
    const time = playtimeOf(groups.get(period.start) ?? []);
    return {
      period: periodKey(period.start, bucket, timeZone),
      start: iso(period.start),
      activeSeconds: time.activeSeconds,
      afkSeconds: time.afkSeconds,
    };
  });

  const previousMinutes = heartbeatMinutes(db, { accountIds, ...previousRange(range, timeZone) });
  const totals = playtimeOf(minutes);
  // Days that have started: future days don't lower the average.
  const pastEnd = Math.min(toMs, nowMs);
  const days = pastEnd > fromMs ? periodsBetween(fromMs, pastEnd, 'day', timeZone).length : 0;
  return {
    buckets,
    totals,
    previous: previousMinutes.length > 0 ? playtimeOf(previousMinutes) : null,
    stats: stats(minutes, totals, days),
  };
}

function stats(
  minutes: readonly HeartbeatMinute[],
  totals: PlaytimeTotals,
  days: number,
): ScreentimeStats {
  const perSession = new Map<string, number>();
  for (const { sessionId } of minutes)
    perSession.set(sessionId, (perSession.get(sessionId) ?? 0) + 1);
  const sessionCount = perSession.size;
  const played = totals.playedSeconds;
  return {
    sessionCount,
    averagePerDaySeconds: days > 0 ? Math.floor(played / days) : 0,
    averageSessionSeconds: sessionCount > 0 ? Math.floor(played / sessionCount) : 0,
    longestSessionSeconds: Math.max(0, ...perSession.values()) * HEARTBEAT_SECONDS,
    // Rounded to 4 decimals (0.0789 = 7.89 %).
    afkShare: played > 0 ? Math.round((totals.afkSeconds / played) * 10_000) / 10_000 : 0,
  };
}

export interface ScreentimeWorldsResult {
  worlds: WorldTime[];
  worldTypes: { type: string; seconds: number }[];
  locations: { location: string | null; seconds: number }[];
}

/**
 * World types from the stored JSON, each once (a repeated type would count a
 * minute twice). Bad data gives no types instead of an error.
 */
export function parseTypes(json: string): string[] {
  try {
    const value: unknown = JSON.parse(json);
    return Array.isArray(value)
      ? [...new Set(value.filter((type): type is string => typeof type === 'string'))]
      : [];
  } catch {
    return [];
  }
}

/** Ascending string order, independent of locale. */
const byText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Time per world, per world type and per location. */
export function screentimeWorlds(
  db: Queryable,
  accountIds: readonly number[],
  range: TimeRange,
): ScreentimeWorldsResult {
  const worlds = new Map<number, WorldTime>();
  const typeSeconds = new Map<string, number>();
  const locationSeconds = new Map<string | null, number>();
  const types = new Map<string, string[]>();

  for (const minute of worldMinutes(db, { accountIds, ...range })) {
    let parsed = types.get(minute.worldTypes);
    if (!parsed) {
      parsed = parseTypes(minute.worldTypes);
      types.set(minute.worldTypes, parsed);
    }
    let world = worlds.get(minute.world);
    if (!world) {
      world = {
        world: minute.world,
        seconds: 0,
        activeSeconds: 0,
        afkSeconds: 0,
        worldTypes: [],
        location: null,
        activity: null,
      };
      worlds.set(minute.world, world);
    }
    world.seconds += HEARTBEAT_SECONDS;
    if (minute.afk) world.afkSeconds += HEARTBEAT_SECONDS;
    else world.activeSeconds += HEARTBEAT_SECONDS;
    // Minutes are oldest first: keep the latest types and the latest known location/activity.
    world.worldTypes = parsed;
    if (minute.location !== null) world.location = minute.location;
    if (minute.activity !== null) world.activity = minute.activity;

    for (const type of parsed)
      typeSeconds.set(type, (typeSeconds.get(type) ?? 0) + HEARTBEAT_SECONDS);
    locationSeconds.set(
      minute.location,
      (locationSeconds.get(minute.location) ?? 0) + HEARTBEAT_SECONDS,
    );
  }

  return {
    worlds: [...worlds.values()].sort((a, b) => b.seconds - a.seconds || a.world - b.world),
    worldTypes: [...typeSeconds]
      .map(([type, seconds]) => ({ type, seconds }))
      .sort((a, b) => b.seconds - a.seconds || byText(a.type, b.type)),
    locations: [...locationSeconds]
      .map(([location, seconds]) => ({ location, seconds }))
      .sort(
        (a, b) =>
          b.seconds - a.seconds ||
          (a.location === null ? 1 : 0) - (b.location === null ? 1 : 0) ||
          byText(a.location ?? '', b.location ?? ''),
      ),
  };
}

/** Time per local weekday × hour, only cells with time, Monday 00 first. */
export function screentimeHeatmap(
  db: Queryable,
  accountIds: readonly number[],
  range: TimeRange,
  timeZone: string,
): HeatmapCell[] {
  const seconds = new Map<number, number>();
  let hour: ReturnType<typeof localHourAt> | undefined;
  for (const at of heartbeatTimes(db, { accountIds, ...range })) {
    const ms = Date.parse(at);
    // Sorted rows: look up the local hour only when we pass the current one.
    if (!hour || ms >= hour.end) hour = localHourAt(ms, timeZone);
    const key = hour.weekday * 100 + hour.hour;
    seconds.set(key, (seconds.get(key) ?? 0) + HEARTBEAT_SECONDS);
  }
  return [...seconds]
    .sort(([a], [b]) => a - b)
    .map(([key, value]) => ({ weekday: Math.floor(key / 100), hour: key % 100, seconds: value }));
}
