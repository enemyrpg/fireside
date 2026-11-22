import { RAIDS, type Raid } from '@fireside/shared';
import type { Activity, DropEntry, DropTable, Range } from './activities.js';
import { ITEMS, type Item } from './items.js';

// Raids: one activity per mode, since each mode has its own KC
// in game. Modes, aliases and purples come from `RAIDS` in shared. Prices,
// weights, rates and times are rough but plausible. The Fractured Archive is
// unverified in `RAIDS` and used as is; its rates and times come from the
// owner, its prices and regions are made up.

export interface RaidSpec {
  raid: Raid;
  /** Players in the raid, you included, weighted. */
  teamSizes: readonly (readonly [number, number])[];
  /** Chance per completion that someone in the team gets a purple is 1 in this. */
  purpleOneIn: number;
  /** Minutes between completions on top of the raid time (lobby, banking, scouting). */
  overheadMinutes: Range;
  /**
   * The raid has an in-game records table with PBs per team size (TFA's
   * `TfaStats`). The player opens it after a new PB: a `pb.records` event.
   */
  recordsTable?: boolean;
}

/** GE price and relative drop weight per purple, by item ID. */
const PURPLES: ReadonlyMap<number, { ge: number; weight: number }> = new Map([
  // Chambers of Xeric
  [21034, { ge: 10_000_000, weight: 20 }],
  [21079, { ge: 3_000_000, weight: 20 }],
  [21000, { ge: 9_000_000, weight: 4 }],
  [21012, { ge: 40_000_000, weight: 4 }],
  [21015, { ge: 1_500_000, weight: 3 }],
  [21018, { ge: 30_000_000, weight: 3 }],
  [21021, { ge: 85_000_000, weight: 3 }],
  [21024, { ge: 75_000_000, weight: 3 }],
  [13652, { ge: 70_000_000, weight: 3 }],
  [21003, { ge: 4_000_000, weight: 2 }],
  [21043, { ge: 45_000_000, weight: 2 }],
  [20997, { ge: 1_400_000_000, weight: 2 }],
  // Theatre of Blood
  [22477, { ge: 25_000_000, weight: 8 }],
  [22324, { ge: 15_000_000, weight: 2 }],
  [22481, { ge: 40_000_000, weight: 2 }],
  [22326, { ge: 12_000_000, weight: 2 }],
  [22327, { ge: 15_000_000, weight: 2 }],
  [22328, { ge: 10_000_000, weight: 2 }],
  [22486, { ge: 900_000_000, weight: 1 }],
  // Tombs of Amascut
  [26219, { ge: 25_000_000, weight: 7 }],
  [25975, { ge: 3_000_000, weight: 7 }],
  [25985, { ge: 4_000_000, weight: 3 }],
  [27226, { ge: 7_000_000, weight: 2 }],
  [27229, { ge: 30_000_000, weight: 2 }],
  [27232, { ge: 25_000_000, weight: 2 }],
  [27277, { ge: 950_000_000, weight: 1 }],
  // The Fractured Archive (made-up prices, equal weights)
  [34717, { ge: 20_000_000, weight: 1 }],
  [34719, { ge: 8_000_000, weight: 1 }],
  [34727, { ge: 15_000_000, weight: 1 }],
  [34679, { ge: 5_000_000, weight: 1 }],
  [34681, { ge: 30_000_000, weight: 1 }],
]);

/** The raid's purples as items, weighted for a drop roll. */
export function purpleTable(raid: Raid): (readonly [Item, number])[] {
  return raid.purples.map((purple) => {
    const price = PURPLES.get(purple.itemId);
    if (!price) throw new Error(`No seed price for purple ${String(purple.itemId)}`);
    // High alchemy values of purples are tiny next to GE prices; a flat value is enough.
    const item: Item = { id: purple.itemId, name: purple.name, ge: price.ge, ha: 50_000 };
    return [item, price.weight] as const;
  });
}

function raidNamed(name: string): Raid {
  const raid = RAIDS.find((r) => r.name === name);
  if (!raid) throw new Error(`Unknown raid: ${name}`);
  return raid;
}

/** Raid time scale by team size: solo is slower, big teams a bit faster. */
export function teamTimeFactor(teamSize: number): number {
  if (teamSize <= 1) return 1.25;
  if (teamSize === 2) return 1.1;
  if (teamSize === 3) return 1;
  if (teamSize === 4) return 0.95;
  return 0.92;
}

const e = (item: Item, quantity: Range, weight: number): DropEntry => ({ item, quantity, weight });

const COX_CHEST: DropTable = {
  rolls: [2, 2],
  common: [
    e(ITEMS.deathRune, [300, 900], 3),
    e(ITEMS.bloodRune, [200, 600], 3),
    e(ITEMS.soulRune, [200, 700], 3),
    e(ITEMS.grimyTorstol, [8, 30], 2),
    e(ITEMS.grimyDwarfWeed, [10, 40], 2),
    e(ITEMS.runiteOre, [10, 30], 2),
    e(ITEMS.coal, [300, 900], 2),
    e(ITEMS.teakPlank, [50, 150], 2),
    e(ITEMS.dynamite, [100, 300], 2),
    e(ITEMS.pureEssence, [2_000, 6_000], 1),
  ],
};

const TOB_CHEST: DropTable = {
  rolls: [3, 3],
  common: [
    e(ITEMS.vialOfBlood, [50, 60], 3),
    e(ITEMS.deathRune, [400, 600], 3),
    e(ITEMS.bloodRune, [400, 600], 3),
    e(ITEMS.runeBattleaxe, [3, 4], 2),
    e(ITEMS.runePlatebody, [2, 3], 2),
    e(ITEMS.goldOre, [300, 400], 2),
    e(ITEMS.grimyCadantine, [30, 40], 2),
    e(ITEMS.coal, [400, 600], 2),
  ],
};

const TOA_CHEST: DropTable = {
  rolls: [3, 4],
  common: [
    e(ITEMS.coins, [20_000, 80_000], 3),
    e(ITEMS.deathRune, [200, 600], 3),
    e(ITEMS.soulRune, [200, 600], 3),
    e(ITEMS.goldOre, [100, 300], 2),
    e(ITEMS.dragonstone, [2, 6], 2),
    e(ITEMS.battlestaff, [5, 15], 2),
    e(ITEMS.rawShark, [30, 80], 2),
    e(ITEMS.coal, [200, 500], 2),
  ],
};

const ARCHIVE_CHEST: DropTable = {
  rolls: [3, 4],
  common: [
    e(ITEMS.coins, [30_000, 100_000], 3),
    e(ITEMS.wrathRune, [100, 300], 3),
    e(ITEMS.soulRune, [200, 500], 3),
    e(ITEMS.runiteOre, [10, 25], 2),
    e(ITEMS.magicLogs, [100, 250], 2),
    e(ITEMS.mantaRay, [20, 40], 2),
  ],
};

interface ModeOptions {
  id: string;
  raid: string;
  mode: string;
  /** KC chat name variants (mode name and aliases), weighted. */
  kcNames: readonly (readonly [string, number])[];
  /** Raid time in seconds for a team of three (scaled by `teamTimeFactor`). */
  seconds: Range;
  teamSizes: readonly (readonly [number, number])[];
  purpleOneIn: number;
  chest: DropTable;
  regions: readonly number[];
  xpPerHour: Activity['xpPerHour'];
  availableFrom?: number;
  recordsTable?: boolean;
}

function mode(options: ModeOptions): Activity {
  return {
    id: options.id,
    members: true,
    regions: options.regions,
    xpPerHour: options.xpPerHour,
    kills: {
      // Not used for raids: the time between completions follows from the raid time.
      minutes: [1, 1],
      source: { type: 'EVENT', name: options.mode },
      kcNames: options.kcNames,
      killSeconds: options.seconds,
      lootChance: 1,
      drops: options.chest,
      raid: {
        raid: raidNamed(options.raid),
        teamSizes: options.teamSizes,
        purpleOneIn: options.purpleOneIn,
        overheadMinutes: [3, 8],
        ...(options.recordsTable ? { recordsTable: true } : {}),
      },
    },
    // Raids fill an evening and you rarely go AFK in one.
    minBlockMinutes: 60,
    afkFactor: 0.15,
    ...(options.availableFrom === undefined ? {} : { availableFrom: options.availableFrom }),
  };
}

/** The Fractured Archive came out on 20 October 2026. */
export const ARCHIVE_RELEASE_MS = Date.parse('2026-10-20T10:00:00.000Z');

const COX = 'Chambers of Xeric';
const TOB = 'Theatre of Blood';
const TOA = 'Tombs of Amascut';
const ARCHIVE = 'The Fractured Archive';

const COX_REGIONS = [4919, 13136, 13137, 13393, 13395];
const TOB_REGIONS = [14642, 12613, 13125, 13122, 13123, 13379, 12611];
const TOA_REGIONS = [13454, 14160, 15700, 14674, 15186, 15184];
// Placeholder region IDs: The Fractured Archive is not verified in game yet.
const ARCHIVE_REGIONS = [5940, 5941];

const COX_XP = { RANGED: 110_000, MAGIC: 40_000, HITPOINTS: 55_000, DEFENCE: 10_000 };
const TOB_XP = { STRENGTH: 90_000, RANGED: 50_000, MAGIC: 40_000, HITPOINTS: 70_000 };
const TOA_XP = { RANGED: 80_000, MAGIC: 50_000, STRENGTH: 40_000, HITPOINTS: 60_000 };

export const RAID_ACTIVITIES: readonly Activity[] = [
  mode({
    id: 'cox',
    raid: COX,
    mode: COX,
    kcNames: [[COX, 1]],
    seconds: [1_080, 1_320],
    teamSizes: [
      [1, 20],
      [2, 15],
      [3, 25],
      [4, 15],
      [5, 13],
      [6, 5],
      [7, 4],
      [9, 3],
    ],
    purpleOneIn: 25,
    chest: COX_CHEST,
    regions: COX_REGIONS,
    xpPerHour: COX_XP,
  }),
  mode({
    id: 'cox-cm',
    raid: COX,
    mode: `${COX}: Challenge Mode`,
    kcNames: [
      [`${COX}: Challenge Mode`, 0.9],
      [`${COX} Challenge Mode`, 0.1],
    ],
    seconds: [1_500, 1_900],
    teamSizes: [
      [1, 5],
      [3, 45],
      [4, 15],
      [5, 35],
    ],
    purpleOneIn: 15,
    chest: COX_CHEST,
    regions: COX_REGIONS,
    xpPerHour: COX_XP,
  }),
  mode({
    id: 'tob-entry',
    raid: TOB,
    mode: `${TOB}: Entry Mode`,
    kcNames: [
      [`${TOB}: Entry Mode`, 0.9],
      [`${TOB}: Story Mode`, 0.1],
    ],
    seconds: [720, 900],
    teamSizes: [
      [1, 15],
      [2, 30],
      [3, 25],
      [4, 15],
      [5, 15],
    ],
    purpleOneIn: 80,
    chest: TOB_CHEST,
    regions: TOB_REGIONS,
    xpPerHour: TOB_XP,
  }),
  mode({
    id: 'tob',
    raid: TOB,
    mode: TOB,
    kcNames: [[TOB, 1]],
    seconds: [840, 1_020],
    teamSizes: [
      [3, 20],
      [4, 40],
      [5, 40],
    ],
    purpleOneIn: 9,
    chest: TOB_CHEST,
    regions: TOB_REGIONS,
    xpPerHour: TOB_XP,
  }),
  mode({
    id: 'tob-hard',
    raid: TOB,
    mode: `${TOB}: Hard Mode`,
    kcNames: [[`${TOB}: Hard Mode`, 1]],
    seconds: [1_260, 1_440],
    teamSizes: [
      [4, 40],
      [5, 60],
    ],
    purpleOneIn: 8,
    chest: TOB_CHEST,
    regions: TOB_REGIONS,
    xpPerHour: TOB_XP,
  }),
  mode({
    id: 'toa-entry',
    raid: TOA,
    mode: `${TOA}: Entry Mode`,
    kcNames: [[`${TOA}: Entry Mode`, 1]],
    seconds: [720, 900],
    teamSizes: [
      [1, 50],
      [2, 30],
      [3, 20],
    ],
    purpleOneIn: 60,
    chest: TOA_CHEST,
    regions: TOA_REGIONS,
    xpPerHour: TOA_XP,
  }),
  mode({
    id: 'toa',
    raid: TOA,
    mode: TOA,
    kcNames: [[TOA, 1]],
    seconds: [960, 1_150],
    teamSizes: [
      [1, 30],
      [2, 20],
      [3, 20],
      [4, 12],
      [5, 8],
      [6, 4],
      [8, 6],
    ],
    purpleOneIn: 25,
    chest: TOA_CHEST,
    regions: TOA_REGIONS,
    xpPerHour: TOA_XP,
  }),
  mode({
    id: 'toa-expert',
    raid: TOA,
    mode: `${TOA}: Expert Mode`,
    kcNames: [
      [`${TOA}: Expert Mode`, 0.9],
      [`${TOA} Expert Mode`, 0.1],
    ],
    seconds: [1_500, 1_600],
    teamSizes: [
      [2, 30],
      [3, 35],
      [4, 20],
      [5, 15],
    ],
    purpleOneIn: 12,
    chest: TOA_CHEST,
    regions: TOA_REGIONS,
    xpPerHour: TOA_XP,
  }),
  mode({
    id: 'tfa',
    raid: ARCHIVE,
    mode: ARCHIVE,
    kcNames: [
      [ARCHIVE, 0.9],
      ['Fractured Archive', 0.1],
    ],
    // 18–30 minutes after scaling: 1 175 × 0.92 ≈ 18 min, 1 440 × 1.25 = 30 min.
    seconds: [1_175, 1_440],
    teamSizes: [
      [1, 25],
      [2, 25],
      [3, 25],
      [4, 15],
      [5, 10],
    ],
    purpleOneIn: 14,
    chest: ARCHIVE_CHEST,
    regions: ARCHIVE_REGIONS,
    xpPerHour: { RANGED: 70_000, MAGIC: 60_000, HITPOINTS: 50_000 },
    availableFrom: ARCHIVE_RELEASE_MS,
    recordsTable: true,
  }),
];
