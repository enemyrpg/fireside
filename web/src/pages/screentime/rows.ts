import type { Bucket, ScreentimeBucket, ScreentimeWorldsResponse } from '@fireside/shared';
import { formatLocation, formatWorldType } from '@/format';

// Screen time helpers (2.1 "Screen time").

// --- Range ---------------------------------------------------------------------------

export const SCREENTIME_RANGES = ['7d', '30d', '90d'] as const;
export type ScreentimeRange = (typeof SCREENTIME_RANGES)[number];

/** Same default as the API without `from`/`to`: the last 30 local days. */
export const DEFAULT_SCREENTIME_RANGE: ScreentimeRange = '30d';

/** Local days in a range (today included), and the chart's bucket: weeks for 90 days. */
export const RANGE_SPEC: Record<ScreentimeRange, { days: number; bucket: Bucket }> = {
  '7d': { days: 7, bucket: 'day' },
  '30d': { days: 30, bucket: 'day' },
  '90d': { days: 90, bucket: 'week' },
};

export function parseScreentimeRange(value: string | null): ScreentimeRange {
  return SCREENTIME_RANGES.find((range) => range === value) ?? DEFAULT_SCREENTIME_RANGE;
}

// --- Numbers -----------------------------------------------------------------------

/** Periods (days or weeks) with any play time. */
export function periodsPlayed(buckets: readonly ScreentimeBucket[]): number {
  return buckets.filter((bucket) => bucket.activeSeconds + bucket.afkSeconds > 0).length;
}

/**
 * The day or week with the most play time (active + AFK), for "Most on Sat 14
 * Nov · 5 h 6 min" under the bars. The earliest wins a tie, like the heatmap.
 * `undefined` without play time.
 */
export function mostPlayedBucket(
  buckets: readonly ScreentimeBucket[],
): ScreentimeBucket | undefined {
  let best: ScreentimeBucket | undefined;
  let bestSeconds = 0;
  for (const bucket of buckets) {
    const seconds = bucket.activeSeconds + bucket.afkSeconds;
    if (seconds > bestSeconds) {
      best = bucket;
      bestSeconds = seconds;
    }
  }
  return best;
}

// --- World types and locations ----------------------------------------------------------

export interface TimeRow {
  key: string;
  label: string;
  seconds: number;
}

/** Type key for free-to-play time, which has no world type of its own. */
export const F2P_KEY = 'F2P';

/**
 * Time per world type, with free-to-play as total minus `MEMBERS` (a plain
 * F2P world has no type). Types overlap, so the rows can add up to more than
 * the total. Highest first, then by name.
 */
export function worldTypeRows(
  worldTypes: ScreentimeWorldsResponse['worldTypes'],
  totalSeconds: number,
): TimeRow[] {
  const members = worldTypes.find((row) => row.type === 'MEMBERS')?.seconds ?? 0;
  const f2p = Math.max(0, totalSeconds - members);
  const rows: TimeRow[] = worldTypes
    .filter((row) => row.seconds > 0)
    .map((row) => ({ key: row.type, label: formatWorldType(row.type), seconds: row.seconds }));
  if (f2p > 0) rows.push({ key: F2P_KEY, label: 'Free-to-play', seconds: f2p });
  rows.sort((a, b) => b.seconds - a.seconds || a.label.localeCompare(b.label));
  return rows;
}

/** Time per location as the API sorts it. `null` (no world list) is "Unknown". */
export function locationRows(locations: ScreentimeWorldsResponse['locations']): TimeRow[] {
  return locations
    .filter((row) => row.seconds > 0)
    .map((row) => ({
      key: row.location ?? 'null',
      label: formatLocation(row.location),
      seconds: row.seconds,
    }));
}

/**
 * World type column of the worlds table: `Members, Skill total`. A world
 * without `MEMBERS` is free-to-play, also when it has other types
 * (`Free-to-play, Skill total`), like the world types card counts it.
 */
export function worldTypesLabel(types: readonly string[]): string {
  const names = types.map(formatWorldType);
  if (!types.includes('MEMBERS')) names.unshift('Free-to-play');
  return names.join(', ');
}
