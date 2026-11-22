// Local wall time ↔ UTC for an IANA time zone, using Intl only. Days, ISO
// weeks, months and years are local (TZ from .env); instants are UTC.
// Shared by the server (periods, gains, screen time) and the dashboard, so
// both use the same daylight-saving and week rules.

export const MINUTE_MS = 60_000;
export const HOUR_MS = 60 * MINUTE_MS;
export const DAY_MS = 24 * HOUR_MS;

export interface LocalDate {
  year: number;
  /** 1–12 */
  month: number;
  day: number;
}

export interface LocalDateTime extends LocalDate {
  hour: number;
  minute: number;
  /** ISO weekday: Monday = 1 … Sunday = 7. */
  weekday: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let format = formatters.get(timeZone);
  if (!format) {
    format = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    });
    formatters.set(timeZone, format);
  }
  return format;
}

function parts(ms: number, timeZone: string) {
  const values: Record<string, number> = {};
  for (const part of formatter(timeZone).formatToParts(ms)) {
    if (part.type !== 'literal') values[part.type] = Number(part.value);
  }
  return {
    year: values.year ?? 0,
    month: values.month ?? 0,
    day: values.day ?? 0,
    hour: values.hour ?? 0,
    minute: values.minute ?? 0,
    second: values.second ?? 0,
  };
}

/** Offset of `timeZone` from UTC at instant `ms`, in milliseconds (Oslo summer: +2 h). */
export function offsetAt(ms: number, timeZone: string): number {
  const p = parts(ms, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - (ms - (((ms % 1000) + 1000) % 1000));
}

/** Local date and time at instant `ms`. */
export function toLocal(ms: number, timeZone: string): LocalDateTime {
  const p = parts(ms, timeZone);
  const weekday = ((new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay() + 6) % 7) + 1;
  return { year: p.year, month: p.month, day: p.day, hour: p.hour, minute: p.minute, weekday };
}

/**
 * The instant for a local wall time. A time that doesn't exist (spring
 * forward gap) moves forward by the gap; a time that exists twice (autumn
 * overlap) gives the first one.
 */
export function fromLocal(date: LocalDate, hour: number, minute: number, timeZone: string): number {
  const wall = Date.UTC(date.year, date.month - 1, date.day, hour, minute);
  // Try both offsets around the wall time; take the earliest that maps back.
  const candidates = [offsetAt(wall - DAY_MS / 2, timeZone), offsetAt(wall + DAY_MS / 2, timeZone)]
    .map((offset) => wall - offset)
    .sort((a, b) => a - b);
  for (const candidate of candidates) {
    if (candidate + offsetAt(candidate, timeZone) === wall) return candidate;
  }
  // In a gap: neither offset maps back. Use the offset before the gap.
  return wall - offsetAt(wall - DAY_MS / 2, timeZone);
}

/** `date` plus `days` calendar days. */
export function addDays(date: LocalDate, days: number): LocalDate {
  const d = new Date(Date.UTC(date.year, date.month - 1, date.day + days));
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

/** ISO weekday (Monday = 1) of a calendar date. */
export function weekdayOf(date: LocalDate): number {
  return ((new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay() + 6) % 7) + 1;
}

/** Days from `a` to `b` (calendar days, ignoring time zones). */
export function daysBetween(a: LocalDate, b: LocalDate): number {
  return Math.round(
    (Date.UTC(b.year, b.month - 1, b.day) - Date.UTC(a.year, a.month - 1, a.day)) / DAY_MS,
  );
}

/**
 * Instants in [fromMs, toMs) where the UTC offset of `timeZone` changes
 * (DST start or end), found to the millisecond.
 */
export function offsetChanges(fromMs: number, toMs: number, timeZone: string): number[] {
  const changes: number[] = [];
  let previous = offsetAt(fromMs, timeZone);
  for (let t = fromMs + HOUR_MS; t < toMs + HOUR_MS; t += HOUR_MS) {
    const offset = offsetAt(t, timeZone);
    if (offset !== previous) {
      let low = t - HOUR_MS;
      let high = t;
      while (high - low > 1) {
        const mid = Math.floor((low + high) / 2);
        if (offsetAt(mid, timeZone) === previous) low = mid;
        else high = mid;
      }
      if (high >= fromMs && high < toMs) changes.push(high);
      previous = offset;
    }
  }
  return changes;
}

// --- Local calendar periods ---------------------------------------------------

/** Calendar period in local time. Weeks are ISO weeks (Monday to Sunday). */
export type PeriodUnit = 'day' | 'week' | 'month' | 'year';

function pad(value: number, length = 2): string {
  return String(value).padStart(length, '0');
}

/** First local date of the period containing `date`. */
function firstDateOf(date: LocalDate, unit: PeriodUnit): LocalDate {
  switch (unit) {
    case 'day':
      return date;
    case 'week':
      return addDays(date, 1 - weekdayOf(date));
    case 'month':
      return { year: date.year, month: date.month, day: 1 };
    case 'year':
      return { year: date.year, month: 1, day: 1 };
  }
}

/** The local date one period after `date` (a period's first date). */
function nextFirstDate(date: LocalDate, unit: PeriodUnit): LocalDate {
  switch (unit) {
    case 'day':
      return addDays(date, 1);
    case 'week':
      return addDays(date, 7);
    case 'month':
      return date.month === 12
        ? { year: date.year + 1, month: 1, day: 1 }
        : { year: date.year, month: date.month + 1, day: 1 };
    case 'year':
      return { year: date.year + 1, month: 1, day: 1 };
  }
}

/**
 * Start (UTC milliseconds) of the local period that contains the calendar date
 * `date`: the day itself, its ISO week's Monday, the 1st or 1 January, at
 * local midnight (or the first instant of the day if midnight is skipped).
 */
export function periodStartOf(date: LocalDate, unit: PeriodUnit, timeZone: string): number {
  return fromLocal(firstDateOf(date, unit), 0, 0, timeZone);
}

/** Local period containing instant `ms`: `[start, end)` in UTC milliseconds. */
export function periodAt(
  ms: number,
  unit: PeriodUnit,
  timeZone: string,
): { start: number; end: number } {
  // A skipped local midnight moves forward to the first instant of the day, so start <= ms.
  const first = firstDateOf(toLocal(ms, timeZone), unit);
  return {
    start: fromLocal(first, 0, 0, timeZone),
    end: fromLocal(nextFirstDate(first, unit), 0, 0, timeZone),
  };
}

/** ISO week of a calendar date: the year and week of its Thursday. */
export function isoWeekOf(date: LocalDate): { year: number; week: number } {
  const thursday = addDays(date, 4 - weekdayOf(date));
  const dayOfYear = daysBetween({ year: thursday.year, month: 1, day: 1 }, thursday) + 1;
  return { year: thursday.year, week: Math.floor((dayOfYear - 1) / 7) + 1 };
}

/**
 * Local ISO week `2026-W45` as `[start, end)` in UTC milliseconds: Monday
 * 00:00 to the next Monday 00:00 in `timeZone`. The inverse of
 * `periodKey(…, 'week')`. The key must be valid (see `isoWeekSchema`).
 */
export function isoWeekRange(key: string, timeZone: string): { start: number; end: number } {
  const year = Number(key.slice(0, 4));
  const week = Number(key.slice(6));
  // Week 1 is the week with January 4th.
  const jan4 = { year, month: 1, day: 4 };
  const monday = addDays(jan4, 1 - weekdayOf(jan4) + 7 * (week - 1));
  return {
    start: fromLocal(monday, 0, 0, timeZone),
    end: fromLocal(addDays(monday, 7), 0, 0, timeZone),
  };
}

/** Period key in local time: `2026-11-09`, `2026-W45`, `2026-11` or `2026`. */
export function periodKey(ms: number, unit: PeriodUnit, timeZone: string): string {
  const date = toLocal(ms, timeZone);
  switch (unit) {
    case 'day':
      return `${pad(date.year, 4)}-${pad(date.month)}-${pad(date.day)}`;
    case 'week': {
      const { year, week } = isoWeekOf(date);
      return `${pad(year, 4)}-W${pad(week)}`;
    }
    case 'month':
      return `${pad(date.year, 4)}-${pad(date.month)}`;
    case 'year':
      return pad(date.year, 4);
  }
}

/** Local periods that overlap `[fromMs, toMs)`, oldest first. */
export function periodsBetween(
  fromMs: number,
  toMs: number,
  unit: PeriodUnit,
  timeZone: string,
): { start: number; end: number }[] {
  const periods: { start: number; end: number }[] = [];
  let period = fromMs < toMs ? periodAt(fromMs, unit, timeZone) : undefined;
  while (period && period.start < toMs) {
    periods.push(period);
    period = periodAt(period.end, unit, timeZone);
  }
  return periods;
}

/**
 * Local hour containing instant `ms`: ISO weekday, hour (0–23) and an
 * instant `end` up to which (exclusive) the result stays the same, so callers
 * walking sorted instants can reuse it. Normally the end of the local hour.
 * If the offset changes inside the hour (not at its edge), `end` is `ms + 1`.
 */
export function localHourAt(
  ms: number,
  timeZone: string,
): { weekday: number; hour: number; end: number } {
  const { weekday, hour } = toLocal(ms, timeZone);
  const offset = offsetAt(ms, timeZone);
  const local = ms + offset;
  const end = local - (((local % HOUR_MS) + HOUR_MS) % HOUR_MS) + HOUR_MS - offset;
  return { weekday, hour, end: offsetAt(end - 1, timeZone) === offset ? end : ms + 1 };
}
