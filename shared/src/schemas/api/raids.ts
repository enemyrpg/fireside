import { z } from 'zod';
import { RAIDS } from '../../game/raids.js';
import { nonNegativeInt, positiveInt, utcTimestamp, uuidV7 } from '../common.js';
import { RAID_LOOT_RECIPIENTS } from '../events.js';
import { accountId, paginated, paginationQueryFields } from './common.js';

// `GET /api/v1/accounts/:accountId/raids` (since 1.12.0): loot value per raid
// and the special loot (purples) list for the Raids tab. All time. Each own
// purple is counted once: in `specialLootGeValue`, never in `lootGeValue`.

/** `…/raids?cursor=&limit=`. The cursor pages `specialLoot`. */
export const raidsQuerySchema = z.strictObject(paginationQueryFields);

/** One raid in `RAIDS` (all its modes together). */
export const raidSummarySchema = z.strictObject({
  /** Raid name from `RAIDS` (e.g. "Chambers of Xeric"). */
  raid: z.string().min(1),
  /** Loot events (chests) from the raid's modes. */
  lootCount: nonNegativeInt,
  /** GE value of the raid's loot without own purples. */
  lootGeValue: nonNegativeInt,
  /** GE value of own purples (`SELF`). Teammates' purples never count. */
  specialLootGeValue: nonNegativeInt,
});

/** One purple, yours or a teammate's. Never a player name. */
export const specialLootItemSchema = z
  .strictObject({
    occurredAt: utcTimestamp,
    accountId,
    sessionId: uuidV7,
    /** Normalized raid mode (e.g. "Tombs of Amascut: Expert Mode"). */
    raid: z.string().min(1),
    /** The raid in `RAIDS` the mode belongs to, else the same as `raid`. */
    raidGroup: z.string().min(1),
    itemId: nonNegativeInt,
    name: z.string().min(1),
    quantity: positiveInt,
    gePriceEach: nonNegativeInt,
    /** `quantity * gePriceEach`, capped at 2^53 − 1 like the sums. */
    geValue: nonNegativeInt,
    recipient: z.enum(RAID_LOOT_RECIPIENTS),
    /** Players in the raid, yourself included. `null` if unknown. */
    teamSize: z.int().min(1).max(100).nullable(),
    killCount: positiveInt.nullable(),
  })
  .refine(
    (item) => item.geValue === Math.min(item.quantity * item.gePriceEach, Number.MAX_SAFE_INTEGER),
    {
      message: 'geValue must equal quantity * gePriceEach, capped at 2^53 - 1',
      path: ['geValue'],
    },
  );

export const raidsResponseSchema = z
  .strictObject({
    /** One entry per raid in `RAIDS`, in that order. */
    raids: z.array(raidSummarySchema),
    /** Purples newest first. */
    specialLoot: paginated(specialLootItemSchema),
  })
  .refine(
    (response) =>
      response.raids.length === RAIDS.length &&
      response.raids.every((summary, index) => summary.raid === RAIDS[index]?.name),
    { message: 'raids must list every raid in RAIDS, in order', path: ['raids'] },
  );

export type RaidsQuery = z.infer<typeof raidsQuerySchema>;
export type RaidSummary = z.infer<typeof raidSummarySchema>;
export type SpecialLootItem = z.infer<typeof specialLootItemSchema>;
export type RaidsResponse = z.infer<typeof raidsResponseSchema>;
