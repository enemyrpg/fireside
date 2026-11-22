import { z } from 'zod';
import { EVENT_SCHEMA_VERSION } from '../contract.js';
import {
  BANK_TAB_COUNT,
  MAX_BANK_ITEMS,
  MAX_EQUIPMENT_ITEMS,
  MAX_INVENTORY_ITEMS,
  MAX_ITEM_DOSES,
} from '../game/bank.js';
import { MAX_PET_NAME_LENGTH, PET_MESSAGES } from '../game/pets.js';
import {
  DIARY_TIERS,
  MAX_DIARY_ENTRIES,
  MAX_QUEST_NAME_LENGTH,
  MAX_QUEST_POINTS,
  MAX_QUESTS,
  QUEST_KINDS,
  QUEST_STATES,
} from '../game/quests.js';
import { SKILLS, type Skill } from '../game/skills.js';
import {
  accountHash,
  accountTypeName,
  nonNegativeInt,
  positiveInt,
  semver,
  UPPER_NAME_PATTERN,
  upperName,
  utcTimestamp,
  uuidV7,
} from './common.js';

// Events from the plugin. What each one holds, in plain words:
// docs/data-collected.md.
// All objects are strict: unknown keys are rejected.

// --- Payloads ---------------------------------------------------------------

export const sessionStartPayloadSchema = z.strictObject({
  /** The player's own display name. Never used to identify the account. */
  displayName: z.string().min(1),
  accountType: accountTypeName,
  world: positiveInt,
  pluginVersion: semver,
});

export const sessionHeartbeatPayloadSchema = z.strictObject({
  regionId: nonNegativeInt,
  world: positiveInt,
  /** RuneLite `WorldType` names. Empty for a plain F2P world. */
  worldTypes: z.array(upperName),
  /** RuneLite `WorldRegion` name. `null` if the world list isn't loaded. */
  worldLocation: upperName.nullable(),
  /** Activity text from the world list (may be empty). `null` if the list isn't loaded. */
  worldActivity: z.string().nullable(),
  idle: z.boolean(),
});

export const sessionAfkPayloadSchema = z
  .strictObject({
    startedAt: utcTimestamp,
    endedAt: utcTimestamp,
  })
  .refine((period) => period.endedAt >= period.startedAt, {
    // Same format and time zone, so string comparison is chronological.
    message: 'endedAt must not be before startedAt',
    path: ['endedAt'],
  });

export const SESSION_END_REASONS = ['logout', 'client_closed', 'hop'] as const;

export const sessionEndPayloadSchema = z.strictObject({
  reason: z.enum(SESSION_END_REASONS),
});

/** Why a session closed, as stored on the server. `timeout` is set by the server, never sent. */
export const SESSION_CLOSE_REASONS = [...SESSION_END_REASONS, 'timeout'] as const;

export const XP_SNAPSHOT_REASONS = ['login', 'logout', 'interval'] as const;

/** OSRS caps XP per skill at 200M. */
export const MAX_SKILL_XP = 200_000_000;

export const skillValueSchema = z.strictObject({
  xp: nonNegativeInt.max(MAX_SKILL_XP),
  level: z.int().min(1).max(99),
});

const knownSkillsShape = Object.fromEntries(
  SKILLS.map((skill) => [skill, skillValueSchema]),
) as Record<Skill, typeof skillValueSchema>;

/**
 * All skills in `SKILLS` are required. Unknown extra skills are accepted if
 * their name is `UPPER_SNAKE_CASE`. Built as an object (not a record with a
 * refine) so the required skills carry over to the exported JSON Schema.
 */
export const xpSnapshotSkillsSchema = z
  .object(knownSkillsShape)
  .catchall(skillValueSchema)
  .check((ctx) => {
    for (const key of Object.keys(ctx.value)) {
      if (!UPPER_NAME_PATTERN.test(key)) {
        ctx.issues.push({
          code: 'custom',
          message: 'Must be an UPPER_SNAKE_CASE name',
          input: key,
          path: [key],
        });
      }
    }
  })
  .meta({ propertyNames: { type: 'string', pattern: UPPER_NAME_PATTERN.source } });

export const xpSnapshotPayloadSchema = z.strictObject({
  reason: z.enum(XP_SNAPSHOT_REASONS),
  skills: xpSnapshotSkillsSchema,
});

/** Players in a raid or group, yourself included. */
const teamSize = z.int().min(1).max(100);

export const LOOT_SOURCE_TYPES = ['NPC', 'PLAYER', 'EVENT', 'CLUE', 'OTHER'] as const;

export const lootSourceSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('NPC'),
    name: z.string().min(1),
    npcId: nonNegativeInt.optional(),
    combatLevel: nonNegativeInt.optional(),
  }),
  // We never store data about other players: no name, no npcId, no combatLevel.
  z.strictObject({
    type: z.literal('PLAYER'),
    name: z.null(),
  }),
  z.strictObject({
    type: z.enum(['EVENT', 'CLUE', 'OTHER']),
    name: z.string().min(1),
  }),
]);

export const lootItemSchema = z.strictObject({
  itemId: nonNegativeInt,
  name: z.string().min(1),
  quantity: positiveInt,
  /** Grand Exchange price per item at drop time. */
  gePrice: nonNegativeInt,
  /** High alchemy price per item at drop time. */
  haPrice: nonNegativeInt,
});

export const lootPayloadSchema = z.strictObject({
  source: lootSourceSchema,
  items: z.array(lootItemSchema).min(1),
  killCount: positiveInt.optional(),
});

export const kcPayloadSchema = z.strictObject({
  /** Name as shown in chat. The server normalizes it with `normalizeBossName`. */
  boss: z.string().min(1),
  killCount: positiveInt,
  timeSeconds: z.number().positive().optional(),
  personalBest: z.boolean().optional(),
  /**
   * The player's personal best after this kill: the "Personal best: x" value,
   * or `timeSeconds` when the message says it was a new personal best. Not
   * checked against `timeSeconds`: the game may round them differently, and a
   * rejected event is never retried. Since 1.14.0.
   */
  personalBestSeconds: z.number().positive().optional(),
  /** Players in the raid or group, yourself included. Since 1.9.0. */
  teamSize: teamSize.optional(),
});

export const RAID_LOOT_RECIPIENTS = ['SELF', 'TEAMMATE'] as const;

/** A purple item. No `haPrice`: not needed for special loot. */
export const raidSpecialLootItemSchema = z.strictObject({
  itemId: nonNegativeInt,
  name: z.string().min(1),
  quantity: positiveInt,
  /** Grand Exchange price per item at drop time, also for a teammate's drop. */
  gePrice: nonNegativeInt,
});

/**
 * A purple from a raid, for you or a teammate. Since 1.9.0.
 * We never store data about other players: `recipient` is `SELF` or
 * `TEAMMATE`, never a name, and extra keys (such as a name) are rejected.
 */
export const raidSpecialLootPayloadSchema = z.strictObject({
  /** Raid mode as shown in chat. The server normalizes it with `normalizeBossName`. */
  raid: z.string().min(1),
  item: raidSpecialLootItemSchema,
  recipient: z.enum(RAID_LOOT_RECIPIENTS),
  teamSize: teamSize.optional(),
  killCount: positiveInt.optional(),
});

/** `scope` of a `pb.records` record for the whole raid (other scopes are room names). */
export const PB_RECORDS_OVERALL = 'overall';

/** One personal best from the game's records table. */
export const pbRecordSchema = z.strictObject({
  /** `overall` for the whole raid, otherwise the room's name as shown in the table. */
  scope: z.string().min(1),
  teamSize,
  seconds: z.number().positive(),
});

/**
 * Personal bests per scope and team size from the game's records table (TFA's
 * `TfaStats`), read when the player opens it. Since 1.17.0. Only the player's
 * own records: no names, and extra keys are rejected. Each (`scope`,
 * `teamSize`) pair appears once.
 */
export const pbRecordsPayloadSchema = z.strictObject({
  /** Raid as shown in chat. The server normalizes it with `normalizeBossName`. */
  boss: z.string().min(1),
  records: z
    .array(pbRecordSchema)
    .min(1)
    .check((ctx) => {
      const seen = new Set<string>();
      ctx.value.forEach((record, index) => {
        const key = JSON.stringify([record.scope, record.teamSize]);
        if (seen.has(key)) {
          ctx.issues.push({
            code: 'custom',
            message: 'Each scope and team size may appear only once',
            input: record,
            path: [index],
          });
        }
        seen.add(key);
      });
    }),
});

// --- Bank and potion storage (since 1.19.0) --------------------------------
// Item IDs are canonical:
// a placeholder has the real item's ID. Prices are per item at snapshot time.

/** `sha256:` and 64 lowercase hex digits. Opaque to the server: stored, never recomputed. */
export const contentHash = z
  .string()
  .regex(/^sha256:[0-9a-f]{64}$/, 'Must be sha256: and 64 lowercase hex digits');

const priceFields = {
  /**
   * Grand Exchange price per item at snapshot time, from RuneLite's item
   * manager: an untradeable RuneLite maps to tradeable parts gets their price,
   * any other untradeable 0 (as RuneLite's Bank plugin shows it).
   */
  gePrice: nonNegativeInt,
  /** High alchemy price per item. */
  haPrice: nonNegativeInt,
};

/**
 * One bank slot. A placeholder has `quantity: 0`, anything else at least 1.
 * Placeholders carry prices too (their value is 0 anyway).
 */
export const bankItemSchema = z.discriminatedUnion('placeholder', [
  z.strictObject({
    itemId: nonNegativeInt,
    name: z.string().min(1),
    quantity: positiveInt,
    placeholder: z.literal(false),
    ...priceFields,
  }),
  z.strictObject({
    itemId: nonNegativeInt,
    name: z.string().min(1),
    quantity: z.literal(0),
    placeholder: z.literal(true),
    ...priceFields,
  }),
]);

/** One occupied inventory slot, in container order. Noted IDs are kept as they are. */
export const inventoryItemSchema = z.strictObject({
  itemId: nonNegativeInt,
  name: z.string().min(1),
  quantity: positiveInt,
  ...priceFields,
});

/** One worn item. `slot` is RuneLite's `EquipmentInventorySlot` name, e.g. `WEAPON`. */
export const equipmentItemSchema = z.strictObject({
  slot: upperName,
  itemId: nonNegativeInt,
  name: z.string().min(1),
  quantity: positiveInt,
  ...priceFields,
});

/**
 * The bank in container order, with inventory and equipment, taken when the
 * bank closes and the content changed. `tabSizes` are tabs 1–9; the items
 * after them are the main tab. Tab sizes may not sum to more than the
 * number of items, and each equipment slot appears once.
 */
export const bankSnapshotPayloadSchema = z
  .strictObject({
    tabSizes: z.array(nonNegativeInt).length(BANK_TAB_COUNT),
    items: z.array(bankItemSchema).max(MAX_BANK_ITEMS),
    inventory: z.array(inventoryItemSchema).max(MAX_INVENTORY_ITEMS),
    equipment: z.array(equipmentItemSchema).max(MAX_EQUIPMENT_ITEMS),
    contentHash,
  })
  .check((ctx) => {
    const { tabSizes, items, equipment } = ctx.value;
    const tabbed = tabSizes.reduce((sum, size) => sum + size, 0);
    if (tabbed > items.length) {
      ctx.issues.push({
        code: 'custom',
        message: 'Tab sizes may not sum to more than the number of items',
        input: tabSizes,
        path: ['tabSizes'],
      });
    }
    const slots = new Set<string>();
    equipment.forEach((item, index) => {
      if (slots.has(item.slot)) {
        ctx.issues.push({
          code: 'custom',
          message: 'Each equipment slot may appear only once',
          input: item,
          path: ['equipment', index, 'slot'],
        });
      }
      slots.add(item.slot);
    });
  });

/**
 * One potion type in potion storage. Prices are for the full item `itemId`
 * (`itemDoses` doses, usually the 4-dose); the server values the stored
 * doses as ⌊price × doses ÷ itemDoses⌋.
 */
export const potionStorageItemSchema = z.strictObject({
  itemId: nonNegativeInt,
  /** Potion name without dose, e.g. "Super combat potion". */
  name: z.string().min(1),
  doses: positiveInt,
  itemDoses: z.int().min(1).max(MAX_ITEM_DOSES),
  ...priceFields,
});

/** Potion storage, read with the bank. Each `itemId` appears once. */
export const potionStorageSnapshotPayloadSchema = z.strictObject({
  potions: z.array(potionStorageItemSchema).check((ctx) => {
    const seen = new Set<number>();
    ctx.value.forEach((potion, index) => {
      if (seen.has(potion.itemId)) {
        ctx.issues.push({
          code: 'custom',
          message: 'Each itemId may appear only once',
          input: potion,
          path: [index, 'itemId'],
        });
      }
      seen.add(potion.itemId);
    });
  }),
  contentHash,
});

// --- Quests and diaries (since 1.21.0) --------------------------------------
// Full snapshots: the server keeps
// the latest one per account and when each entry was first seen as finished.

/** One entry of RuneLite's `Quest` enum. */
export const questEntrySchema = z.strictObject({
  /** RuneLite `Quest` enum name. Unknown quests are accepted. */
  quest: upperName,
  /** Name in the game, shown as sent. */
  name: z.string().min(1).max(MAX_QUEST_NAME_LENGTH),
  state: z.enum(QUEST_STATES),
  /**
   * From the game's quest list. Left out when the plugin cannot tell; the
   * entry then counts as a quest.
   */
  kind: z.enum(QUEST_KINDS).optional(),
});

/** State of every quest and miniquest. Each `quest` appears once. */
export const questsSnapshotPayloadSchema = z.strictObject({
  questPoints: nonNegativeInt.max(MAX_QUEST_POINTS),
  quests: z
    .array(questEntrySchema)
    .max(MAX_QUESTS)
    .check((ctx) => {
      const seen = new Set<string>();
      ctx.value.forEach((entry, index) => {
        if (seen.has(entry.quest)) {
          ctx.issues.push({
            code: 'custom',
            message: 'Each quest may appear only once',
            input: entry,
            path: [index, 'quest'],
          });
        }
        seen.add(entry.quest);
      });
    }),
});

/** One tier of one achievement diary. */
export const diaryEntrySchema = z.strictObject({
  /** Region key, e.g. `ARDOUGNE`. Unknown regions are accepted. */
  region: upperName,
  tier: z.enum(DIARY_TIERS),
  completed: z.boolean(),
});

/** State of every diary tier. Each (`region`, `tier`) appears once. */
export const diariesSnapshotPayloadSchema = z.strictObject({
  diaries: z
    .array(diaryEntrySchema)
    .max(MAX_DIARY_ENTRIES)
    .check((ctx) => {
      const seen = new Set<string>();
      ctx.value.forEach((entry, index) => {
        const key = `${entry.region}:${entry.tier}`;
        if (seen.has(key)) {
          ctx.issues.push({
            code: 'custom',
            message: 'Each region and tier may appear only once',
            input: entry,
            path: [index, 'tier'],
          });
        }
        seen.add(key);
      });
    }),
});

// --- Pets (since 1.27.0) ----------------------------------------------------
// The chat text is never sent:
// only which known message it was, and the plugin's guess of pet and source.

/** The pet the plugin thinks dropped. */
export const guessedPetSchema = z.strictObject({
  /**
   * The pet's item in the collection log ("All Pets"): the variant that
   * drops, never a metamorph variant.
   */
  itemId: positiveInt,
  /** Item name, so a pet the server does not know is shown by name. */
  name: z.string().min(1).max(MAX_PET_NAME_LENGTH),
});

/** What the plugin thinks the pet came from. Decides whether KC or XP is shown. */
export const petSourceSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('ACTIVITY'),
    /** Boss, NPC, raid or minigame, named as in `loot` and `kc`. */
    name: z.string().min(1).max(MAX_PET_NAME_LENGTH),
  }),
  z.strictObject({
    type: z.literal('SKILL'),
    /** RuneLite `Skill` name. Unknown skills are accepted. */
    name: upperName,
  }),
]);

/**
 * A pet chat message. Extra keys (such as the chat text) are rejected. Both
 * guesses are left out when the plugin cannot tell.
 */
export const petDropPayloadSchema = z.strictObject({
  message: z.enum(PET_MESSAGES),
  guessedPet: guessedPetSchema.optional(),
  guessedSource: petSourceSchema.optional(),
});

// --- Envelope and union -----------------------------------------------------

const envelopeFields = {
  eventId: uuidV7,
  schemaVersion: z.literal(EVENT_SCHEMA_VERSION),
  accountHash,
  /** When it happened in game, not when it was sent. */
  occurredAt: utcTimestamp,
  sessionId: uuidV7,
};

function eventOf<const T extends string, P extends z.ZodType>(type: T, payload: P) {
  return z.strictObject({ ...envelopeFields, type: z.literal(type), payload });
}

export const sessionStartEventSchema = eventOf('session.start', sessionStartPayloadSchema);
export const sessionHeartbeatEventSchema = eventOf(
  'session.heartbeat',
  sessionHeartbeatPayloadSchema,
);
export const sessionAfkEventSchema = eventOf('session.afk', sessionAfkPayloadSchema);
export const sessionEndEventSchema = eventOf('session.end', sessionEndPayloadSchema);
export const xpSnapshotEventSchema = eventOf('xp.snapshot', xpSnapshotPayloadSchema);
export const lootEventSchema = eventOf('loot', lootPayloadSchema);
export const kcEventSchema = eventOf('kc', kcPayloadSchema);
export const raidSpecialLootEventSchema = eventOf(
  'raid.special_loot',
  raidSpecialLootPayloadSchema,
);
export const pbRecordsEventSchema = eventOf('pb.records', pbRecordsPayloadSchema);
export const bankSnapshotEventSchema = eventOf('bank.snapshot', bankSnapshotPayloadSchema);
export const potionStorageSnapshotEventSchema = eventOf(
  'potion_storage.snapshot',
  potionStorageSnapshotPayloadSchema,
);
export const questsSnapshotEventSchema = eventOf('quests.snapshot', questsSnapshotPayloadSchema);
export const diariesSnapshotEventSchema = eventOf('diaries.snapshot', diariesSnapshotPayloadSchema);
export const petDropEventSchema = eventOf('pet.drop', petDropPayloadSchema);

/** Any event from the plugin, discriminated on `type`. */
export const eventSchema = z.discriminatedUnion('type', [
  sessionStartEventSchema,
  sessionHeartbeatEventSchema,
  sessionAfkEventSchema,
  sessionEndEventSchema,
  xpSnapshotEventSchema,
  lootEventSchema,
  kcEventSchema,
  raidSpecialLootEventSchema,
  pbRecordsEventSchema,
  bankSnapshotEventSchema,
  potionStorageSnapshotEventSchema,
  questsSnapshotEventSchema,
  diariesSnapshotEventSchema,
  petDropEventSchema,
]);

export const EVENT_TYPES = [
  'session.start',
  'session.heartbeat',
  'session.afk',
  'session.end',
  'xp.snapshot',
  'loot',
  'kc',
  'raid.special_loot',
  'pb.records',
  'bank.snapshot',
  'potion_storage.snapshot',
  'quests.snapshot',
  'diaries.snapshot',
  'pet.drop',
] as const satisfies readonly Event['type'][];

/** True if `value` is one of `EVENT_TYPES`. */
export function isEventType(value: unknown): value is EventType {
  return (EVENT_TYPES as readonly unknown[]).includes(value);
}

// --- Types ------------------------------------------------------------------

export type Event = z.infer<typeof eventSchema>;
export type EventType = Event['type'];
export type EventOfType<T extends EventType> = Extract<Event, { type: T }>;

export type SessionStartEvent = z.infer<typeof sessionStartEventSchema>;
export type SessionHeartbeatEvent = z.infer<typeof sessionHeartbeatEventSchema>;
export type SessionAfkEvent = z.infer<typeof sessionAfkEventSchema>;
export type SessionEndEvent = z.infer<typeof sessionEndEventSchema>;
export type XpSnapshotEvent = z.infer<typeof xpSnapshotEventSchema>;
export type LootEvent = z.infer<typeof lootEventSchema>;
export type KcEvent = z.infer<typeof kcEventSchema>;
export type RaidSpecialLootEvent = z.infer<typeof raidSpecialLootEventSchema>;
export type PbRecordsEvent = z.infer<typeof pbRecordsEventSchema>;
export type BankSnapshotEvent = z.infer<typeof bankSnapshotEventSchema>;
export type PotionStorageSnapshotEvent = z.infer<typeof potionStorageSnapshotEventSchema>;
export type QuestsSnapshotEvent = z.infer<typeof questsSnapshotEventSchema>;
export type DiariesSnapshotEvent = z.infer<typeof diariesSnapshotEventSchema>;
export type PetDropEvent = z.infer<typeof petDropEventSchema>;

export type SessionStartPayload = z.infer<typeof sessionStartPayloadSchema>;
export type SessionHeartbeatPayload = z.infer<typeof sessionHeartbeatPayloadSchema>;
export type SessionAfkPayload = z.infer<typeof sessionAfkPayloadSchema>;
export type SessionEndPayload = z.infer<typeof sessionEndPayloadSchema>;
export type SessionEndReason = SessionEndPayload['reason'];
export type XpSnapshotPayload = z.infer<typeof xpSnapshotPayloadSchema>;
export type XpSnapshotReason = XpSnapshotPayload['reason'];
export type SkillValue = z.infer<typeof skillValueSchema>;
export type LootPayload = z.infer<typeof lootPayloadSchema>;
export type LootSource = z.infer<typeof lootSourceSchema>;
export type LootSourceType = LootSource['type'];
export type LootItem = z.infer<typeof lootItemSchema>;
export type KcPayload = z.infer<typeof kcPayloadSchema>;
export type RaidSpecialLootPayload = z.infer<typeof raidSpecialLootPayloadSchema>;
export type RaidLootRecipient = RaidSpecialLootPayload['recipient'];
export type PbRecordsPayload = z.infer<typeof pbRecordsPayloadSchema>;
export type PbRecord = z.infer<typeof pbRecordSchema>;
export type BankSnapshotPayload = z.infer<typeof bankSnapshotPayloadSchema>;
export type BankItem = z.infer<typeof bankItemSchema>;
export type InventoryItem = z.infer<typeof inventoryItemSchema>;
export type EquipmentItem = z.infer<typeof equipmentItemSchema>;
export type PotionStorageSnapshotPayload = z.infer<typeof potionStorageSnapshotPayloadSchema>;
export type PotionStorageItem = z.infer<typeof potionStorageItemSchema>;
export type QuestsSnapshotPayload = z.infer<typeof questsSnapshotPayloadSchema>;
export type QuestEntry = z.infer<typeof questEntrySchema>;
export type DiariesSnapshotPayload = z.infer<typeof diariesSnapshotPayloadSchema>;
export type DiaryEntry = z.infer<typeof diaryEntrySchema>;
export type PetDropPayload = z.infer<typeof petDropPayloadSchema>;
export type GuessedPet = z.infer<typeof guessedPetSchema>;
export type PetSource = z.infer<typeof petSourceSchema>;
