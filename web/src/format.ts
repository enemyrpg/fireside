import { toLocal } from '@fireside/shared';

// All number, time and name formatting for the dashboard.
//
// Times and dates are always shown in the server's time zone (`timeZone` from
// GET /health), never in the browser's. Local dates (`2026-11-09`) and ISO weeks
// (`2026-W45`) from the API are already local: they are split into numbers and
// formatted in UTC, never parsed with `new Date()` in browser time.

export const LOCALE = 'en-GB';

/** Time zone and clock for formatting. `now` defaults to the current time. */
export interface TimeContext {
  timeZone: string;
  now?: Date | number | string;
}

// --- Intl caches ------------------------------------------------------------

const numberFormats = new Map<string, Intl.NumberFormat>();
const dateFormats = new Map<string, Intl.DateTimeFormat>();

function numberFormat(options: Intl.NumberFormatOptions): Intl.NumberFormat {
  const key = JSON.stringify(options);
  let format = numberFormats.get(key);
  if (!format) {
    format = new Intl.NumberFormat(LOCALE, options);
    numberFormats.set(key, format);
  }
  return format;
}

function dateFormat(options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = JSON.stringify(options);
  let format = dateFormats.get(key);
  if (!format) {
    format = new Intl.DateTimeFormat(LOCALE, options);
    dateFormats.set(key, format);
  }
  return format;
}

function toDate(value: string | Date | number): Date {
  return value instanceof Date ? value : new Date(value);
}

function nowOf(context: TimeContext): Date {
  return context.now === undefined ? new Date() : toDate(context.now);
}

// --- Numbers ----------------------------------------------------------------

/** Whole number with thousands separators: `2,851`. */
export function formatInt(value: number): string {
  return numberFormat({ maximumFractionDigits: 0 }).format(value);
}

const COMPACT_UNITS = [
  { size: 1e3, suffix: 'K' },
  { size: 1e6, suffix: 'M' },
  { size: 1e9, suffix: 'B' },
] as const;

type CompactUnit = (typeof COMPACT_UNITS)[number];

/** Decimals for a value already divided by its unit. */
function compactDecimals(suffix: CompactUnit['suffix'], scaled: number): number {
  if (suffix === 'B') return 2;
  if (suffix === 'M') return scaled < 100 ? 2 : 1;
  return scaled < 100 ? 1 : 0;
}

/**
 * Compact number for XP and GP in cards: below 10,000 the whole number, then
 * K (1 decimal below 100K), M (2 decimals below 100M, else 1) and B (2 decimals).
 * Trailing zeros are dropped: `8,866`, `26.7K`, `175K`, `12.08M`, `333.1M`, `2.13B`.
 */
export function formatCompact(value: number): string {
  const abs = Math.abs(value);
  if (abs < 10_000) return formatInt(value);
  const sign = value < 0 ? '-' : '';
  let index = abs >= 1e9 ? 2 : abs >= 1e6 ? 1 : 0;
  for (;;) {
    const unit: CompactUnit = COMPACT_UNITS[index] ?? COMPACT_UNITS[2];
    const scaled = abs / unit.size;
    const decimals = compactDecimals(unit.suffix, scaled);
    const factor = 10 ** decimals;
    const rounded = Math.round(scaled * factor) / factor;
    // 999,999 rounds to 1000K: show it as 1M instead.
    if (rounded >= 1000 && index < COMPACT_UNITS.length - 1) {
      index++;
      continue;
    }
    return `${sign}${numberFormat({ maximumFractionDigits: decimals }).format(rounded)}${unit.suffix}`;
  }
}

/** GP in cards: `1.12M gp`. Show `formatGpExact` in the tooltip. */
export function formatGp(value: number): string {
  return `${formatCompact(value)} gp`;
}

/** Exact GP for tooltips: `1,120,000 gp`. */
export function formatGpExact(value: number): string {
  return `${formatInt(value)} gp`;
}

/** XP in tables: whole number with `+` for a gain: `+553,151`. */
export function formatXpGain(value: number): string {
  return value > 0 ? `+${formatInt(value)}` : formatInt(value);
}

/** Percentage from a ratio, no space: `0.2` -> `20%`. */
export function formatPercent(ratio: number): string {
  return numberFormat({ style: 'percent', maximumFractionDigits: 0 }).format(ratio);
}

/**
 * A change as a percentage with its sign and at most one decimal, with a real
 * minus sign: `0.042` -> `+4.2%`, `-0.026` -> `−2.6%`, `0` -> `0%`. A change
 * too small for one decimal still shows its direction: `0.0004` -> `+<0.1%`.
 */
export function formatSignedPercent(ratio: number): string {
  if (ratio !== 0 && Math.abs(ratio) < 0.0005) return `${ratio > 0 ? '+' : '−'}<0.1%`;
  return numberFormat({ style: 'percent', maximumFractionDigits: 1, signDisplay: 'exceptZero' })
    .format(ratio)
    .replace('-', '−');
}

/**
 * How much of something is done, with one decimal, rounded down so it never
 * says 100% before it is: `1999 of 2000` -> `99.9%`, `0 of 0` -> `0.0%`.
 */
export function formatProgressPercent(done: number, total: number): string {
  // Whole numbers first, so 29 of 100 is exactly 290 tenths, not 289.99….
  const tenths = total > 0 ? Math.floor((Math.min(done, total) * 1000) / total) : 0;
  return numberFormat({
    style: 'percent',
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  }).format(tenths / 1000);
}

// --- Durations --------------------------------------------------------------

/** `4 h 55 min`, `3 h`, `40 min`. Never seconds (rounded down to whole minutes). */
export function formatDuration(seconds: number): string {
  const totalMinutes = Math.floor(Math.max(0, seconds) / 60);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours === 0) return `${String(minutes)} min`;
  if (minutes === 0) return `${formatInt(hours)} h`;
  return `${formatInt(hours)} h ${String(minutes)} min`;
}

/**
 * How long a job ran, from milliseconds: `0.8 s`, `12 s`, `1 min 15 s`,
 * `1 h 2 min`. Unlike `formatDuration`, it keeps seconds (a rebuild can be short).
 */
/** File size in powers of 1000: `999 B`, `1.5 kB`, `19 MB`, `2.5 GB`. */
export function formatBytes(bytes: number): string {
  const units = ['B', 'kB', 'MB', 'GB', 'TB'];
  let value = Math.max(0, bytes);
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit++;
  }
  const digits = unit === 0 || value >= 10 ? 0 : 1;
  return `${numberFormat({ maximumFractionDigits: digits, minimumFractionDigits: digits }).format(value)} ${units[unit] ?? 'TB'}`;
}

export function formatRunTime(ms: number): string {
  const safe = Math.max(0, ms);
  if (safe < 10_000) {
    return `${numberFormat({ maximumFractionDigits: 1 }).format(safe / 1000)} s`;
  }
  const totalSeconds = Math.floor(safe / 1000);
  if (totalSeconds < 60) return `${String(totalSeconds)} s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes >= 60) return formatDuration(totalSeconds);
  return seconds === 0 ? `${String(minutes)} min` : `${String(minutes)} min ${String(seconds)} s`;
}

/** Time axis label in hours: `0h`, `4h`, `12h`. */
export function formatAxisHours(hours: number): string {
  return `${formatInt(hours)}h`;
}

/** Personal best time, `m:ss.s` (`18:08.4`), or `h:mm:ss.s` from one hour. Show in mono. */
export function formatPbTime(seconds: number): string {
  const tenths = Math.round(Math.max(0, seconds) * 10);
  const hours = Math.floor(tenths / 36_000);
  const minutes = Math.floor((tenths % 36_000) / 600);
  const secs = (tenths % 600) / 10;
  const secText = secs.toFixed(1).padStart(4, '0');
  if (hours > 0) return `${String(hours)}:${String(minutes).padStart(2, '0')}:${secText}`;
  return `${String(minutes)}:${secText}`;
}

export interface DeltaInput {
  current: number;
  previous: number;
  /** Formats the absolute difference, e.g. `formatDuration`. */
  format: (value: number) => string;
  /** What the value is compared with, e.g. `previous 30 days`. */
  comparedTo: string;
}

/**
 * Neutral change against an earlier period: `▼ 4 h 1 min (−2%) vs previous 30 days`.
 * Never coloured. No percentage when the previous value is 0.
 */
export function formatDelta({ current, previous, format, comparedTo }: DeltaInput): string {
  const diff = current - previous;
  if (diff === 0) return `No change vs ${comparedTo}`;
  const arrow = diff > 0 ? '▲' : '▼';
  const percent =
    previous === 0 ? '' : ` (${diff < 0 ? '−' : '+'}${formatPercent(Math.abs(diff) / previous)})`;
  return `${arrow} ${format(Math.abs(diff))}${percent} vs ${comparedTo}`;
}

// --- Times and dates (server time zone) -------------------------------------

/** 24-hour clock in the server's time zone: `16:32`. */
export function formatClock(value: string | Date | number, { timeZone }: TimeContext): string {
  return dateFormat({ timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(
    toDate(value),
  );
}

interface DateParts {
  year: number;
  month: number;
  day: number;
}

/** Year, month and day of `value` in `timeZone` (shared local-time rules, `shared/src/time.ts`). */
export function datePartsIn(value: string | Date | number, timeZone: string): DateParts {
  const { year, month, day } = toLocal(toDate(value).getTime(), timeZone);
  return { year, month, day };
}

/** The local date (`2026-11-09`) of `value` in `timeZone`. */
export function localDateIn(value: string | Date | number, timeZone: string): string {
  const { year, month, day } = datePartsIn(value, timeZone);
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function currentYear(context: TimeContext): number {
  return datePartsIn(nowOf(context), context.timeZone).year;
}

const LOCAL_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Splits a local date string into numbers. Throws on anything else. */
export function parseLocalDate(value: string): DateParts {
  const match = LOCAL_DATE.exec(value);
  if (!match) throw new Error(`Not a local date: ${value}`);
  return { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
}

/** Formats calendar parts as a date. UTC is only the carrier here: no zone conversion happens. */
function formatParts({ year, month, day }: DateParts, withYear: boolean): string {
  const carrier = new Date(Date.UTC(year, month - 1, day, 12));
  const parts = dateFormat({
    timeZone: 'UTC',
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  }).formatToParts(carrier);
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? '';
  // Built from parts: Intl adds a comma after the weekday when the year is included.
  const text = `${get('weekday')} ${get('day')} ${get('month')}`;
  return withYear ? `${text} ${get('year')}` : text;
}

/**
 * Date of a timestamp in the server's time zone: `Tue 10 Nov`, with the year
 * only when it isn't the current year: `Sat 7 Dec 2025`.
 */
export function formatDate(value: string | Date | number, context: TimeContext): string {
  const parts = datePartsIn(value, context.timeZone);
  return formatParts(parts, parts.year !== currentYear(context));
}

/** A local date from the API (`2026-11-09`), formatted like `formatDate`. */
export function formatLocalDate(value: string, context: TimeContext): string {
  const parts = parseLocalDate(value);
  return formatParts(parts, parts.year !== currentYear(context));
}

/** A local date from the API (`2026-11-16`), always with the year: `Mon 16 Nov 2026`. */
export function formatLocalDateLong(value: string): string {
  return formatParts(parseLocalDate(value), true);
}

/** Month and year of a timestamp in the server's time zone: `Nov 2026`. */
export function formatMonthYear(value: string | Date | number, context: TimeContext): string {
  return dateFormat({ timeZone: context.timeZone, month: 'short', year: 'numeric' }).format(
    toDate(value),
  );
}

/**
 * A local month from the API (`2026-11`): `Nov`, or with the year as
 * `Nov 2026` (`numeric`) or `Nov 26` (`2-digit`).
 */
export function formatMonth(value: string, year?: 'numeric' | '2-digit'): string {
  const [yearNumber = 0, month = 1] = value.split('-').map(Number);
  return dateFormat({ timeZone: 'UTC', month: 'short', ...(year ? { year } : {}) }).format(
    new Date(Date.UTC(yearNumber, month - 1, 15)),
  );
}

/** A local date as a short chart axis label, without weekday or year: `2026-11-09` -> `9 Nov`. */
export function formatAxisDate(value: string): string {
  const { year, month, day } = parseLocalDate(value);
  return dateFormat({ timeZone: 'UTC', day: 'numeric', month: 'short' }).format(
    new Date(Date.UTC(year, month - 1, day, 12)),
  );
}

/** A local date as a weekday axis label: `2026-11-09` -> `Mon`. */
export function formatAxisWeekday(value: string): string {
  const { year, month, day } = parseLocalDate(value);
  return dateFormat({ timeZone: 'UTC', weekday: 'short' }).format(
    new Date(Date.UTC(year, month - 1, day, 12)),
  );
}

/** A local date as a day-of-month axis label: `2026-11-09` -> `9`. */
export function formatAxisDay(value: string): string {
  return String(parseLocalDate(value).day);
}

/** `1 Nov, 16:26`, with the year when it isn't the current year: `1 Nov 2025, 16:26`. */
export function formatDateTime(value: string | Date | number, context: TimeContext): string {
  const parts = datePartsIn(value, context.timeZone);
  const date = dateFormat({
    timeZone: context.timeZone,
    day: 'numeric',
    month: 'short',
    ...(parts.year !== currentYear(context) ? { year: 'numeric' } : {}),
  }).format(toDate(value));
  return `${date}, ${formatClock(value, context)}`;
}

/**
 * Within 24 hours: `just now`, `12 min ago`, `3 h ago`. Older: `1 Nov, 16:26`.
 * Timestamps slightly in the future (clock skew) count as `just now`.
 */
export function formatRelative(value: string | Date | number, context: TimeContext): string {
  const diffMs = nowOf(context).getTime() - toDate(value).getTime();
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${String(minutes)} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${String(hours)} h ago`;
  return formatDateTime(value, context);
}

// --- ISO weeks --------------------------------------------------------------

const ISO_WEEK = /^(\d{4})-W(\d{2})$/;

export interface IsoWeekParts {
  year: number;
  week: number;
}

/** Splits `2026-W45` into numbers. Throws on anything else. */
export function parseIsoWeek(value: string): IsoWeekParts {
  const match = ISO_WEEK.exec(value);
  if (!match) throw new Error(`Not an ISO week: ${value}`);
  return { year: Number(match[1]), week: Number(match[2]) };
}

/** Monday of an ISO week as a local date (`2026-W46` -> `2026-11-09`). */
export function isoWeekStart(value: string): string {
  const { year, week } = parseIsoWeek(value);
  // 4 January is always in week 1. Calendar arithmetic only, in UTC.
  const jan4 = Date.UTC(year, 0, 4);
  const jan4Weekday = (new Date(jan4).getUTCDay() + 6) % 7; // Monday = 0
  const monday = new Date(jan4 + ((week - 1) * 7 - jan4Weekday) * 86_400_000);
  return monday.toISOString().slice(0, 10);
}

/** `Week 46`, or `2026 · week 46` with the year. */
export function formatIsoWeek(value: string, { withYear = false } = {}): string {
  const { year, week } = parseIsoWeek(value);
  return withYear ? `${String(year)} · week ${String(week)}` : `Week ${String(week)}`;
}

// --- Names ------------------------------------------------------------------

/** Sentence case of an enum name: `SKILL_TOTAL` -> `Skill total`. */
export function titleCase(value: string): string {
  const words = value.toLowerCase().replaceAll('_', ' ').trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Title case of an enum name, every word capitalised: `NEW_ZEALAND` -> `New Zealand`. */
export function titleCaseWords(value: string): string {
  return value
    .toLowerCase()
    .split('_')
    .filter((word) => word !== '')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

/** Skill name: `RUNECRAFT` -> `Runecraft`. */
export function formatSkill(skill: string): string {
  return titleCase(skill);
}

const LOCATION_NAMES: Record<string, string> = {
  UNITED_STATES_OF_AMERICA: 'United States',
  UNITED_KINGDOM: 'United Kingdom',
  GERMANY: 'Germany',
  AUSTRALIA: 'Australia',
};

/**
 * World location: `UNITED_STATES_OF_AMERICA` -> `United States`. Unknown
 * values in title case (`NEW_ZEALAND` -> `New Zealand`). `null` -> `Unknown`.
 */
export function formatLocation(location: string | null): string {
  if (location === null) return 'Unknown';
  return LOCATION_NAMES[location] ?? titleCaseWords(location);
}

const WORLD_TYPE_NAMES: Record<string, string> = {
  MEMBERS: 'Members',
  PVP: 'PvP',
  PVP_ARENA: 'PvP Arena',
  BOUNTY: 'Bounty',
  SKILL_TOTAL: 'Skill total',
  HIGH_RISK: 'High risk',
  LAST_MAN_STANDING: 'Last Man Standing',
  QUEST_SPEEDRUNNING: 'Quest speedrunning',
  FRESH_START_WORLD: 'Fresh start',
  DEADMAN: 'Deadman',
  SEASONAL: 'Seasonal',
  TOURNAMENT: 'Tournament',
  BETA_WORLD: 'Beta',
};

/** World type: `SKILL_TOTAL` -> `Skill total`. Unknown types in sentence case. */
export function formatWorldType(type: string): string {
  return WORLD_TYPE_NAMES[type] ?? titleCase(type);
}

const ACCOUNT_TYPE_NAMES: Record<string, string> = {
  NORMAL: 'Normal',
  IRONMAN: 'Ironman',
  ULTIMATE_IRONMAN: 'Ultimate ironman',
  HARDCORE_IRONMAN: 'Hardcore ironman',
  GROUP_IRONMAN: 'Group ironman',
  HARDCORE_GROUP_IRONMAN: 'HC group ironman',
  UNRANKED_GROUP_IRONMAN: 'Unranked group ironman',
};

/** Account type as text, never an icon: `HARDCORE_GROUP_IRONMAN` -> `HC group ironman`. */
export function formatAccountType(type: string): string {
  return ACCOUNT_TYPE_NAMES[type] ?? titleCase(type);
}

// --- Bank --------------------------------------------------------------------

/** A count with its noun: `1 item`, `94 items`, `1,204 slots`. */
export function formatCount(count: number, noun: string): string {
  return `${formatInt(count)} ${noun}${count === 1 ? '' : 's'}`;
}

/** Items and placeholders of a bank: `94 items · 1 placeholder`. */
export function formatItemCount(items: number, placeholders: number): string {
  return `${formatCount(items, 'item')} · ${formatCount(placeholders, 'placeholder')}`;
}

/** Bank tab by number (0 is the main tab): `Main tab`, `Tab 2`. */
export function formatBankTab(tab: number): string {
  return tab === 0 ? 'Main tab' : `Tab ${String(tab)}`;
}

/** Equipment slot from RuneLite's enum name: `HEAD` -> `Head`, `QUIVER_AMMO` -> `Quiver ammo`. */
export function formatEquipmentSlot(slot: string): string {
  return titleCase(slot);
}

// --- Bound formatter --------------------------------------------------------

/** The time-dependent formatters bound to one time zone (see `useFormat`). */
export function createFormatter(timeZone: string, now: () => Date = () => new Date()) {
  const context = (): TimeContext => ({ timeZone, now: now() });
  return {
    timeZone,
    clock: (value: string | Date | number) => formatClock(value, context()),
    date: (value: string | Date | number) => formatDate(value, context()),
    localDate: (value: string) => formatLocalDate(value, context()),
    dateTime: (value: string | Date | number) => formatDateTime(value, context()),
    relative: (value: string | Date | number) => formatRelative(value, context()),
    monthYear: (value: string | Date | number) => formatMonthYear(value, context()),
    localDateOf: (value: string | Date | number) => localDateIn(value, timeZone),
  };
}

export type Formatter = ReturnType<typeof createFormatter>;
