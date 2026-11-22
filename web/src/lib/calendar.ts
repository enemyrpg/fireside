import { addDays, weekdayOf, type CalendarDay } from '@fireside/shared';
import { formatInt, parseLocalDate } from '@/format';
import { dateKey, lastDaysRange } from './time';

// Layout of the activity calendar on Home: a rolling year in week columns,
// Monday first. Calendar arithmetic only, on local dates from the API (never
// `new Date()` in the browser's time zone).

/**
 * Days in the calendar: today and the 364 days before it. The calendar API
 * allows at most 366 days, so a full 53 weeks (up to 371 days) doesn't fit;
 * 365 days always fit in 53 columns.
 */
export const CALENDAR_DAYS = 365;

/** Week columns in the grid: enough for `CALENDAR_DAYS` starting on any weekday. */
export const CALENDAR_WEEKS = 53;

/** `[from, to)` of the calendar query: local midnight 364 days ago to the next local midnight. */
export function calendarRange(today: string, timeZone: string): { from: string; to: string } {
  return lastDaysRange(CALENDAR_DAYS, today, timeZone);
}

export interface CalendarCell {
  /** Local date (`2026-11-11`). */
  date: string;
  /** Inside the year shown. Cells before it (first column) and after today (last column) are blank. */
  inRange: boolean;
  /** Play time that day, or `null` for none. */
  day: CalendarDay | null;
}

export interface CalendarGrid {
  /** `CALENDAR_WEEKS` columns of 7 cells, Monday first, oldest week first. */
  weeks: CalendarCell[][];
  /** Month label per column: the short month name where a month's first Monday starts, else `''`. */
  monthLabels: string[];
}

const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
] as const;

/** The grid for the year ending on `today`, filled with the days that have play time. */
export function calendarGrid(today: string, days: readonly CalendarDay[]): CalendarGrid {
  const byDate = new Map(days.map((day) => [day.date, day]));
  const end = parseLocalDate(today);
  const first = addDays(end, -(CALENDAR_DAYS - 1));
  // Monday of the first column, and the column count from the last Monday.
  const lastMonday = addDays(end, -(weekdayOf(end) - 1));
  const startMonday = addDays(lastMonday, -(CALENDAR_WEEKS - 1) * 7);
  const firstKey = dateKey(first);

  const weeks: CalendarCell[][] = [];
  const monthLabels: string[] = [];
  let lastMonth = -1;
  for (let week = 0; week < CALENDAR_WEEKS; week++) {
    const cells: CalendarCell[] = [];
    for (let weekday = 0; weekday < 7; weekday++) {
      const date = dateKey(addDays(startMonday, week * 7 + weekday));
      const inRange = date >= firstKey && date <= today;
      cells.push({ date, inRange, day: inRange ? (byDate.get(date) ?? null) : null });
    }
    weeks.push(cells);
    // A month gets its label on the first column whose Monday is in it.
    const monday = addDays(startMonday, week * 7);
    const label = monday.month !== lastMonth && week > 0 ? MONTHS[monday.month - 1] : '';
    monthLabels.push(label ?? '');
    lastMonth = monday.month;
  }
  return { weeks, monthLabels };
}

/** "N days played in the last year". */
export function daysPlayedLabel(count: number): string {
  return `${formatInt(count)} ${count === 1 ? 'day' : 'days'} played in the last year`;
}
