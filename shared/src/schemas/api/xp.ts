import { z } from 'zod';
import { nonNegativeInt, positiveInt, skillName, utcTimestamp } from '../common.js';
import { GAINS_PERIODS } from '../../periods.js';
import { bucketSchema, checkPeriodKeys, refineTimeRange, timeRangeFields } from './common.js';

// `GET /api/v1/accounts/:accountId/xp` and `/gains`.

/** `…/xp?skill=&from=&to=&bucket=`. Without `skill`, the series is overall (total XP and level). */
export const xpQuerySchema = refineTimeRange(
  z.strictObject({
    skill: skillName.optional(),
    ...timeRangeFields,
    bucket: bucketSchema.default('day'),
  }),
);

export const xpPointSchema = z.strictObject({
  /** Bucket key in local time: `2026-11-09`, `2026-W45` or `2026-11`. */
  period: z.string(),
  /** Bucket start in UTC. */
  start: utcTimestamp,
  /** XP at the end of the bucket. */
  xp: nonNegativeInt,
  /** Level (or total level) at the end of the bucket. */
  level: positiveInt,
  /** XP gained in the bucket. */
  gained: nonNegativeInt,
});

export const xpResponseSchema = z
  .strictObject({
    /** `null` for the overall series. */
    skill: skillName.nullable(),
    bucket: bucketSchema,
    points: z.array(xpPointSchema),
  })
  .superRefine((response, ctx) => {
    checkPeriodKeys(response.bucket, response.points, 'points', ctx);
  });

export { GAINS_PERIODS, type GainsPeriod } from '../../periods.js';

/** `…/gains?period=&from=&to=`. `from`/`to` override the period preset. */
export const gainsQuerySchema = refineTimeRange(
  z.strictObject({
    period: z.enum(GAINS_PERIODS).default('week'),
    ...timeRangeFields,
  }),
);

/** Gains = last snapshot in the period minus last snapshot before it. */
export const skillGainSchema = z
  .strictObject({
    skill: skillName,
    startXp: nonNegativeInt,
    endXp: nonNegativeInt,
    xpGained: nonNegativeInt,
    startLevel: positiveInt,
    endLevel: positiveInt,
    levelsGained: nonNegativeInt,
  })
  .refine((gain) => gain.xpGained === gain.endXp - gain.startXp, {
    message: 'xpGained must equal endXp - startXp',
    path: ['xpGained'],
  })
  .refine((gain) => gain.levelsGained === gain.endLevel - gain.startLevel, {
    message: 'levelsGained must equal endLevel - startLevel',
    path: ['levelsGained'],
  });

export const gainsResponseSchema = refineTimeRange(
  z.strictObject({
    /** Resolved period in UTC. */
    from: utcTimestamp,
    to: utcTimestamp,
    total: z.strictObject({ xpGained: nonNegativeInt, levelsGained: nonNegativeInt }),
    skills: z.array(skillGainSchema),
  }),
);

export type XpQuery = z.infer<typeof xpQuerySchema>;
export type XpPoint = z.infer<typeof xpPointSchema>;
export type XpResponse = z.infer<typeof xpResponseSchema>;
export type GainsQuery = z.infer<typeof gainsQuerySchema>;
export type SkillGain = z.infer<typeof skillGainSchema>;
export type GainsResponse = z.infer<typeof gainsResponseSchema>;
