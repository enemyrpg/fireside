import {
  compareSkills,
  isKnownSkill,
  periodKey,
  periodsBetween,
  type Bucket,
  type SkillGain,
  type XpPoint,
} from '@fireside/shared';
import { and, asc, desc, eq, gte, inArray, lt, sql } from 'drizzle-orm';
import type { Queryable } from '../db/index.js';
import { accounts, xpSnapshotSkills, xpSnapshots } from '../db/schema.js';

// XP over time and gains. Reads only `xp_snapshots` and `xp_snapshot_skills`.
//
// Snapshots are ordered by (`taken_at`, `event_id`). The value at time T is
// the last snapshot before T. Gains over a window [from, to) are the value at
// `to` minus the value at `from`; without a snapshot before `from`, the first
// snapshot in the window is the start.

export interface XpValue {
  xp: number;
  level: number;
}

// --- Gains --------------------------------------------------------------------

/** One account's start and end snapshot for a window (skill → value). */
export interface SnapshotPair {
  start: ReadonlyMap<string, XpValue>;
  end: ReadonlyMap<string, XpValue>;
}

export interface GainsResult {
  total: { xpGained: number; levelsGained: number };
  skills: SkillGain[];
}

/**
 * The start to use for a gain from `start` to `end`. Gains are never
 * negative: if XP or level went down (odd data), the start is the end.
 */
export function gainStart(start: XpValue, end: XpValue): XpValue {
  return end.xp < start.xp || end.level < start.level ? end : start;
}

/**
 * Gains per skill, summed over accounts. A skill counts for an account when
 * it is in both its start and end snapshot. Gains are never negative: if a
 * value went down (odd data), the start is set to the end for that account.
 * `total` counts only skills in `SKILLS`, like `total_xp` and `total_level`.
 */
export function sumGains(pairs: readonly SnapshotPair[]): GainsResult {
  const bySkill = new Map<
    string,
    { startXp: number; endXp: number; startLevel: number; endLevel: number }
  >();
  for (const { start, end } of pairs) {
    for (const [skill, endValue] of end) {
      const rawStart = start.get(skill);
      if (!rawStart) continue;
      const startValue = gainStart(rawStart, endValue);
      const sum = bySkill.get(skill) ?? { startXp: 0, endXp: 0, startLevel: 0, endLevel: 0 };
      sum.startXp += startValue.xp;
      sum.endXp += endValue.xp;
      sum.startLevel += startValue.level;
      sum.endLevel += endValue.level;
      bySkill.set(skill, sum);
    }
  }

  const total = { xpGained: 0, levelsGained: 0 };
  const sorted = [...bySkill].sort(([a], [b]) => compareSkills(a, b));
  const skills = sorted.map(([skill, s]): SkillGain => {
    const gain = {
      skill,
      startXp: s.startXp,
      endXp: s.endXp,
      xpGained: s.endXp - s.startXp,
      startLevel: s.startLevel,
      endLevel: s.endLevel,
      levelsGained: s.endLevel - s.startLevel,
    };
    if (isKnownSkill(skill)) {
      total.xpGained += gain.xpGained;
      total.levelsGained += gain.levelsGained;
    }
    return gain;
  });
  return { total, skills };
}

type SnapshotRef = { id: number } | undefined;

function lastBefore(db: Queryable, accountId: number, before: string): SnapshotRef {
  return db
    .select({ id: xpSnapshots.id })
    .from(xpSnapshots)
    .where(and(eq(xpSnapshots.accountId, accountId), lt(xpSnapshots.takenAt, before)))
    .orderBy(desc(xpSnapshots.takenAt), desc(xpSnapshots.eventId))
    .limit(1)
    .get();
}

function firstIn(db: Queryable, accountId: number, from: string, to: string): SnapshotRef {
  return db
    .select({ id: xpSnapshots.id })
    .from(xpSnapshots)
    .where(
      and(
        eq(xpSnapshots.accountId, accountId),
        gte(xpSnapshots.takenAt, from),
        lt(xpSnapshots.takenAt, to),
      ),
    )
    .orderBy(asc(xpSnapshots.takenAt), asc(xpSnapshots.eventId))
    .limit(1)
    .get();
}

export function skillsOf(db: Queryable, snapshotId: number): Map<string, XpValue> {
  const rows = db
    .select({
      skill: xpSnapshotSkills.skill,
      xp: xpSnapshotSkills.xp,
      level: xpSnapshotSkills.level,
    })
    .from(xpSnapshotSkills)
    .where(eq(xpSnapshotSkills.snapshotId, snapshotId))
    .all();
  return new Map(rows.map((row) => [row.skill, { xp: row.xp, level: row.level }]));
}

/**
 * Start and end snapshot of each account for `[from, to)`. An account with no
 * snapshot before `to` is left out. With snapshots only before `from`, start
 * and end are the same snapshot (no gain).
 */
export function snapshotPairs(
  db: Queryable,
  accountIds: readonly number[],
  from: string,
  to: string,
): SnapshotPair[] {
  const pairs: SnapshotPair[] = [];
  for (const accountId of accountIds) {
    const end = lastBefore(db, accountId, to);
    if (!end) continue;
    // Without a snapshot before `from`, `end` itself is in [from, to), so `firstIn` finds one.
    const start = lastBefore(db, accountId, from) ?? firstIn(db, accountId, from, to);
    if (!start) continue;
    const endSkills = skillsOf(db, end.id);
    pairs.push({ start: start.id === end.id ? endSkills : skillsOf(db, start.id), end: endSkills });
  }
  return pairs;
}

// --- XP series ----------------------------------------------------------------

/** One account's values: the last one before the series, then each snapshot in it. */
export interface AccountSeries {
  before: XpValue | undefined;
  /** Snapshots in the series range, oldest first. `at` is UTC milliseconds. */
  values: readonly { at: number; value: XpValue }[];
}

/** Index of the last value with `at < time`, or -1. */
function lastIndexBefore(values: AccountSeries['values'], time: number): number {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if ((values[mid]?.at ?? Infinity) < time) low = mid + 1;
    else high = mid;
  }
  return low - 1;
}

/** Start and end value of one account for the window `[from, to)`, or `undefined` without data. */
function windowValues(
  series: AccountSeries,
  from: number,
  to: number,
): { start: XpValue; end: XpValue } | undefined {
  const endIndex = lastIndexBefore(series.values, to);
  const end = endIndex >= 0 ? series.values[endIndex]?.value : series.before;
  if (!end) return undefined;
  const startIndex = lastIndexBefore(series.values, from);
  // Without a value before `from`, the first value in the window is the start.
  const start =
    startIndex >= 0
      ? series.values[startIndex]?.value
      : (series.before ?? series.values[startIndex + 1]?.value);
  return { start: gainStart(start ?? end, end), end };
}

/**
 * XP points per local bucket overlapping `[from, to)`. Each point is the value
 * at the end of `bucket ∩ [from, to)`, summed over accounts, and `gained` is
 * the gain over that window (at least 0 per account). Empty buckets carry the
 * value forward. Buckets where no account has a value yet are left out.
 */
export function xpPoints(
  series: readonly AccountSeries[],
  from: number,
  to: number,
  bucket: Bucket,
  timeZone: string,
): XpPoint[] {
  const points: XpPoint[] = [];
  for (const period of periodsBetween(from, to, bucket, timeZone)) {
    const windowFrom = Math.max(period.start, from);
    const windowTo = Math.min(period.end, to);
    let point: XpPoint | undefined;
    for (const account of series) {
      const values = windowValues(account, windowFrom, windowTo);
      if (!values) continue;
      point ??= {
        period: periodKey(period.start, bucket, timeZone),
        start: new Date(period.start).toISOString(),
        xp: 0,
        level: 0,
        gained: 0,
      };
      point.xp += values.end.xp;
      point.level += values.end.level;
      point.gained += values.end.xp - values.start.xp;
    }
    if (point) points.push(point);
  }
  return points;
}

/** Query for one account's values, overall (total XP and level) or for one skill. */
function seriesRows(
  db: Queryable,
  accountId: number,
  skill: string | undefined,
  range: { before: string } | { from: string; to: string },
): { takenAt: string; xp: number; level: number }[] {
  const time =
    'before' in range
      ? lt(xpSnapshots.takenAt, range.before)
      : and(gte(xpSnapshots.takenAt, range.from), lt(xpSnapshots.takenAt, range.to));
  const order =
    'before' in range
      ? [desc(xpSnapshots.takenAt), desc(xpSnapshots.eventId)]
      : [asc(xpSnapshots.takenAt), asc(xpSnapshots.eventId)];
  const limit = 'before' in range ? 1 : -1;

  if (skill === undefined) {
    return db
      .select({
        takenAt: xpSnapshots.takenAt,
        xp: xpSnapshots.totalXp,
        level: xpSnapshots.totalLevel,
      })
      .from(xpSnapshots)
      .where(and(eq(xpSnapshots.accountId, accountId), time))
      .orderBy(...order)
      .limit(limit)
      .all();
  }
  return db
    .select({
      takenAt: xpSnapshots.takenAt,
      xp: xpSnapshotSkills.xp,
      level: xpSnapshotSkills.level,
    })
    .from(xpSnapshots)
    .innerJoin(
      xpSnapshotSkills,
      and(eq(xpSnapshotSkills.snapshotId, xpSnapshots.id), eq(xpSnapshotSkills.skill, skill)),
    )
    .where(and(eq(xpSnapshots.accountId, accountId), time))
    .orderBy(...order)
    .limit(limit)
    .all();
}

/** Time of the accounts' first snapshot, or `undefined` if they have none. */
export function firstSnapshotAt(db: Queryable, accountIds: readonly number[]): string | undefined {
  // One query; the inner lookup per account uses the (account_id, taken_at, event_id) index.
  // A query builder (not raw column names) keeps the columns table-qualified.
  const firstOfAccount = db
    .select({ takenAt: xpSnapshots.takenAt })
    .from(xpSnapshots)
    .where(eq(xpSnapshots.accountId, accounts.id))
    .orderBy(asc(xpSnapshots.takenAt))
    .limit(1);
  const row = db
    .select({ first: sql<string | null>`min((${firstOfAccount}))` })
    .from(accounts)
    .where(inArray(accounts.id, [...accountIds]))
    .get();
  return row?.first ?? undefined;
}

/** Each account's values for a series over `[from, to)`. */
export function accountSeries(
  db: Queryable,
  accountIds: readonly number[],
  skill: string | undefined,
  from: string,
  to: string,
): AccountSeries[] {
  return accountIds.map((accountId) => {
    const [before] = seriesRows(db, accountId, skill, { before: from });
    return {
      before: before && { xp: before.xp, level: before.level },
      values: seriesRows(db, accountId, skill, { from, to }).map((row) => ({
        at: Date.parse(row.takenAt),
        value: { xp: row.xp, level: row.level },
      })),
    };
  });
}
