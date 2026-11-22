import { z } from 'zod';
import { RAIDS } from '../../game/raids.js';
import { nonNegativeInt, positiveInt, utcTimestamp, uuidV7 } from '../common.js';
import { RAID_LOOT_RECIPIENTS, type RaidLootRecipient } from '../events.js';
import {
  accountId,
  accountIdParam,
  paginated,
  paginationQueryFields,
  yearMonthSchema,
} from './common.js';

// Raid loot split tracker (since 1.22.0, own manual drops since 1.23.0). The
// user's own choices about each purple: Split or FFA, what it sold for, the
// party size, a nickname and a note. They are entered in the dashboard and
// stored in their own tables, never in raw events, and are never sent by the
// plugin.
//
// All values and shares are before GE tax.

// --- Rules ------------------------------------------------------------------

export const SPLIT_MODES = ['SPLIT', 'FFA'] as const;
export const splitModeSchema = z.enum(SPLIT_MODES);
export type SplitMode = z.infer<typeof splitModeSchema>;

/** The mode of an account that has not chosen one. */
export const DEFAULT_SPLIT_MODE: SplitMode = 'SPLIT';

/** Longest nickname, in characters (code points), after trimming. */
export const MAX_DROP_NICKNAME_LENGTH = 30;
/** Longest note, in characters (code points), after trimming. */
export const MAX_DROP_NOTE_LENGTH = 200;

/**
 * The earliest time a manual drop can have: the day Old School RuneScape
 * launched. Nothing dropped before it, and it bounds the list of months.
 */
export const EARLIEST_MANUAL_DROP_AT = '2013-02-22T00:00:00.000Z';

/**
 * A manual drop is flagged when a detected purple with the same recipient
 * (yours, also one only seen in the chest, or a teammate's) is this close in time.
 */
export const POSSIBLE_DUPLICATE_WINDOW_MS = 2 * 60 * 60 * 1000;

const partySize = z.int().min(1).max(100);

export interface RaidDropShareInput {
  /** The user's own value if set, else the GE value. `null` if neither is known. */
  value: number | null;
  mode: SplitMode;
  recipient: RaidLootRecipient;
  /** The user's party size if set, else the one from the event. `null` if unknown. */
  partySize: number | null;
}

/**
 * Your share of one drop, in gp. Split: `value ÷ partySize` rounded down, for
 * your own and teammates' drops. FFA: the whole value of your own drops, 0
 * for teammates'. `null` when it can't be worked out (no value, or a split
 * without a party size); such a drop counts 0 in every sum.
 */
export function raidDropShare(drop: RaidDropShareInput): number | null {
  if (drop.mode === 'FFA' && drop.recipient === 'TEAMMATE') return 0;
  if (drop.value === null) return null;
  if (drop.mode === 'FFA') return drop.value;
  if (drop.partySize === null) return null;
  return Math.floor(drop.value / drop.partySize);
}

// --- Drops ------------------------------------------------------------------

/**
 * Identifies a drop: the `raid.special_loot` event ID, `<loot event ID>.<item
 * position>` for a purple only seen in the chest, or the ID of a manual drop.
 */
export const raidDropIdSchema = z
  .string()
  .regex(
    /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}(\.(0|[1-9]\d{0,5}))?$/,
    'Must be a drop ID',
  );

/**
 * Where a drop's GE price comes from. `DROP`: the price when it dropped, sent
 * by the plugin. A manual drop has no such price, so the server stores the
 * latest price of the same item in the user's own data when the drop is
 * added: `SPECIAL_LOOT` (another purple), `LOOT` (a loot item) or `BANK` (the
 * latest bank snapshot). It is never changed afterwards.
 */
export const GE_PRICE_SOURCES = ['DROP', 'SPECIAL_LOOT', 'LOOT', 'BANK'] as const;
export const gePriceSourceSchema = z.enum(GE_PRICE_SOURCES);
export type GePriceSource = z.infer<typeof gePriceSourceSchema>;

/** One purple with the user's choices and their share. Never a player name from the game. */
export const raidDropSchema = z
  .strictObject({
    dropId: raidDropIdSchema,
    /**
     * Added by hand in the dashboard: a purple the plugin didn't record, your
     * own (e.g. from before the plugin was installed) or a teammate's.
     */
    manual: z.boolean(),
    occurredAt: utcTimestamp,
    accountId,
    /** `null` for a manual drop. */
    sessionId: uuidV7.nullable(),
    /** Normalized raid mode (e.g. "Tombs of Amascut: Expert Mode"). */
    raid: z.string().min(1),
    /** The raid in `RAIDS` the mode belongs to, else the same as `raid`. */
    raidGroup: z.string().min(1),
    itemId: nonNegativeInt,
    name: z.string().min(1),
    quantity: positiveInt,
    /** `null` only for a manual drop whose item had no price in the user's data when it was added. */
    gePriceEach: nonNegativeInt.nullable(),
    /** `quantity * gePriceEach`, capped at 2^53 − 1. `null` without a price. */
    geValue: nonNegativeInt.nullable(),
    /** `null` without a price. */
    gePriceSource: gePriceSourceSchema.nullable(),
    /** When the price was seen. The drop's own time for `DROP`. `null` without a price. */
    gePriceAt: utcTimestamp.nullable(),
    /** What the user says the drop sold for, in gp (the whole drop). Replaces `geValue`. */
    ownValue: nonNegativeInt.nullable(),
    /** `ownValue` if set, else `geValue`. */
    value: nonNegativeInt.nullable(),
    /** No own value and no GE price: the drop counts 0 until `ownValue` is set. */
    valueUnknown: z.boolean(),
    recipient: z.enum(RAID_LOOT_RECIPIENTS),
    /** The mode in effect: the drop's override, else its account's default. */
    mode: splitModeSchema,
    /** Whether the mode is set on the drop itself. */
    overridden: z.boolean(),
    /** Players in the raid as sent by the plugin, yourself included. `null` if unknown. */
    teamSize: partySize.nullable(),
    /** The party size in effect: the user's if set, else `teamSize`. */
    partySize: partySize.nullable(),
    /** Whether the party size is set by the user. */
    partySizeOverridden: z.boolean(),
    /** A split without a party size: the drop counts 0 until one is set. */
    partySizeUnknown: z.boolean(),
    /** See `raidDropShare`. `null` counts 0 in the sums. */
    share: nonNegativeInt.nullable(),
    /** The user's own name for whoever got a teammate's drop. Never from the game. */
    nickname: z.string().min(1).nullable(),
    note: z.string().min(1).nullable(),
    killCount: positiveInt.nullable(),
    /**
     * A manual drop with a detected purple of the same item and recipient in
     * the same raid within `POSSIBLE_DUPLICATE_WINDOW_MS`. Only a hint:
     * nothing is merged or hidden.
     */
    possibleDuplicate: z.boolean(),
    /** The detected drop it may duplicate. `null` unless `possibleDuplicate`. */
    duplicateOfDropId: raidDropIdSchema.nullable(),
  })
  .superRefine((drop, ctx) => {
    const issue = (path: string, message: string) => {
      ctx.addIssue({ code: 'custom', message, path: [path] });
    };
    const geValue =
      drop.gePriceEach === null
        ? null
        : Math.min(drop.quantity * drop.gePriceEach, Number.MAX_SAFE_INTEGER);
    if (drop.geValue !== geValue) {
      issue('geValue', 'geValue must equal quantity * gePriceEach, capped at 2^53 - 1');
    }
    if ((drop.gePriceSource === null) !== (drop.gePriceEach === null)) {
      issue('gePriceSource', 'gePriceSource must be set exactly when there is a price');
    }
    if ((drop.gePriceAt === null) !== (drop.gePriceEach === null)) {
      issue('gePriceAt', 'gePriceAt must be set exactly when there is a price');
    }
    if ((drop.gePriceSource === 'DROP') === drop.manual && drop.gePriceSource !== null) {
      issue('gePriceSource', 'Only detected drops have the price from the drop');
    }
    if (!drop.manual && drop.gePriceEach === null) {
      issue('gePriceEach', 'A detected drop always has a price');
    }
    if (drop.value !== (drop.ownValue ?? drop.geValue)) {
      issue('value', 'value must be ownValue if set, else geValue');
    }
    if (drop.valueUnknown !== (drop.value === null)) {
      issue('valueUnknown', 'valueUnknown must be true exactly when value is null');
    }
    if (drop.manual && drop.sessionId !== null) {
      issue('manual', 'A manual drop has no session');
    }
    if (!drop.manual && drop.sessionId === null) {
      issue('sessionId', 'A detected drop has a session');
    }
    if (drop.manual && drop.teamSize !== null) {
      issue('teamSize', 'A manual drop has no party size from the plugin');
    }
    if (drop.partySizeOverridden ? drop.partySize === null : drop.partySize !== drop.teamSize) {
      issue('partySize', 'partySize must be the user’s size if set, else teamSize');
    }
    if (drop.partySizeUnknown !== (drop.mode === 'SPLIT' && drop.partySize === null)) {
      issue('partySizeUnknown', 'partySizeUnknown must be true for a split without a party size');
    }
    if (drop.share !== raidDropShare(drop)) {
      issue('share', 'share does not follow the split rules');
    }
    if (drop.nickname !== null && drop.recipient !== 'TEAMMATE') {
      issue('nickname', 'Only a teammate drop can have a nickname');
    }
    if (drop.possibleDuplicate !== (drop.duplicateOfDropId !== null)) {
      issue('duplicateOfDropId', 'duplicateOfDropId must be set exactly when possibleDuplicate');
    }
    if (drop.possibleDuplicate && !drop.manual) {
      issue('possibleDuplicate', 'Only a manual drop can be a possible duplicate');
    }
  });

// --- Overview ---------------------------------------------------------------

/** `…/raids/splits?cursor=&limit=`. The cursor pages `drops`. */
export const raidSplitsQuerySchema = z.strictObject(paginationQueryFields);

/** An account's default mode. */
export const raidSplitDefaultSchema = z.strictObject({
  accountId,
  mode: splitModeSchema,
});

const shareSumFields = {
  /** `fromOwnDrops + fromTeammateDrops`, capped at 2^53 − 1. */
  share: nonNegativeInt,
  /** Your share of drops you got (`SELF`). */
  fromOwnDrops: nonNegativeInt,
  /** Your share of teammates' drops (always 0 under FFA). */
  fromTeammateDrops: nonNegativeInt,
};

function sumsAgree(sums: { share: number; fromOwnDrops: number; fromTeammateDrops: number }) {
  return (
    sums.share === Math.min(sums.fromOwnDrops + sums.fromTeammateDrops, Number.MAX_SAFE_INTEGER)
  );
}
const sumsAgreeParams = {
  message: 'share must equal fromOwnDrops + fromTeammateDrops',
  path: ['share'],
};

export const raidShareTotalSchema = z
  .strictObject(shareSumFields)
  .refine(sumsAgree, sumsAgreeParams);

export const raidShareSchema = z
  .strictObject({
    /** Raid name from `RAIDS` (all its modes together). */
    raid: z.string().min(1),
    ...shareSumFields,
    /**
     * GE value of the own purples added by hand (since 1.23.0): each one's
     * `geValue`, or its `ownValue` when it has no GE price, else 0. Comes on
     * top of `specialLootGeValue` in `GET …/raids`, which only has purples
     * the plugin recorded. Teammates' purples never count.
     */
    manualSpecialLootValue: nonNegativeInt,
  })
  .refine(sumsAgree, sumsAgreeParams);

export const raidShareMonthSchema = z.strictObject({
  /** Local month (`TZ`), e.g. `2026-11`. */
  month: yearMonthSchema,
  share: nonNegativeInt,
});

/** `GET /api/v1/accounts/:accountId/raids/splits`. All time. */
export const raidSplitsResponseSchema = z
  .strictObject({
    /** The default mode of the account, or of every account for `all` (by account ID). */
    defaults: z.array(raidSplitDefaultSchema),
    /** Every drop in scope, also drops from a raid that is not in `RAIDS`. */
    total: raidShareTotalSchema,
    /** One entry per raid in `RAIDS`, in that order. */
    raids: z.array(raidShareSchema),
    /**
     * Every local month from the first drop to the current month, oldest
     * first, also months without drops. Empty without drops.
     */
    months: z.array(raidShareMonthSchema),
    /** Purples newest first, manual drops included. */
    drops: paginated(raidDropSchema),
  })
  .superRefine((response, ctx) => {
    if (
      response.raids.length !== RAIDS.length ||
      response.raids.some((summary, index) => summary.raid !== RAIDS[index]?.name)
    ) {
      ctx.addIssue({
        code: 'custom',
        message: 'raids must list every raid in RAIDS, in order',
        path: ['raids'],
      });
    }
    const monthSum = response.months.reduce((sum, month) => sum + month.share, 0);
    if (Math.min(monthSum, Number.MAX_SAFE_INTEGER) !== response.total.share) {
      ctx.addIssue({
        code: 'custom',
        message: 'months must add up to total.share',
        path: ['months'],
      });
    }
    if (
      response.months.some(
        (month, index) => month.month <= (response.months[index - 1]?.month ?? ''),
      )
    ) {
      ctx.addIssue({ code: 'custom', message: 'months must be oldest first', path: ['months'] });
    }
  });

// --- Changes ----------------------------------------------------------------

/** `PUT /api/v1/accounts/:accountId/raids/split-default` body. One account, never `all`. */
export const raidSplitDefaultRequestSchema = z.strictObject({ mode: splitModeSchema });

/** `PUT …/raids/split-default` → `200`. */
export const raidSplitDefaultResponseSchema = raidSplitDefaultSchema;

// Text rules (trimmed; nickname 1–30 and note 1–200 characters; no control or
// invisible characters) are checked by the server, like key names. Errors
// come back on `body.nickname` and `body.note`. An empty text clears the field.
const choiceText = z.string().max(1000);

/**
 * `PATCH /api/v1/accounts/:accountId/raids/drops/:dropId` body. A field that
 * is left out is unchanged; `null` clears it (the mode goes back to the
 * account default, the value to the GE value, the party size to the plugin's).
 */
export const raidDropUpdateRequestSchema = z.strictObject({
  mode: splitModeSchema.nullable().optional(),
  ownValue: nonNegativeInt.nullable().optional(),
  partySize: partySize.nullable().optional(),
  /** Only for a teammate's drop. */
  nickname: choiceText.nullable().optional(),
  note: choiceText.nullable().optional(),
});

/**
 * `POST /api/v1/accounts/:accountId/raids/drops` body: a purple the plugin
 * didn't record, your own or a teammate's. Stored in its own table, never as
 * an event.
 */
export const raidDropCreateRequestSchema = z.strictObject({
  /** A raid mode in `RAIDS` (or an alias), e.g. "Theatre of Blood: Hard Mode". */
  raid: z.string().min(1).max(200),
  /** One of that raid's purples. */
  itemId: nonNegativeInt,
  /** When it dropped. Not before `EARLIEST_MANUAL_DROP_AT` and not in the future. */
  occurredAt: utcTimestamp,
  /** Who got it (since 1.23.0). Left out means `TEAMMATE`. Can't be changed afterwards. */
  recipient: z.enum(RAID_LOOT_RECIPIENTS).optional(),
  mode: splitModeSchema.optional(),
  ownValue: nonNegativeInt.optional(),
  partySize: partySize.optional(),
  /** Only for a teammate's drop. */
  nickname: choiceText.optional(),
  note: choiceText.optional(),
});

/** `PATCH …/raids/drops/:dropId` → `200` and `POST …/raids/drops` → `201`. */
export const raidDropResponseSchema = z.strictObject({ drop: raidDropSchema });

/** `:dropId` on `PATCH` and `DELETE …/raids/drops/:dropId`. */
export const raidDropParamsSchema = z.strictObject({
  accountId: accountIdParam,
  dropId: raidDropIdSchema,
});

export type RaidSplitsQuery = z.infer<typeof raidSplitsQuerySchema>;
export type RaidDrop = z.infer<typeof raidDropSchema>;
export type RaidSplitDefault = z.infer<typeof raidSplitDefaultSchema>;
export type RaidShareTotal = z.infer<typeof raidShareTotalSchema>;
export type RaidShare = z.infer<typeof raidShareSchema>;
export type RaidShareMonth = z.infer<typeof raidShareMonthSchema>;
export type RaidSplitsResponse = z.infer<typeof raidSplitsResponseSchema>;
export type RaidSplitDefaultRequest = z.infer<typeof raidSplitDefaultRequestSchema>;
export type RaidSplitDefaultResponse = z.infer<typeof raidSplitDefaultResponseSchema>;
export type RaidDropUpdateRequest = z.infer<typeof raidDropUpdateRequestSchema>;
export type RaidDropCreateRequest = z.infer<typeof raidDropCreateRequestSchema>;
export type RaidDropResponse = z.infer<typeof raidDropResponseSchema>;
