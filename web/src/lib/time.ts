import {
  addDays,
  fromLocal,
  isoWeekOf,
  periodStartOf,
  type GainsPeriod,
  type LocalDate,
} from '@fireside/shared';
import { formatClock, isoWeekStart, localDateIn, parseLocalDate } from '@/format';

// Chart ranges in the server's time zone. The local-time rules (DST, ISO weeks)
// come from `shared/src/time.ts`, the same code the server uses for gains
// periods, so both always agree.

/** Days in the chart for the Day period: today and the 6 days before it. */
export const DAY_CHART_DAYS = 7;

/**
 * Start of the XP chart for a gains period, with `today` as a local date
 * (`2026-11-11`). Week, month and year start exactly like the server's gains
 * periods, so the chart covers the same days as the gains table. Day has no
 * hourly data, so it shows the last 7 days. There is no end: the series ends now.
 */
export function chartFrom(period: GainsPeriod, today: string, timeZone: string): string {
  const date = parseLocalDate(today);
  if (period === 'day') return lastDaysFrom(DAY_CHART_DAYS, today, timeZone);
  return new Date(periodStartOf(date, period, timeZone)).toISOString();
}

/**
 * Start of a range of the last `days` local days, today included: local
 * midnight `days - 1` days before `today`. Same window as KC
 * `gainedLast30Days` on the server. There is no end: the range ends now.
 */
export function lastDaysFrom(days: number, today: string, timeZone: string): string {
  return new Date(
    fromLocal(addDays(parseLocalDate(today), -(days - 1)), 0, 0, timeZone),
  ).toISOString();
}

/**
 * The last `days` local days as a closed range, today included: from local
 * midnight `days - 1` days before `today` to the next local midnight. The
 * screen time API needs both ends.
 */
export function lastDaysRange(
  days: number,
  today: string,
  timeZone: string,
): { from: string; to: string } {
  return {
    from: lastDaysFrom(days, today, timeZone),
    to: new Date(fromLocal(addDays(parseLocalDate(today), 1), 0, 0, timeZone)).toISOString(),
  };
}

// --- ISO weeks (calendar arithmetic only, weeks are local) ---

/** A local date as a key (`2026-11-11`). */
export function dateKey({ year, month, day }: LocalDate): string {
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/**
 * Whether `value` looks like an ISO week key (`2026-W45`, weeks 01–53). Week
 * 53 in a year without it passes; the server answers that with a 400.
 */
export function isIsoWeekKey(value: string): boolean {
  return /^\d{4}-W(0[1-9]|[1-4]\d|5[0-3])$/.test(value);
}

/** ISO week of a local date: `2026-11-11` -> `2026-W46`. */
export function weekOfDate(date: string): string {
  const { year, week } = isoWeekOf(parseLocalDate(date));
  return `${String(year).padStart(4, '0')}-W${String(week).padStart(2, '0')}`;
}

/** The week `weeks` weeks after `week` (negative for earlier), across years and week 53. */
export function shiftWeek(week: string, weeks: number): string {
  return weekOfDate(dateKey(addDays(parseLocalDate(isoWeekStart(week)), weeks * 7)));
}

/** Monday and Sunday of a week as local dates: `2026-W45` -> `2026-11-02`, `2026-11-08`. */
export function weekDates(week: string): { monday: string; sunday: string } {
  const monday = isoWeekStart(week);
  return { monday, sunday: dateKey(addDays(parseLocalDate(monday), 6)) };
}

/** Weeks from `newest` back to `oldest`, newest first. Empty when `oldest` is after `newest`. */
export function weeksBetween(oldest: string, newest: string): string[] {
  const weeks: string[] = [];
  // ISO week keys sort as strings (`2026-W09` < `2026-W45` < `2027-W01`).
  for (let week = newest; week >= oldest; week = shiftWeek(week, -1)) weeks.push(week);
  return weeks;
}

// --- A date and a time typed by the owner, in the server's time zone ----------

/** A 24-hour time as typed: `21:40` or `9:05`. `null` for anything else. */
export function parseClock(text: string): { hour: number; minute: number } | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(text.trim());
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  return hour <= 23 && minute <= 59 ? { hour, minute } : null;
}

/** The local date (`2026-11-16`) and time (`21:40`) of an instant in `timeZone`. */
export function localDateTimeOf(ms: number, timeZone: string): { date: string; time: string } {
  return { date: localDateIn(ms, timeZone), time: formatClock(ms, { timeZone }) };
}

/**
 * The instant of a local date and a 24-hour time in `timeZone`, as UTC ISO
 * 8601. `null` when the time can't be read. DST gaps and overlaps follow
 * `fromLocal` in shared.
 */
export function localDateTimeToIso(date: string, time: string, timeZone: string): string | null {
  const clock = parseClock(time);
  if (!clock) return null;
  return new Date(
    fromLocal(parseLocalDate(date), clock.hour, clock.minute, timeZone),
  ).toISOString();
}

/**
 * A local date as the `Date` a calendar widget works with: that calendar day
 * at noon in the browser's zone. Only its year, month and day mean anything,
 * so the browser's time zone never moves the day.
 */
export function calendarDate(date: string): Date {
  const { year, month, day } = parseLocalDate(date);
  return new Date(year, month - 1, day, 12);
}

/** The calendar day of a widget's `Date` as a local date. Inverse of `calendarDate`. */
export function localDateOfCalendar(date: Date): string {
  return dateKey({ year: date.getFullYear(), month: date.getMonth() + 1, day: date.getDate() });
}
