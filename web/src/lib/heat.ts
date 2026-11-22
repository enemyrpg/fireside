import type { HeatmapCell } from '@fireside/shared';
import { formatDuration } from '@/format';

// Heat scale for the heatmap and the activity calendar.

/** Highest heat step (`--heat-6`). */
export const HEAT_STEPS = 6;

/**
 * Heat step 0–6 for a value: 0 (`--heat-0`) for no time, else
 * `1 + floor(sqrt(v / max) × 6)`, capped at 6 (the formula gives 7 at the maximum).
 */
export function heatStep(value: number, max: number): number {
  if (value <= 0 || max <= 0) return 0;
  return Math.min(HEAT_STEPS, 1 + Math.floor(Math.sqrt(value / max) * HEAT_STEPS));
}

// --- Labels -------------------------------------------------------------------------

export const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const;
export function hourLabel(hour: number): string {
  return `${String(hour).padStart(2, '0')}:00`;
}

// --- Most play time per weekday and hour ----------

/** Weekday names, Monday first (index = weekday − 1). */
export const WEEKDAY_NAMES = [
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
  'Sunday',
] as const;

export interface HeatTotal {
  /** Weekday 1–7 (Monday first) or hour 0–23. */
  key: number;
  seconds: number;
}

/** The highest total; the earliest key wins a tie. `null` when there is no time. */
function highest(totals: readonly number[], firstKey: number): HeatTotal | null {
  let best: HeatTotal | null = null;
  totals.forEach((seconds, index) => {
    if (seconds > 0 && (best === null || seconds > best.seconds)) {
      best = { key: index + firstKey, seconds };
    }
  });
  return best;
}

/**
 * The weekday with the most play time: the sum of its cells over the whole
 * range (not an average per occurrence), so it matches the heatmap. Earliest
 * (Monday first) on a tie.
 */
export function mostPlayedWeekday(cells: readonly HeatmapCell[]): HeatTotal | null {
  const totals = Array.from({ length: 7 }, () => 0);
  for (const cell of cells) {
    const index = cell.weekday - 1;
    if (index >= 0 && index < 7) totals[index] = (totals[index] ?? 0) + cell.seconds;
  }
  return highest(totals, 1);
}

/** The hour of day with the most play time, summed over all weekdays. Earliest on a tie. */
export function mostPlayedHour(cells: readonly HeatmapCell[]): HeatTotal | null {
  const totals = Array.from({ length: 24 }, () => 0);
  for (const cell of cells) {
    if (cell.hour >= 0 && cell.hour < 24)
      totals[cell.hour] = (totals[cell.hour] ?? 0) + cell.seconds;
  }
  return highest(totals, 0);
}

/**
 * Two-hour blocks for the mobile heatmap: hours 2k and 2k + 1 summed into
 * block k (0–11), as heatmap cells with `hour` = the block's first hour.
 */
export function twoHourBlocks(cells: readonly HeatmapCell[]): HeatmapCell[] {
  const sums = new Map<number, number>();
  for (const cell of cells) {
    const key = cell.weekday * 100 + (cell.hour - (cell.hour % 2));
    sums.set(key, (sums.get(key) ?? 0) + cell.seconds);
  }
  return [...sums].map(([key, seconds]) => ({
    weekday: Math.floor(key / 100),
    hour: key % 100,
    seconds,
  }));
}

// --- Heatmap layouts --------------------------------------

/** Size of one layout: label column, cell, gap (px). */
export const HEATMAP_LAYOUTS = {
  hours: { label: 26, cell: 16, gap: 3, columns: 24, step: 1 },
  // 30 + 12 × (18 + 3) = 282 px: fits the card on a 360 px phone (290 px inside).
  twoHours: { label: 30, cell: 18, gap: 3, columns: 12, step: 2 },
} as const;

export type HeatmapLayout = keyof typeof HEATMAP_LAYOUTS;

/** Width of the grid in px: what its card must leave room for. */
export function heatmapWidth(layout: HeatmapLayout): number {
  const { label, cell, gap, columns } = HEATMAP_LAYOUTS[layout];
  return label + columns * cell + columns * gap;
}

// --- Facts above the grid and the screen-reader summary -------------

/** "21:00" for an hour, "20:00–22:00" for a two-hour block (`22:00–00:00` at the end). */
export function hourSpanLabel(start: number, hours: 1 | 2): string {
  return hours === 1 ? hourLabel(start) : `${hourLabel(start)}–${hourLabel((start + hours) % 24)}`;
}

export interface HeatFact {
  /** "Sunday", "21:00" or "20:00–22:00". */
  value: string;
  /** "day with most play time", "hour with …" or "2 hours with …". */
  what: string;
  /** "27 h 45 min". */
  duration: string;
}

/**
 * The day and the hour (PC) or two-hour block (mobile, as the grid shows it)
 * with the most play time: sums over the range, the earliest on a tie.
 * `null` without play time. The visible numbers and the grid's summary both
 * come from here, so they always agree.
 */
export function heatFacts(
  cells: readonly HeatmapCell[],
  hours: 1 | 2,
): { day: HeatFact; hour: HeatFact } | null {
  const day = mostPlayedWeekday(cells);
  const hour = mostPlayedHour(hours === 2 ? twoHourBlocks(cells) : cells);
  if (!day || !hour) return null;
  return {
    day: {
      value: WEEKDAY_NAMES[day.key - 1] ?? '',
      what: 'day with most play time',
      duration: formatDuration(day.seconds),
    },
    hour: {
      value: hourSpanLabel(hour.key, hours),
      what: hours === 1 ? 'hour with most play time' : '2 hours with most play time',
      duration: formatDuration(hour.seconds),
    },
  };
}

function sentence(fact: HeatFact): string {
  return `${fact.what.charAt(0).toUpperCase()}${fact.what.slice(1)}: ${fact.value}, ${fact.duration}.`;
}

/**
 * Accessible summary of the heatmap, the same day and hour or block as the
 * numbers above it: "Day with most play time: Sunday, 2 h. Hour with most
 * play time: 19:00, 2 h."
 */
export function heatmapSummary(cells: readonly HeatmapCell[], hours: 1 | 2): string {
  const facts = heatFacts(cells, hours);
  if (!facts) return 'No play time.';
  return `${sentence(facts.day)} ${sentence(facts.hour)}`;
}
