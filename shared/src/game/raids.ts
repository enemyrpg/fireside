import type { BossAlias } from './bosses.js';

/** A unique raid drop ("purple"), matched by item ID. */
export interface RaidPurple {
  itemId: number;
  /** Name as on the OSRS Wiki. Only for reading; matching uses `itemId`. */
  name: string;
}

export interface Raid {
  /** Raid name, used to group its modes (e.g. on the Raids tab). */
  name: string;
  /**
   * Each mode has its own KC in game, so each is a separate normalized boss
   * name. The first mode is the base raid and has the raid's own name.
   */
  modes: readonly BossAlias[];
  /** Unique chest drops. Hand-written and best effort; unknown items count as normal loot. */
  purples: readonly RaidPurple[];
  /** `false` until names and item IDs have been checked in game. */
  verified: boolean;
}

/** All raids. */
export const RAIDS: readonly Raid[] = [
  {
    name: 'Chambers of Xeric',
    modes: [
      { name: 'Chambers of Xeric', aliases: [] },
      { name: 'Chambers of Xeric: Challenge Mode', aliases: ['Chambers of Xeric Challenge Mode'] },
    ],
    purples: [
      { itemId: 21034, name: 'Dexterous prayer scroll' },
      { itemId: 21079, name: 'Arcane prayer scroll' },
      { itemId: 21000, name: 'Twisted buckler' },
      { itemId: 21012, name: 'Dragon hunter crossbow' },
      { itemId: 21015, name: "Dinh's bulwark" },
      { itemId: 21018, name: 'Ancestral hat' },
      { itemId: 21021, name: 'Ancestral robe top' },
      { itemId: 21024, name: 'Ancestral robe bottom' },
      { itemId: 13652, name: 'Dragon claws' },
      { itemId: 21003, name: 'Elder maul' },
      { itemId: 21043, name: 'Kodai insignia' },
      { itemId: 20997, name: 'Twisted bow' },
    ],
    verified: true,
  },
  {
    name: 'Theatre of Blood',
    modes: [
      { name: 'Theatre of Blood', aliases: [] },
      {
        name: 'Theatre of Blood: Entry Mode',
        aliases: [
          'Theatre of Blood Entry Mode',
          'Theatre of Blood: Story Mode',
          'Theatre of Blood Story Mode',
        ],
      },
      { name: 'Theatre of Blood: Hard Mode', aliases: ['Theatre of Blood Hard Mode'] },
    ],
    purples: [
      { itemId: 22477, name: 'Avernic defender hilt' },
      { itemId: 22324, name: 'Ghrazi rapier' },
      { itemId: 22481, name: 'Sanguinesti staff (uncharged)' },
      { itemId: 22326, name: 'Justiciar faceguard' },
      { itemId: 22327, name: 'Justiciar chestguard' },
      { itemId: 22328, name: 'Justiciar legguards' },
      { itemId: 22486, name: 'Scythe of vitur (uncharged)' },
    ],
    verified: true,
  },
  {
    name: 'Tombs of Amascut',
    modes: [
      { name: 'Tombs of Amascut', aliases: [] },
      { name: 'Tombs of Amascut: Entry Mode', aliases: ['Tombs of Amascut Entry Mode'] },
      { name: 'Tombs of Amascut: Expert Mode', aliases: ['Tombs of Amascut Expert Mode'] },
    ],
    purples: [
      { itemId: 26219, name: "Osmumten's fang" },
      { itemId: 25975, name: 'Lightbearer' },
      { itemId: 25985, name: "Elidinis' ward" },
      { itemId: 27226, name: 'Masori mask' },
      { itemId: 27229, name: 'Masori body' },
      { itemId: 27232, name: 'Masori chaps' },
      { itemId: 27277, name: "Tumeken's shadow (uncharged)" },
    ],
    verified: true,
  },
  {
    // To verify in game: released 20 October 2026. Only one mode so far.
    // Names, aliases and item IDs come from the owner, not from the game yet.
    name: 'The Fractured Archive',
    modes: [{ name: 'The Fractured Archive', aliases: ['Fractured Archive'] }],
    purples: [
      { itemId: 34717, name: 'Obligator (uncharged)' },
      { itemId: 34719, name: 'Rondache' },
      { itemId: 34727, name: "Zorya's tome (uncharged)" },
      { itemId: 34679, name: 'Horn of Bran' },
      { itemId: 34681, name: 'Ascension crossbows' },
    ],
    verified: false,
  },
];

const raidByMode: ReadonlyMap<string, Raid> = new Map(
  RAIDS.flatMap((raid) => raid.modes.map((mode) => [mode.name, raid] as const)),
);

/**
 * The raid a normalized boss name (`normalizeBossName`) belongs to, or
 * `undefined` for other bosses. Every mode maps to its raid.
 */
export function raidOf(normalizedName: string): Raid | undefined {
  return raidByMode.get(normalizedName);
}

/** True if `itemId` is one of the raid's purples. */
export function isRaidPurple(raid: Raid, itemId: number): boolean {
  return raid.purples.some((purple) => purple.itemId === itemId);
}
