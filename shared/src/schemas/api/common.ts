import { z } from 'zod';
import { nonNegativeInt, positiveInt, utcTimestamp } from '../common.js';
import { LOOT_SOURCE_TYPES } from '../events.js';

// Building blocks for API requests and responses. All objects are strict: unknown keys are
// rejected, also in responses, so the server can't leak fields by accident.

// --- Accounts and params ----------------------------------------------------

/** Account ID in the database (not the RuneLite account hash). */
export const accountId = positiveInt;

/**
 * Whole number from a path or query string, then checked by `schema`.
 * Only plain digits are accepted: `''`, `' 1'`, `'01'`, `'1.0'`, `'1e0'` and
 * `'0x1'` are rejected (`z.coerce.number` would turn them into numbers).
 */
export function intFromString(schema: z.ZodInt) {
  return z
    .string()
    .regex(/^(0|[1-9]\d*)$/, 'Must be a whole number')
    .transform(Number)
    .pipe(schema);
}

/** Account ID from a path parameter (a string). */
export const accountIdParam = intFromString(z.int().positive());

/** `:accountId` on endpoints that also accept `all` (summed over all accounts). */
export const accountScopeParam = z.union([z.literal('all'), accountIdParam]);

export const accountParamsSchema = z.strictObject({ accountId: accountIdParam });
export const accountScopeParamsSchema = z.strictObject({ accountId: accountScopeParam });

// --- Dates and periods (local time, `TZ` from .env) -------------------------

/** Local date, e.g. `2026-11-09`. */
export const localDateSchema = z.iso.date();

/** Weekday of 31 December in `year` (0 = Sunday), Gregorian calendar. */
function dec31Weekday(year: number): number {
  return (year + Math.floor(year / 4) - Math.floor(year / 100) + Math.floor(year / 400)) % 7;
}

/** Whether `year` has an ISO week 53 (the year starts on a Thursday, or ends on one). */
export function hasIsoWeek53(year: number): boolean {
  return dec31Weekday(year) === 4 || dec31Weekday(year - 1) === 3;
}

/** ISO week, e.g. `2026-W45`. Week 53 only in years that have it. */
export const isoWeekSchema = z
  .string()
  .regex(/^\d{4}-W(0[1-9]|[1-4]\d|5[0-3])$/, 'Must be an ISO week like 2026-W45')
  .refine((week) => !week.endsWith('-W53') || hasIsoWeek53(Number(week.slice(0, 4))), {
    message: 'This year has no week 53',
  });

/** Month, e.g. `2026-11`. */
export const yearMonthSchema = z
  .string()
  .regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Must be a month like 2026-11');

export const BUCKETS = ['day', 'week', 'month'] as const;
export const bucketSchema = z.enum(BUCKETS);
export type Bucket = z.infer<typeof bucketSchema>;

const periodKeySchemas = { day: localDateSchema, week: isoWeekSchema, month: yearMonthSchema };

/** Whether `key` is a valid period key for `bucket` (`2026-11-09`, `2026-W45` or `2026-11`). */
export function isPeriodKey(bucket: Bucket, key: string): boolean {
  return periodKeySchemas[bucket].safeParse(key).success;
}

/** Adds an issue for every item whose `period` doesn't match `bucket`. */
export function checkPeriodKeys(
  bucket: Bucket,
  items: readonly { period: string }[],
  field: string,
  ctx: z.RefinementCtx,
): void {
  items.forEach((item, index) => {
    if (!isPeriodKey(bucket, item.period)) {
      ctx.addIssue({
        code: 'custom',
        message: `Must be a ${bucket} key`,
        path: [field, index, 'period'],
      });
    }
  });
}

// --- Query helpers ----------------------------------------------------------

/** Optional time range `[from, to)` in UTC. */
export const timeRangeFields = {
  from: utcTimestamp.optional(),
  to: utcTimestamp.optional(),
};

/**
 * Whether `start` is before `end`. A missing end (`null`/`undefined`) is open.
 * Timestamps have the same format, so string comparison is chronological.
 */
export function isOrdered(start?: string | null, end?: string | null): boolean {
  return start == null || end == null || start < end;
}

/** Rejects `to` that isn't after `from`. Used by queries and responses with `from`/`to`. */
export function refineTimeRange<
  S extends z.ZodType<{ from?: string | null | undefined; to?: string | null | undefined }>,
>(schema: S) {
  return schema.refine((range) => isOrdered(range.from, range.to), {
    message: 'to must be after from',
    path: ['to'],
  });
}

/** Longest `from`/`to` range for calendar and screen time, in days of 24 hours. */
export const MAX_RANGE_DAYS = 366;
const MAX_RANGE_MS = MAX_RANGE_DAYS * 24 * 60 * 60 * 1000;

/**
 * Checks a `[from, to)` range: both or neither, `to` after `from` and at most
 * `MAX_RANGE_DAYS`. Issues go on `from` or `to`. For `.superRefine`.
 */
export function checkBoundedRange(
  range: { from?: string | null | undefined; to?: string | null | undefined },
  ctx: z.RefinementCtx,
): void {
  const issue = (path: 'from' | 'to', message: string) => {
    ctx.addIssue({ code: 'custom', message, path: [path] });
  };
  if (range.from == null || range.to == null) {
    if (range.from != null || range.to != null) {
      issue(range.from == null ? 'from' : 'to', 'from and to must be given together');
    }
    return;
  }
  if (!isOrdered(range.from, range.to)) {
    issue('to', 'to must be after from');
  } else if (Date.parse(range.to) - Date.parse(range.from) > MAX_RANGE_MS) {
    issue('to', `Range must be at most ${String(MAX_RANGE_DAYS)} days`);
  }
}

/** Whole number >= 0 from a query string. */
export const nonNegativeIntQuery = intFromString(z.int().nonnegative());

// --- Pagination -------------------------------------------------------------

export const DEFAULT_PAGE_LIMIT = 50;
export const MAX_PAGE_LIMIT = 100;

/** Cursor pagination. The cursor is opaque: pass `nextCursor` from the previous page. */
export const paginationQueryFields = {
  cursor: z.string().min(1).optional(),
  limit: intFromString(z.int().min(1).max(MAX_PAGE_LIMIT)).default(DEFAULT_PAGE_LIMIT),
};

export const paginationQuerySchema = z.strictObject(paginationQueryFields);

/** A page of `item`. `nextCursor` is `null` on the last page. */
export function paginated<T extends z.ZodType>(item: T) {
  return z.strictObject({
    items: z.array(item),
    nextCursor: z.string().min(1).nullable(),
  });
}

// --- Errors -----------------------------------------------------------------

export const ERROR_CODES = [
  'VALIDATION_ERROR',
  'BAD_REQUEST',
  'UNAUTHORIZED',
  'FORBIDDEN',
  'NOT_FOUND',
  /** Since 1.25.0. */
  'CONFLICT',
  'PAYLOAD_TOO_LARGE',
  /**
   * `429`: wait as `Retry-After` says. Since 1.37.0 also with `503` and
   * `Retry-After` on the routes that hash or check a password, when too many
   * such requests are waiting ("The server is busy. …"): nothing was checked
   * or used up, so the same request can be sent again.
   */
  'RATE_LIMITED',
  'INTERNAL_ERROR',
] as const;

export const errorDetailSchema = z.strictObject({
  /** Dot path to the field, e.g. `query.limit`. Empty for the whole request. */
  path: z.string(),
  message: z.string().min(1),
});

/** Error body for all endpoints. */
export const errorResponseSchema = z.strictObject({
  error: z.strictObject({
    code: z.enum(ERROR_CODES),
    message: z.string().min(1),
    details: z.array(errorDetailSchema),
  }),
});

// --- Shared response parts --------------------------------------------------

/** Loot source in responses. PLAYER never has a name; other sources always do. */
export const apiLootSourceSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('PLAYER'), name: z.null() }),
  z.strictObject({ type: z.enum(LOOT_SOURCE_TYPES).exclude(['PLAYER']), name: z.string().min(1) }),
]);

/**
 * Refinement (spread into `.refine(...)`) that checks
 * `object[totalKey] === activeSeconds + afkSeconds`.
 */
export function activeAfkSum<K extends string>(totalKey: K) {
  const check = (time: Record<K | 'activeSeconds' | 'afkSeconds', number>) =>
    time[totalKey] === time.activeSeconds + time.afkSeconds;
  const params = {
    message: `${totalKey} must equal activeSeconds + afkSeconds`,
    path: [totalKey] as PropertyKey[],
  };
  return [check, params] as const;
}

/** Played time split into active and AFK. Spread into objects, then refine with `activeAfkSum`. */
export const playtimeFields = {
  playedSeconds: nonNegativeInt,
  activeSeconds: nonNegativeInt,
  afkSeconds: nonNegativeInt,
};

/** `playedSeconds = activeSeconds + afkSeconds`. */
export const playtimeTotalsSchema = z
  .strictObject(playtimeFields)
  .refine(...activeAfkSum('playedSeconds'));

// --- Types ------------------------------------------------------------------

export type AccountScope = z.infer<typeof accountScopeParam>;
export type ErrorCode = (typeof ERROR_CODES)[number];
export type ErrorResponse = z.infer<typeof errorResponseSchema>;
export type ApiLootSource = z.infer<typeof apiLootSourceSchema>;
export type PlaytimeTotals = z.infer<typeof playtimeTotalsSchema>;
export type PaginationQuery = z.infer<typeof paginationQuerySchema>;
export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}
