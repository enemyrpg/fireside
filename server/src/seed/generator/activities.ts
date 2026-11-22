import type { LootSource, Skill } from '@fireside/shared';
import { ITEMS, type Item } from './items.js';
import { RAID_ACTIVITIES, type RaidSpec } from './raids.js';

// What simulated accounts do in a session: XP rates, kills, KC names and
// drop tables. Rates and drop chances are rough but plausible.

export type Range = readonly [number, number];

export interface DropEntry {
  item: Item;
  quantity: Range;
  weight: number;
}

export interface RareDrop {
  item: Item;
  quantity: Range;
  /** Chance per kill is 1 in this. */
  oneIn: number;
}

export interface DropTable {
  /** Items always dropped (e.g. bones). */
  always?: readonly { item: Item; quantity: Range }[];
  /** How many rolls on `common`. */
  rolls: Range;
  common: readonly DropEntry[];
  rare?: readonly RareDrop[];
}

export interface KillSpec {
  /** Minutes per kill, banking included. */
  minutes: Range;
  /** Loot source. `PLAYER` loot is handled separately (`pvpLootChance`). */
  source: Exclude<LootSource, { type: 'PLAYER' }>;
  /**
   * Boss name variants in KC chat messages, weighted. Mostly the canonical
   * name; some aliases or other casing to exercise `normalizeBossName`.
   * Without it there is no KC message (e.g. slayer monsters).
   */
  kcNames?: readonly (readonly [string, number])[];
  /** Kill time in seconds for the KC message (bosses with a timer). */
  killSeconds?: Range;
  /** Chance that a kill gives a loot event (some kills drop nothing tracked). */
  lootChance: number;
  drops: DropTable;
  /** Raid completions: team sizes, purples and the time between completions. */
  raid?: RaidSpec;
}

export interface Clue {
  /** Chance per active hour of finishing a clue. */
  perHour: number;
  tier: keyof typeof CLUE_TABLES;
}

export interface Activity {
  id: string;
  /** Needs a members world. */
  members: boolean;
  regions: readonly number[];
  /** XP per active hour. */
  xpPerHour: Partial<Record<Skill, number>>;
  kills?: KillSpec;
  /** Wilderness: chance per session of killing a player (loot without name). */
  pvpLootChance?: number;
  clue?: Clue;
  /** Only picked for play blocks at least this long (raids fill an evening). */
  minBlockMinutes?: number;
  /** Not picked before this time (content released during the window). */
  availableFrom?: number;
  /** Multiplies the profile's AFK chance per minute. */
  afkFactor?: number;
}

const e = (item: Item, quantity: Range, weight: number): DropEntry => ({ item, quantity, weight });
const r = (item: Item, quantity: Range, oneIn: number): RareDrop => ({ item, quantity, oneIn });

export const CLUE_TABLES = {
  easy: {
    rolls: [2, 4],
    common: [
      e(ITEMS.coins, [100, 900], 5),
      e(ITEMS.leatherBoots, [1, 1], 3),
      e(ITEMS.purpleSweets, [2, 8], 3),
      e(ITEMS.mindRune, [30, 60], 3),
    ],
  },
  medium: {
    rolls: [3, 5],
    common: [
      e(ITEMS.coins, [500, 3_000], 5),
      e(ITEMS.prayerPotion4, [1, 3], 3),
      e(ITEMS.lawRune, [20, 40], 3),
      e(ITEMS.purpleSweets, [4, 12], 3),
    ],
    rare: [r(ITEMS.rangerBoots, [1, 1], 60)],
  },
  hard: {
    rolls: [4, 6],
    common: [
      e(ITEMS.coins, [3_000, 12_000], 5),
      e(ITEMS.runePlatebody, [1, 1], 2),
      e(ITEMS.magicLongbow, [1, 1], 2),
      e(ITEMS.shark, [10, 15], 3),
      e(ITEMS.purpleSweets, [8, 20], 3),
    ],
    rare: [r(ITEMS.robinHoodHat, [1, 1], 50)],
  },
} as const satisfies Record<string, DropTable>;

export const PVP_LOOT: DropTable = {
  always: [{ item: ITEMS.bones, quantity: [1, 1] }],
  rolls: [2, 4],
  common: [
    e(ITEMS.coins, [5_000, 60_000], 5),
    e(ITEMS.shark, [1, 6], 4),
    e(ITEMS.runeScimitar, [1, 1], 2),
    e(ITEMS.dragonDagger, [1, 1], 2),
    e(ITEMS.prayerPotion4, [1, 3], 3),
  ],
};

const ACTIVITY_LIST: readonly Activity[] = [
  // --- Bossing (main) -------------------------------------------------------
  {
    id: 'vorkath',
    members: true,
    regions: [9023, 10553],
    xpPerHour: { RANGED: 280_000, HITPOINTS: 95_000 },
    kills: {
      minutes: [2.5, 4],
      source: { type: 'NPC', name: 'Vorkath', npcId: 8061, combatLevel: 732 },
      kcNames: [
        ['Vorkath', 0.92],
        ['vorkath', 0.08],
      ],
      killSeconds: [62, 110],
      lootChance: 1,
      drops: {
        always: [
          { item: ITEMS.superiorDragonBones, quantity: [2, 2] },
          { item: ITEMS.blueDragonhide, quantity: [2, 2] },
        ],
        rolls: [2, 2],
        common: [
          e(ITEMS.dragonBoltsUnf, [50, 100], 4),
          e(ITEMS.wrathRune, [50, 75], 4),
          e(ITEMS.runeKiteshield, [2, 2], 2),
          e(ITEMS.dragonBattleaxe, [1, 1], 1),
          e(ITEMS.mantaRay, [15, 20], 3),
          e(ITEMS.runiteOre, [5, 10], 2),
          e(ITEMS.dragonstone, [2, 2], 2),
          e(ITEMS.coins, [25_000, 65_000], 3),
        ],
        rare: [r(ITEMS.draconicVisage, [1, 1], 5000), r(ITEMS.skeletalVisage, [1, 1], 5000)],
      },
    },
    clue: { perHour: 0.25, tier: 'hard' },
  },
  {
    id: 'zulrah',
    members: true,
    regions: [9007, 9008],
    xpPerHour: { RANGED: 150_000, MAGIC: 120_000, HITPOINTS: 90_000 },
    kills: {
      minutes: [1.8, 3],
      source: { type: 'NPC', name: 'Zulrah', npcId: 2042, combatLevel: 725 },
      kcNames: [
        ['Zulrah', 0.95],
        ['ZULRAH', 0.05],
      ],
      killSeconds: [55, 95],
      lootChance: 1,
      drops: {
        always: [{ item: ITEMS.zulrahsScales, quantity: [100, 500] }],
        rolls: [2, 2],
        common: [
          e(ITEMS.snakeskin, [35, 55], 4),
          e(ITEMS.coal, [150, 250], 3),
          e(ITEMS.magicLogs, [100, 150], 3),
          e(ITEMS.runiteOre, [2, 4], 2),
          e(ITEMS.grimyToadflax, [10, 25], 3),
          e(ITEMS.snapdragonSeed, [1, 2], 1),
          e(ITEMS.dragonBoltsUnf, [20, 40], 2),
        ],
        rare: [
          r(ITEMS.tanzaniteFang, [1, 1], 512),
          r(ITEMS.magicFang, [1, 1], 512),
          r(ITEMS.serpentineVisage, [1, 1], 512),
          r(ITEMS.uncutOnyx, [1, 1], 512),
          r(ITEMS.tanzaniteMutagen, [1, 1], 6553),
        ],
      },
    },
    clue: { perHour: 0.2, tier: 'hard' },
  },
  {
    id: 'graardor',
    members: true,
    regions: [11347],
    xpPerHour: { STRENGTH: 170_000, ATTACK: 20_000, HITPOINTS: 63_000 },
    kills: {
      minutes: [1.5, 2.5],
      source: { type: 'NPC', name: 'General Graardor', npcId: 2215, combatLevel: 624 },
      kcNames: [['General Graardor', 1]],
      lootChance: 1,
      drops: {
        always: [{ item: ITEMS.bigBones, quantity: [1, 1] }],
        rolls: [1, 1],
        common: [
          e(ITEMS.runeLongsword, [1, 1], 3),
          e(ITEMS.runeTwoHandedSword, [1, 1], 3),
          e(ITEMS.coins, [19_000, 21_000], 4),
          e(ITEMS.natureRune, [60, 70], 2),
          e(ITEMS.snapdragonSeed, [1, 1], 1),
          e(ITEMS.adamantiteOre, [15, 20], 2),
        ],
        rare: [
          r(ITEMS.bandosChestplate, [1, 1], 381),
          r(ITEMS.bandosTassets, [1, 1], 381),
          r(ITEMS.bandosBoots, [1, 1], 381),
          r(ITEMS.bandosHilt, [1, 1], 508),
          r(ITEMS.godswordShard1, [1, 1], 762),
        ],
      },
    },
  },
  {
    id: 'calvarion',
    members: true,
    regions: [7604, 7860],
    xpPerHour: { RANGED: 120_000, HITPOINTS: 40_000 },
    kills: {
      minutes: [2, 3.5],
      source: { type: 'NPC', name: "Calvar'ion" },
      kcNames: [
        ["Calvar'ion", 0.85],
        ['Calvarion', 0.15],
      ],
      lootChance: 1,
      drops: {
        always: [{ item: ITEMS.bigBones, quantity: [1, 1] }],
        rolls: [1, 2],
        common: [
          e(ITEMS.cannonball, [100, 300], 3),
          e(ITEMS.runiteBar, [3, 6], 2),
          e(ITEMS.uncutDragonstone, [1, 2], 2),
          e(ITEMS.coins, [10_000, 25_000], 4),
          e(ITEMS.dragonTwoHandedSword, [1, 1], 1),
        ],
        rare: [r(ITEMS.dragonPickaxe, [1, 1], 256)],
      },
    },
    pvpLootChance: 0.35,
  },
  {
    // An invented boss that is never in BOSS_ALIASES: unknown bosses are stored by name.
    id: 'seedUnknownBoss',
    members: true,
    regions: [12850],
    xpPerHour: { STRENGTH: 100_000, HITPOINTS: 33_000 },
    kills: {
      minutes: [1.5, 3],
      source: { type: 'NPC', name: 'Seed Unknown Boss' },
      kcNames: [['Seed Unknown Boss', 1]],
      killSeconds: [40, 80],
      lootChance: 1,
      drops: {
        always: [{ item: ITEMS.cowhide, quantity: [3, 6] }],
        rolls: [1, 2],
        common: [
          e(ITEMS.rawBeef, [5, 15], 4),
          e(ITEMS.bigBones, [2, 4], 3),
          e(ITEMS.coins, [3_000, 9_000], 3),
        ],
        rare: [r(ITEMS.uncutDiamond, [1, 3], 30)],
      },
    },
  },
  {
    id: 'barrows',
    members: true,
    regions: [14131, 14231],
    xpPerHour: { MAGIC: 70_000, HITPOINTS: 25_000, PRAYER: 2_000 },
    kills: {
      minutes: [4, 7],
      source: { type: 'EVENT', name: 'Barrows' },
      kcNames: [
        ['Barrows Chests', 0.7],
        ['Barrows chest', 0.2],
        ['Barrows', 0.1],
      ],
      lootChance: 1,
      drops: {
        rolls: [2, 4],
        common: [
          e(ITEMS.coins, [1_000, 7_000], 4),
          e(ITEMS.deathRune, [50, 120], 3),
          e(ITEMS.bloodRune, [30, 80], 3),
          e(ITEMS.chaosRune, [100, 250], 3),
          e(ITEMS.mindRune, [500, 1_200], 3),
          e(ITEMS.boltRack, [30, 70], 2),
        ],
        rare: [
          r(ITEMS.ahrimsRobetop, [1, 1], 100),
          r(ITEMS.dharoksGreataxe, [1, 1], 100),
          r(ITEMS.karilsCrossbow, [1, 1], 100),
          r(ITEMS.guthansHelm, [1, 1], 100),
          r(ITEMS.toragsHammers, [1, 1], 100),
          r(ITEMS.veracsFlail, [1, 1], 100),
        ],
      },
    },
    clue: { perHour: 0.15, tier: 'medium' },
  },
  // --- Skilling and slayer --------------------------------------------------
  { id: 'sailing', members: true, regions: [12082, 11826], xpPerHour: { SAILING: 55_000 } },
  { id: 'construction', members: true, regions: [7769], xpPerHour: { CONSTRUCTION: 450_000 } },
  {
    id: 'abyssal-demons',
    members: true,
    regions: [6556, 6812],
    xpPerHour: { SLAYER: 42_000, STRENGTH: 110_000, HITPOINTS: 50_000 },
    kills: {
      minutes: [0.6, 1.2],
      source: { type: 'NPC', name: 'Abyssal demon', npcId: 415, combatLevel: 124 },
      lootChance: 0.85,
      drops: {
        always: [{ item: ITEMS.ashes, quantity: [1, 1] }],
        rolls: [1, 1],
        common: [
          e(ITEMS.coins, [100, 500], 4),
          e(ITEMS.lawRune, [3, 10], 2),
          e(ITEMS.airRune, [10, 50], 3),
          e(ITEMS.runeMedHelm, [1, 1], 1),
          e(ITEMS.runeChainbody, [1, 1], 1),
          e(ITEMS.pureEssence, [10, 60], 2),
        ],
        rare: [r(ITEMS.abyssalWhip, [1, 1], 512), r(ITEMS.abyssalDagger, [1, 1], 2000)],
      },
    },
    clue: { perHour: 0.3, tier: 'hard' },
  },
  {
    id: 'wintertodt',
    members: true,
    regions: [6461, 6462],
    xpPerHour: { FIREMAKING: 220_000, WOODCUTTING: 30_000 },
    kills: {
      minutes: [4, 6],
      source: { type: 'EVENT', name: 'Wintertodt' },
      kcNames: [['Wintertodt', 1]],
      lootChance: 1,
      drops: {
        rolls: [2, 4],
        common: [
          e(ITEMS.yewLogs, [20, 60], 3),
          e(ITEMS.magicLogs, [5, 20], 2),
          e(ITEMS.pureEssence, [80, 200], 3),
          e(ITEMS.grimyRanarr, [2, 5], 2),
          e(ITEMS.rawShark, [5, 15], 2),
          e(ITEMS.uncutSapphire, [2, 6], 2),
          e(ITEMS.uncutRuby, [1, 4], 2),
          e(ITEMS.coal, [20, 60], 2),
          e(ITEMS.ranarrSeed, [1, 2], 1),
        ],
        rare: [r(ITEMS.tomeOfFire, [1, 1], 1000), r(ITEMS.dragonAxe, [1, 1], 10000)],
      },
    },
  },
  {
    id: 'tempoross',
    members: true,
    regions: [12078, 12588],
    xpPerHour: { FISHING: 65_000, CONSTRUCTION: 5_000 },
    kills: {
      minutes: [7, 10],
      source: { type: 'EVENT', name: 'Tempoross' },
      kcNames: [['Tempoross', 1]],
      lootChance: 1,
      drops: {
        rolls: [3, 5],
        common: [
          e(ITEMS.rawLobster, [10, 30], 3),
          e(ITEMS.rawSwordfish, [10, 25], 3),
          e(ITEMS.rawShark, [5, 15], 2),
          e(ITEMS.plank, [10, 30], 2),
          e(ITEMS.oakPlank, [5, 20], 2),
          e(ITEMS.seaweedSpore, [3, 8], 2),
        ],
        rare: [r(ITEMS.dragonHarpoon, [1, 1], 8000)],
      },
    },
  },
  { id: 'agility', members: true, regions: [10806], xpPerHour: { AGILITY: 55_000 } },
  { id: 'woodcutting', members: true, regions: [10805, 10550], xpPerHour: { WOODCUTTING: 75_000 } },
  { id: 'runecraft', members: true, regions: [12119, 11597], xpPerHour: { RUNECRAFT: 45_000 } },
  {
    id: 'herb-run',
    members: true,
    regions: [11061, 10548, 13106],
    xpPerHour: { FARMING: 140_000, HERBLORE: 40_000 },
  },
  { id: 'mining', members: true, regions: [14936], xpPerHour: { MINING: 48_000, SMITHING: 6_000 } },
  { id: 'iron-sailing', members: true, regions: [12082], xpPerHour: { SAILING: 35_000 } },
  // --- Free-to-play (alt) ---------------------------------------------------
  {
    id: 'cows',
    members: false,
    regions: [12851],
    xpPerHour: { ATTACK: 6_000, STRENGTH: 7_000, DEFENCE: 3_000, HITPOINTS: 5_300 },
    kills: {
      minutes: [0.4, 0.8],
      source: { type: 'NPC', name: 'Cow', npcId: 2790, combatLevel: 2 },
      lootChance: 0.6,
      drops: {
        always: [
          { item: ITEMS.cowhide, quantity: [1, 1] },
          { item: ITEMS.bones, quantity: [1, 1] },
        ],
        rolls: [0, 1],
        common: [e(ITEMS.rawBeef, [1, 1], 1)],
      },
    },
    clue: { perHour: 0.1, tier: 'easy' },
  },
  {
    id: 'obor',
    members: false,
    regions: [12441],
    xpPerHour: { STRENGTH: 22_000, HITPOINTS: 7_000 },
    kills: {
      minutes: [3, 5],
      source: { type: 'NPC', name: 'Obor', npcId: 7416, combatLevel: 106 },
      kcNames: [
        ['Obor', 0.9],
        ['obor', 0.1],
      ],
      lootChance: 1,
      drops: {
        always: [{ item: ITEMS.bigBones, quantity: [1, 1] }],
        rolls: [1, 2],
        common: [
          e(ITEMS.limpwurtRoot, [1, 3], 3),
          e(ITEMS.runeLongsword, [1, 1], 1),
          e(ITEMS.coins, [400, 2_500], 4),
          e(ITEMS.lawRune, [10, 20], 2),
        ],
        rare: [r(ITEMS.hillGiantClub, [1, 1], 118)],
      },
    },
  },
  {
    id: 'bryophyta',
    members: false,
    regions: [12955],
    xpPerHour: { MAGIC: 20_000, HITPOINTS: 6_000 },
    kills: {
      minutes: [3, 5],
      source: { type: 'NPC', name: 'Bryophyta', npcId: 8195, combatLevel: 128 },
      kcNames: [['Bryophyta', 1]],
      lootChance: 1,
      drops: {
        always: [{ item: ITEMS.bigBones, quantity: [1, 1] }],
        rolls: [1, 2],
        common: [
          e(ITEMS.natureRune, [10, 30], 3),
          e(ITEMS.runeLongsword, [1, 1], 1),
          e(ITEMS.coins, [400, 2_500], 4),
          e(ITEMS.battlestaff, [1, 2], 2),
        ],
      },
    },
  },
  { id: 'f2p-mining', members: false, regions: [12593], xpPerHour: { MINING: 14_000 } },
  {
    id: 'f2p-fishing',
    members: false,
    regions: [12850],
    xpPerHour: { FISHING: 16_000, COOKING: 14_000 },
  },
  {
    id: 'f2p-woodcutting',
    members: false,
    regions: [12594],
    xpPerHour: { WOODCUTTING: 18_000, FIREMAKING: 12_000 },
  },
  // --- Raids -----------------------------------------------------
  ...RAID_ACTIVITIES,
];

export const ACTIVITIES: ReadonlyMap<string, Activity> = new Map(
  ACTIVITY_LIST.map((activity) => [activity.id, activity]),
);

export function activity(id: string): Activity {
  const found = ACTIVITIES.get(id);
  if (!found) throw new Error(`Unknown activity: ${id}`);
  return found;
}
