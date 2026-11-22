import { z } from 'zod';
import { comparePets } from '../../game/pets.js';
import { DIARY_TIERS, MAX_QUEST_POINTS, QUEST_KINDS } from '../../game/quests.js';
import { nonNegativeInt, positiveInt, skillName, upperName, utcTimestamp } from '../common.js';
import {
  accountId,
  activeAfkSum,
  isOrdered,
  isoWeekSchema,
  localDateSchema,
  playtimeFields,
} from './common.js';
import { dropSchema } from './loot.js';
import { petSchema } from './pets.js';

// `GET /api/v1/accounts/:accountId/weekly?week=`. Pets, bank, collection log and quests were added
// in 1.28.0. Goals add a section in a new contract version.

type Issues = z.core.ParsePayload['issues'];

function issue(issues: Issues, input: unknown, path: PropertyKey[], message: string) {
  issues.push({ code: 'custom', message, input, path });
}

/** Without `week`: the current week. */
export const weeklyQuerySchema = z.strictObject({
  week: isoWeekSchema.optional(),
});

export const weeklyPlaytimeSchema = z
  .strictObject({
    ...playtimeFields,
    previousWeekPlayedSeconds: nonNegativeInt,
    mostPlayedWorld: positiveInt.nullable(),
  })
  .refine(...activeAfkSum('playedSeconds'));

export const weeklyXpSchema = z.strictObject({
  xpGained: nonNegativeInt,
  levelsGained: nonNegativeInt,
  topSkills: z.array(z.strictObject({ skill: skillName, xpGained: nonNegativeInt })).max(3),
});

export const weeklyLootSchema = z.strictObject({
  geValue: nonNegativeInt,
  topDrops: z.array(dropSchema).max(5),
});

export const weeklyKcSchema = z.strictObject({
  bosses: z.array(z.strictObject({ boss: z.string().min(1), gained: positiveInt })).min(1),
});

// --- Sections since 1.28.0 ----------------------------------------------------

/** Pets with `obtainedAt` in the week, newest first. Approximate times count. */
export const weeklyPetsSchema = z.strictObject({
  pets: z
    .array(petSchema)
    .min(1)
    .check(({ value: pets, issues }) => {
      pets.forEach((pet, index) => {
        if (pet.obtainedAt === null) {
          issue(issues, pet, [index, 'obtainedAt'], 'A pet of the week has obtainedAt');
        }
        const previous = pets[index - 1];
        if (previous && comparePets(previous, pet) > 0) {
          issue(issues, pet, [index], 'Pets must be newest first');
        }
      });
    }),
});

/** Net worth (bank + potion storage + inventory + equipment) of one local day. */
export const weeklyBankDaySchema = z.strictObject({
  date: localDateSchema,
  geValue: nonNegativeInt,
});

/**
 * Net worth through the week, at the prices of each snapshot (as
 * `bank/history`). `null` until an account in scope has a snapshot before the
 * week's end.
 */
export const weeklyBankSchema = z
  .strictObject({
    /**
     * Net worth before the week. `null` when an account that counts in
     * `endGeValue` had no snapshot before the week, so there is no change to show.
     */
    startGeValue: nonNegativeInt.nullable(),
    /** Net worth at the week's end, or now for the current week: the last day's value. */
    endGeValue: nonNegativeInt,
    /** Local days of the week with a value, oldest first. Values are carried forward. */
    days: z.array(weeklyBankDaySchema).min(1).max(7),
  })
  .check(({ value: bank, issues }) => {
    bank.days.forEach((day, index) => {
      const previous = bank.days[index - 1];
      if (previous && previous.date >= day.date) {
        issue(issues, day, ['days', index, 'date'], 'Days must be oldest first, each once');
      }
    });
    const last = bank.days[bank.days.length - 1];
    if (last && last.geValue !== bank.endGeValue) {
      issue(issues, bank.endGeValue, ['endGeValue'], 'endGeValue must be the last day');
    }
  });

/** Longest list of new collection log items in the weekly summary. */
export const WEEKLY_CLOG_ITEMS = 5;

export const weeklyClogItemSchema = z.strictObject({
  accountId,
  itemId: positiveInt,
  name: z.string().min(1),
  /** The first page in the game's order that has the item. */
  page: z.string().min(1),
  firstSeenAt: utcTimestamp,
  /** `true` when `firstSeenAt` is the time of the sync that first saw the item. */
  approximate: z.boolean(),
});

/** Collection log items first seen in the week. `null` without any. */
export const weeklyCollectionLogSchema = z
  .strictObject({
    /** Unique items (per account) first seen in the week. */
    newItems: positiveInt,
    /**
     * Unique items obtained and in total at the week's end, summed over the
     * accounts in scope. Both `null` when no collection log was stored by then.
     */
    obtained: nonNegativeInt.nullable(),
    total: nonNegativeInt.nullable(),
    /** The newest of the new items, newest first. */
    recentItems: z.array(weeklyClogItemSchema).min(1).max(WEEKLY_CLOG_ITEMS),
  })
  .check(({ value: clog, issues }) => {
    if ((clog.obtained === null) !== (clog.total === null)) {
      issue(issues, clog.total, ['total'], 'obtained and total are set together');
    }
    if (clog.obtained !== null && clog.total !== null && clog.obtained > clog.total) {
      issue(issues, clog.obtained, ['obtained'], 'obtained cannot be more than total');
    }
    if (clog.recentItems.length > clog.newItems) {
      issue(issues, clog.newItems, ['newItems'], 'newItems counts every item in recentItems');
    }
    clog.recentItems.forEach((item, index) => {
      const previous = clog.recentItems[index - 1];
      if (previous && previous.firstSeenAt < item.firstSeenAt) {
        issue(issues, item, ['recentItems', index], 'Items must be newest first');
      }
    });
  });

export const weeklyQuestSchema = z.strictObject({
  accountId,
  quest: upperName,
  name: z.string().min(1),
  kind: z.enum(QUEST_KINDS),
  /** When the quest was first seen as finished. */
  finishedAt: utcTimestamp,
});

export const weeklyDiaryTierSchema = z.strictObject({
  accountId,
  region: upperName,
  /** The region's name in the game, else made from the key. */
  name: z.string().min(1),
  tier: z.enum(DIARY_TIERS),
  /** When the tier was first seen as completed. */
  completedAt: utcTimestamp,
});

/**
 * Quests (and miniquests) and diary tiers first seen as finished in the
 * week, newest first, and the quest points gained. `null` without any.
 */
export const weeklyQuestsSchema = z
  .strictObject({
    questPointsGained: nonNegativeInt.max(MAX_QUEST_POINTS),
    quests: z.array(weeklyQuestSchema),
    diaries: z.array(weeklyDiaryTierSchema),
  })
  .check(({ value: section, issues }) => {
    if (
      section.quests.length === 0 &&
      section.diaries.length === 0 &&
      section.questPointsGained === 0
    ) {
      issue(issues, section, [], 'A section without content must be null');
    }
    section.quests.forEach((quest, index) => {
      const previous = section.quests[index - 1];
      if (previous && previous.finishedAt < quest.finishedAt) {
        issue(issues, quest, ['quests', index], 'Quests must be newest first');
      }
    });
    section.diaries.forEach((tier, index) => {
      const previous = section.diaries[index - 1];
      if (previous && previous.completedAt < tier.completedAt) {
        issue(issues, tier, ['diaries', index], 'Diary tiers must be newest first');
      }
    });
  });

export const weeklyResponseSchema = z
  .strictObject({
    week: isoWeekSchema,
    /** Monday 00:00 local time, in UTC. */
    start: utcTimestamp,
    /** Next Monday 00:00 local time, in UTC (exclusive). */
    end: utcTimestamp,
    /** `false` for the current week (computed on the fly). */
    complete: z.boolean(),
    computedAt: utcTimestamp,
    playtime: weeklyPlaytimeSchema.nullable(),
    xp: weeklyXpSchema.nullable(),
    loot: weeklyLootSchema.nullable(),
    kc: weeklyKcSchema.nullable(),
    pets: weeklyPetsSchema.nullable(),
    bank: weeklyBankSchema.nullable(),
    collectionLog: weeklyCollectionLogSchema.nullable(),
    quests: weeklyQuestsSchema.nullable(),
  })
  .refine((weekly) => isOrdered(weekly.start, weekly.end), {
    message: 'end must be after start',
    path: ['end'],
  });

export type WeeklyQuery = z.infer<typeof weeklyQuerySchema>;
export type WeeklyPlaytime = z.infer<typeof weeklyPlaytimeSchema>;
export type WeeklyXp = z.infer<typeof weeklyXpSchema>;
export type WeeklyLoot = z.infer<typeof weeklyLootSchema>;
export type WeeklyKc = z.infer<typeof weeklyKcSchema>;
export type WeeklyPets = z.infer<typeof weeklyPetsSchema>;
export type WeeklyBank = z.infer<typeof weeklyBankSchema>;
export type WeeklyBankDay = z.infer<typeof weeklyBankDaySchema>;
export type WeeklyClogItem = z.infer<typeof weeklyClogItemSchema>;
export type WeeklyCollectionLog = z.infer<typeof weeklyCollectionLogSchema>;
export type WeeklyQuest = z.infer<typeof weeklyQuestSchema>;
export type WeeklyDiaryTier = z.infer<typeof weeklyDiaryTierSchema>;
export type WeeklyQuests = z.infer<typeof weeklyQuestsSchema>;
export type WeeklyResponse = z.infer<typeof weeklyResponseSchema>;
