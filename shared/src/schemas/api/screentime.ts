import { z } from 'zod';
import { nonNegativeInt, positiveInt, upperName, utcTimestamp } from '../common.js';
import {
  activeAfkSum,
  bucketSchema,
  checkBoundedRange,
  checkPeriodKeys,
  playtimeTotalsSchema,
  timeRangeFields,
} from './common.js';

// Screen time. `from`/`to` must be given together, `[from, to)`, at most
// `MAX_RANGE_DAYS` (since 1.8.0). Without them the server uses the last 30
// local days (today and 29 days before). Responses echo the range used.

/** `…/screentime?from=&to=&bucket=` */
export const screentimeQuerySchema = z
  .strictObject({
    ...timeRangeFields,
    bucket: bucketSchema.default('day'),
  })
  .superRefine(checkBoundedRange);

/** `…/screentime/worlds?from=&to=` and `…/screentime/heatmap?from=&to=` */
export const screentimeRangeQuerySchema = z
  .strictObject(timeRangeFields)
  .superRefine(checkBoundedRange);

export const screentimeBucketSchema = z.strictObject({
  /** Bucket key in local time: `2026-11-09`, `2026-W45` or `2026-11`. */
  period: z.string(),
  start: utcTimestamp,
  activeSeconds: nonNegativeInt,
  afkSeconds: nonNegativeInt,
});

export const screentimeStatsSchema = z.strictObject({
  sessionCount: nonNegativeInt,
  averagePerDaySeconds: nonNegativeInt,
  averageSessionSeconds: nonNegativeInt,
  longestSessionSeconds: nonNegativeInt,
  /** AFK time / played time, 0–1. */
  afkShare: z.number().min(0).max(1),
});

/**
 * `buckets` has every period that overlaps `[from, to)`, also empty ones
 * (since 1.8.0), and adds up to `totals`.
 */
export const screentimeResponseSchema = z
  .strictObject({
    from: utcTimestamp,
    to: utcTimestamp,
    bucket: bucketSchema,
    buckets: z.array(screentimeBucketSchema),
    totals: playtimeTotalsSchema,
    /**
     * Same-length period just before `from` (the same number of local days
     * when `from` and `to` are local midnights). `null` if there's no data.
     */
    previous: playtimeTotalsSchema.nullable(),
    stats: screentimeStatsSchema,
  })
  .superRefine((response, ctx) => {
    checkBoundedRange(response, ctx);
    checkPeriodKeys(response.bucket, response.buckets, 'buckets', ctx);
    for (const key of ['activeSeconds', 'afkSeconds'] as const) {
      const sum = response.buckets.reduce((total, bucket) => total + bucket[key], 0);
      if (sum !== response.totals[key]) {
        ctx.addIssue({
          code: 'custom',
          message: `buckets must add up to totals.${key}`,
          path: ['totals', key],
        });
      }
    }
  });

export const worldTimeSchema = z
  .strictObject({
    world: positiveInt,
    seconds: nonNegativeInt,
    activeSeconds: nonNegativeInt,
    afkSeconds: nonNegativeInt,
    /** Latest seen `worldTypes`. Empty for a plain F2P world. */
    worldTypes: z.array(upperName),
    /** `null` if the world list was never loaded. */
    location: upperName.nullable(),
    activity: z.string().nullable(),
  })
  .refine(...activeAfkSum('seconds'));

export const screentimeWorldsResponseSchema = z
  .strictObject({
    from: utcTimestamp,
    to: utcTimestamp,
    worlds: z.array(worldTimeSchema),
    /**
     * Time per world type. A world can have several types, so these can add
     * up to more than the total. Plain F2P worlds have no type.
     */
    worldTypes: z.array(z.strictObject({ type: upperName, seconds: nonNegativeInt })),
    /** `location: null` collects time where the location is unknown. */
    locations: z.array(z.strictObject({ location: upperName.nullable(), seconds: nonNegativeInt })),
  })
  .superRefine(checkBoundedRange);

export const heatmapCellSchema = z.strictObject({
  /** ISO weekday: 1 = Monday, 7 = Sunday (local time). */
  weekday: z.int().min(1).max(7),
  /** Hour of day, 0–23 (local time). */
  hour: z.int().min(0).max(23),
  seconds: nonNegativeInt,
});

/** Only cells with play time are listed. */
export const screentimeHeatmapResponseSchema = z
  .strictObject({
    from: utcTimestamp,
    to: utcTimestamp,
    cells: z.array(heatmapCellSchema),
  })
  .superRefine((response, ctx) => {
    checkBoundedRange(response, ctx);
    const seen = new Set<number>();
    response.cells.forEach((cell, index) => {
      const key = cell.weekday * 100 + cell.hour;
      if (seen.has(key)) {
        ctx.addIssue({ code: 'custom', message: 'Duplicate cell', path: ['cells', index] });
      }
      seen.add(key);
    });
  });

export type ScreentimeQuery = z.infer<typeof screentimeQuerySchema>;
export type ScreentimeRangeQuery = z.infer<typeof screentimeRangeQuerySchema>;
export type ScreentimeBucket = z.infer<typeof screentimeBucketSchema>;
export type ScreentimeStats = z.infer<typeof screentimeStatsSchema>;
export type ScreentimeResponse = z.infer<typeof screentimeResponseSchema>;
export type WorldTime = z.infer<typeof worldTimeSchema>;
export type ScreentimeWorldsResponse = z.infer<typeof screentimeWorldsResponseSchema>;
export type HeatmapCell = z.infer<typeof heatmapCellSchema>;
export type ScreentimeHeatmapResponse = z.infer<typeof screentimeHeatmapResponseSchema>;
