import { z } from 'zod';
import { nonNegativeInt, positiveInt, skillName, utcTimestamp, uuidV7 } from '../common.js';
import {
  accountId,
  intFromString,
  MAX_PAGE_LIMIT,
  nonNegativeIntQuery,
  paginated,
} from './common.js';
import { dropSchema } from './loot.js';
import { petSchema } from './pets.js';
import { sessionSchema } from './sessions.js';

// `GET /api/v1/accounts/:accountId/feed` (since 1.39.0): what happened lately,
// newest first, for "Latest" on Home. Computed on read from the derived tables.

type Issues = z.core.ParsePayload['issues'];

function issue(issues: Issues, input: unknown, path: PropertyKey[], message: string) {
  issues.push({ code: 'custom', message, input, path });
}

/**
 * Entry types, in the order they sort at the same `at` (a session above the
 * level-ups at its end, and so on).
 */
export const FEED_TYPES = ['session', 'level', 'clog', 'pet', 'drop'] as const;
export type FeedType = (typeof FEED_TYPES)[number];

/** Rank of a type at the same `at`: lower comes first. */
export function feedTypeRank(type: FeedType): number {
  return FEED_TYPES.indexOf(type);
}

/** Default lowest value of a drop item in the feed, as Valuable drops' default filter. */
export const FEED_DEFAULT_MIN_VALUE = 1_000_000;
export const FEED_DEFAULT_LIMIT = 20;

const feedTypes = z
  .string()
  .min(1)
  .transform((value, ctx) => {
    const parts = value.split(',');
    const types = new Set<FeedType>();
    for (const part of parts) {
      if (!(FEED_TYPES as readonly string[]).includes(part)) {
        ctx.addIssue({
          code: 'custom',
          message: `types must be a comma list of ${FEED_TYPES.join(', ')}`,
        });
        return z.NEVER;
      }
      types.add(part as FeedType);
    }
    return FEED_TYPES.filter((type) => types.has(type));
  });

/**
 * `…/feed?types=&minValue=&cursor=&limit=`. `types` is a comma list (default:
 * every type), `minValue` the lowest `geValue` of a drop item (default 1M).
 */
export const feedQuerySchema = z.strictObject({
  types: feedTypes.default([...FEED_TYPES]),
  minValue: nonNegativeIntQuery.default(FEED_DEFAULT_MIN_VALUE),
  cursor: z.string().min(1).optional(),
  limit: intFromString(z.int().min(1).max(MAX_PAGE_LIMIT)).default(FEED_DEFAULT_LIMIT),
});

const entryFields = {
  /** Stable across `rebuild`: built from IDs in the raw data, unique in the feed. */
  id: z.string().min(1),
  at: utcTimestamp,
  accountId,
};

/**
 * A session. `at` is `endedAt`, or the last heartbeat while it is open, so a
 * session sits above what happened in it.
 */
export const feedSessionEntrySchema = z
  .strictObject({ type: z.literal('session'), ...entryFields, session: sessionSchema })
  .check(({ value: entry, issues }) => {
    if (entry.session.accountId !== entry.accountId) {
      issue(issues, entry.accountId, ['accountId'], 'accountId must be the session’s');
    }
    if (entry.session.endedAt !== null && entry.at !== entry.session.endedAt) {
      issue(issues, entry.at, ['at'], 'at must be endedAt for a closed session');
    }
  });

/** A drop item worth at least `minValue`. */
export const feedDropEntrySchema = z
  .strictObject({
    type: z.literal('drop'),
    ...entryFields,
    drop: dropSchema,
    /**
     * The item is a new collection log item tied to the drop's session. Only
     * when the feed has no `clog` entries: otherwise the clog entry stands for
     * both, and this drop is left out.
     */
    newCollectionLog: z.boolean(),
  })
  .check(({ value: entry, issues }) => {
    if (entry.at !== entry.drop.occurredAt) {
      issue(issues, entry.at, ['at'], 'at must be the drop’s occurredAt');
    }
    if (entry.drop.accountId !== entry.accountId) {
      issue(issues, entry.accountId, ['accountId'], 'accountId must be the drop’s');
    }
  });

/** A new collection log item (pets are `pet` entries). */
export const feedClogEntrySchema = z
  .strictObject({
    type: z.literal('clog'),
    ...entryFields,
    itemId: positiveInt,
    name: z.string().min(1),
    /** The tab and first page in the game's order that have the item. */
    tab: z.string().min(1),
    page: z.string().min(1),
    /** `true` when `at` is the time of the sync that first saw the item. */
    approximate: z.boolean(),
    /** The session the item is tied to, `null` when none (the rule is in server/src/read/session-clog.ts). */
    sessionId: uuidV7.nullable(),
    /** Unique items the account had with this one, and in total in its latest log. */
    obtainedAfter: positiveInt,
    total: positiveInt,
    /** The item's first own drop in the tied session, when there is one. */
    drop: z.strictObject({ lootEventId: positiveInt, geValue: nonNegativeInt }).nullable(),
  })
  .check(({ value: entry, issues }) => {
    if (entry.obtainedAfter > entry.total) {
      issue(issues, entry.obtainedAfter, ['obtainedAfter'], 'obtainedAfter must not exceed total');
    }
    if (entry.drop !== null && entry.sessionId === null) {
      issue(issues, entry.drop, ['drop'], 'Only an item tied to a session has a drop');
    }
  });

/** A skill that gained levels in a closed session. `at` is the session's end. */
export const feedLevelEntrySchema = z
  .strictObject({
    type: z.literal('level'),
    ...entryFields,
    sessionId: uuidV7,
    skill: skillName,
    fromLevel: positiveInt,
    toLevel: positiveInt,
  })
  .check(({ value: entry, issues }) => {
    if (entry.toLevel <= entry.fromLevel) {
      issue(issues, entry.toLevel, ['toLevel'], 'toLevel must be above fromLevel');
    }
  });

/** A pet with a known time. */
export const feedPetEntrySchema = z
  .strictObject({ type: z.literal('pet'), ...entryFields, pet: petSchema })
  .check(({ value: entry, issues }) => {
    if (entry.pet.obtainedAt !== entry.at) {
      issue(issues, entry.at, ['at'], 'at must be the pet’s obtainedAt');
    }
    if (entry.pet.accountId !== entry.accountId) {
      issue(issues, entry.accountId, ['accountId'], 'accountId must be the pet’s');
    }
  });

export const feedEntrySchema = z.discriminatedUnion('type', [
  feedSessionEntrySchema,
  feedLevelEntrySchema,
  feedClogEntrySchema,
  feedPetEntrySchema,
  feedDropEntrySchema,
]);

/** Order of the feed: `at` descending, then type rank, then `id` descending. */
export function compareFeedEntries(
  a: { at: string; type: FeedType; id: string },
  b: { at: string; type: FeedType; id: string },
): number {
  if (a.at !== b.at) return a.at > b.at ? -1 : 1;
  const rank = feedTypeRank(a.type) - feedTypeRank(b.type);
  if (rank !== 0) return rank;
  return a.id === b.id ? 0 : a.id > b.id ? -1 : 1;
}

export const feedResponseSchema = paginated(feedEntrySchema).check(({ value: page, issues }) => {
  const seen = new Set<string>();
  page.items.forEach((entry, index) => {
    if (seen.has(entry.id)) issue(issues, entry.id, ['items', index, 'id'], 'Each id once');
    seen.add(entry.id);
    const previous = page.items[index - 1];
    if (previous && compareFeedEntries(previous, entry) >= 0) {
      issue(issues, entry, ['items', index], 'Entries must be newest first (at, type, id)');
    }
  });
});

export type FeedQuery = z.infer<typeof feedQuerySchema>;
export type FeedSessionEntry = z.infer<typeof feedSessionEntrySchema>;
export type FeedDropEntry = z.infer<typeof feedDropEntrySchema>;
export type FeedClogEntry = z.infer<typeof feedClogEntrySchema>;
export type FeedLevelEntry = z.infer<typeof feedLevelEntrySchema>;
export type FeedPetEntry = z.infer<typeof feedPetEntrySchema>;
export type FeedEntry = z.infer<typeof feedEntrySchema>;
export type FeedResponse = z.infer<typeof feedResponseSchema>;
