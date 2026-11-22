import { z } from 'zod';
import {
  compareByName,
  DIARY_TIERS,
  MAX_QUEST_POINTS,
  QUEST_KINDS,
  QUEST_STATES,
} from '../../game/quests.js';
import { nonNegativeInt, upperName, utcTimestamp } from '../common.js';
import { accountId } from './common.js';

// Quest and diary status (since 1.21.0). Both endpoints are per account: states
// cannot be summed across accounts, so `all` is not accepted.
//
// `finishedAt` / `completedAt` is when the entry was first seen as finished.
// It is `null` for entries that were already finished in the account's first
// snapshot (finished before tracking started).

type Issues = z.core.ParsePayload['issues'];

function issue(issues: Issues, input: unknown, path: PropertyKey[], message: string) {
  issues.push({ code: 'custom', message, input, path });
}

/** `…/quests` and `…/diaries` take no query parameters. */
export const questsQuerySchema = z.strictObject({});

// --- Quests -----------------------------------------------------------------

export const questResponseSchema = z
  .strictObject({
    /** RuneLite `Quest` enum name, or an unknown quest's key as sent. */
    quest: upperName,
    name: z.string().min(1),
    /** `QUEST` when the plugin sent no kind. */
    kind: z.enum(QUEST_KINDS),
    state: z.enum(QUEST_STATES),
    finishedAt: utcTimestamp.nullable(),
  })
  .refine((quest) => quest.finishedAt === null || quest.state === 'FINISHED', {
    message: 'Only a finished quest has finishedAt',
    path: ['finishedAt'],
  });

/** Counts of one kind. `total` = `finished` + `inProgress` + `notStarted`. */
export const questTotalsSchema = z.strictObject({
  total: nonNegativeInt,
  finished: nonNegativeInt,
  inProgress: nonNegativeInt,
  notStarted: nonNegativeInt,
});

/** Counts of the entries of `kind`, as `questTotalsSchema`. */
export function questTotalsOf(
  quests: readonly { kind: string; state: string }[],
  kind: (typeof QUEST_KINDS)[number],
): z.infer<typeof questTotalsSchema> {
  const ofKind = quests.filter((quest) => quest.kind === kind);
  const count = (state: (typeof QUEST_STATES)[number]) =>
    ofKind.filter((quest) => quest.state === state).length;
  return {
    total: ofKind.length,
    finished: count('FINISHED'),
    inProgress: count('IN_PROGRESS'),
    notStarted: count('NOT_STARTED'),
  };
}

const TOTAL_KEYS = ['total', 'finished', 'inProgress', 'notStarted'] as const;

/**
 * `GET /accounts/:accountId/quests`: the account's latest `quests.snapshot`.
 * Quests and miniquests in one list, sorted by name (then key). Without a
 * snapshot: `updatedAt: null`, zeros and an empty list.
 */
export const questsResponseSchema = z
  .strictObject({
    accountId,
    /** When the latest snapshot was taken. `null` until the first one. */
    updatedAt: utcTimestamp.nullable(),
    questPoints: nonNegativeInt.max(MAX_QUEST_POINTS),
    /** Quests only (`kind: QUEST`). */
    totals: questTotalsSchema,
    /** Miniquests only. They give no quest points. */
    miniquestTotals: questTotalsSchema,
    quests: z.array(questResponseSchema),
  })
  .check((ctx) => {
    const { updatedAt, questPoints, quests, totals, miniquestTotals } = ctx.value;
    const issues = ctx.issues;
    quests.forEach((quest, index) => {
      const previous = quests[index - 1];
      if (
        previous &&
        compareByName(
          { name: previous.name, key: previous.quest },
          { name: quest.name, key: quest.quest },
        ) >= 0
      ) {
        issue(
          issues,
          quest,
          ['quests', index],
          'Must be sorted by name, then quest, no duplicates',
        );
      }
    });
    const seen = new Set<string>();
    quests.forEach((quest, index) => {
      if (seen.has(quest.quest)) {
        issue(issues, quest, ['quests', index, 'quest'], 'Each quest may appear only once');
      }
      seen.add(quest.quest);
    });
    for (const [key, kind, value] of [
      ['totals', 'QUEST', totals],
      ['miniquestTotals', 'MINIQUEST', miniquestTotals],
    ] as const) {
      const expected = questTotalsOf(quests, kind);
      for (const field of TOTAL_KEYS) {
        if (value[field] !== expected[field]) {
          issue(issues, value, [key, field], `${field} must be the count in quests`);
        }
      }
    }
    if (updatedAt === null && (quests.length > 0 || questPoints !== 0)) {
      issue(issues, updatedAt, ['updatedAt'], 'Without a snapshot there are no quests or points');
    }
  });

// --- Diaries ----------------------------------------------------------------

export const diaryTierResponseSchema = z
  .strictObject({
    tier: z.enum(DIARY_TIERS),
    completed: z.boolean(),
    completedAt: utcTimestamp.nullable(),
  })
  .refine((tier) => tier.completedAt === null || tier.completed, {
    message: 'Only a completed tier has completedAt',
    path: ['completedAt'],
  });

/** One region with the tiers of the snapshot, easiest first. */
export const diaryRegionResponseSchema = z
  .strictObject({
    /** Region key, e.g. `ARDOUGNE`, or an unknown region's key as sent. */
    region: upperName,
    /** Name in the game for known regions, else made from the key. */
    name: z.string().min(1),
    /** Completed tiers in the region. */
    completed: nonNegativeInt,
    tiers: z.array(diaryTierResponseSchema).min(1),
  })
  .check((ctx) => {
    const { tiers, completed } = ctx.value;
    tiers.forEach((tier, index) => {
      const previous = tiers[index - 1];
      if (previous && DIARY_TIERS.indexOf(previous.tier) >= DIARY_TIERS.indexOf(tier.tier)) {
        issue(ctx.issues, tier, ['tiers', index, 'tier'], 'Tiers must be easiest first, each once');
      }
    });
    if (completed !== tiers.filter((tier) => tier.completed).length) {
      issue(ctx.issues, completed, ['completed'], 'completed must be the count in tiers');
    }
  });

export const diaryTotalsSchema = z.strictObject({
  /** Tiers in the snapshot (48 with today's game). */
  tiers: nonNegativeInt,
  completed: nonNegativeInt,
  /** Regions where all four tiers are completed. */
  regionsCompleted: nonNegativeInt,
});

/**
 * `GET /accounts/:accountId/diaries`: the account's latest `diaries.snapshot`,
 * regions sorted by name (then key). Without a snapshot: `updatedAt: null`,
 * zeros and an empty list.
 */
export const diariesResponseSchema = z
  .strictObject({
    accountId,
    /** When the latest snapshot was taken. `null` until the first one. */
    updatedAt: utcTimestamp.nullable(),
    totals: diaryTotalsSchema,
    regions: z.array(diaryRegionResponseSchema),
  })
  .check((ctx) => {
    const { updatedAt, totals, regions } = ctx.value;
    const issues = ctx.issues;
    regions.forEach((region, index) => {
      const previous = regions[index - 1];
      if (
        previous &&
        compareByName(
          { name: previous.name, key: previous.region },
          { name: region.name, key: region.region },
        ) >= 0
      ) {
        issue(
          issues,
          region,
          ['regions', index],
          'Must be sorted by name, then region, no duplicates',
        );
      }
    });
    const seen = new Set<string>();
    regions.forEach((region, index) => {
      if (seen.has(region.region)) {
        issue(issues, region, ['regions', index, 'region'], 'Each region may appear only once');
      }
      seen.add(region.region);
    });
    const expected = {
      tiers: regions.reduce((sum, region) => sum + region.tiers.length, 0),
      completed: regions.reduce((sum, region) => sum + region.completed, 0),
      regionsCompleted: regions.filter((region) => region.completed === DIARY_TIERS.length).length,
    };
    for (const field of ['tiers', 'completed', 'regionsCompleted'] as const) {
      if (totals[field] !== expected[field]) {
        issue(issues, totals, ['totals', field], `${field} must match the regions`);
      }
    }
    if (updatedAt === null && regions.length > 0) {
      issue(issues, updatedAt, ['updatedAt'], 'Without a snapshot there are no regions');
    }
  });

export type QuestResponse = z.infer<typeof questResponseSchema>;
export type QuestTotals = z.infer<typeof questTotalsSchema>;
export type QuestsResponse = z.infer<typeof questsResponseSchema>;
export type DiaryTierResponse = z.infer<typeof diaryTierResponseSchema>;
export type DiaryRegionResponse = z.infer<typeof diaryRegionResponseSchema>;
export type DiaryTotals = z.infer<typeof diaryTotalsSchema>;
export type DiariesResponse = z.infer<typeof diariesResponseSchema>;
