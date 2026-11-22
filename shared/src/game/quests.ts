// Quest and achievement diary rules shared by server and dashboard.

/** RuneLite `QuestState` names. */
export const QUEST_STATES = ['NOT_STARTED', 'IN_PROGRESS', 'FINISHED'] as const;
export type QuestState = (typeof QUEST_STATES)[number];

/**
 * Quests give quest points and count in "quests completed"; miniquests are
 * listed and counted on their own. An entry without `kind` is a quest.
 */
export const QUEST_KINDS = ['QUEST', 'MINIQUEST'] as const;
export type QuestKind = (typeof QUEST_KINDS)[number];

/** Diary tiers, easiest first (the display order). */
export const DIARY_TIERS = ['EASY', 'MEDIUM', 'HARD', 'ELITE'] as const;
export type DiaryTier = (typeof DIARY_TIERS)[number];

/** Most entries in one `quests.snapshot` (the game has ~220 today). */
export const MAX_QUESTS = 500;

/** Highest `questPoints` accepted (the game has ~330 today). */
export const MAX_QUEST_POINTS = 10_000;

/** Longest quest name accepted. */
export const MAX_QUEST_NAME_LENGTH = 100;

/** Most entries in one `diaries.snapshot` (12 regions × 4 tiers today). */
export const MAX_DIARY_ENTRIES = 200;

/**
 * Known diary regions with their names in the game. `diaries.snapshot` has no
 * name, so an unknown region is shown by its key (`diaryRegionName`).
 */
export const DIARY_REGIONS = {
  ARDOUGNE: 'Ardougne',
  DESERT: 'Desert',
  FALADOR: 'Falador',
  FREMENNIK: 'Fremennik',
  KANDARIN: 'Kandarin',
  KARAMJA: 'Karamja',
  KOUREND: 'Kourend & Kebos',
  LUMBRIDGE: 'Lumbridge & Draynor',
  MORYTANIA: 'Morytania',
  VARROCK: 'Varrock',
  WESTERN: 'Western Provinces',
  WILDERNESS: 'Wilderness',
} as const satisfies Record<string, string>;

export type DiaryRegion = keyof typeof DIARY_REGIONS;

/** Display name of a diary region: the known name, else "NEW_REGION" → "New Region". */
export function diaryRegionName(region: string): string {
  if (Object.hasOwn(DIARY_REGIONS, region)) return DIARY_REGIONS[region as DiaryRegion];
  return region
    .split('_')
    .filter((word) => word.length > 0)
    .map((word) => word.charAt(0) + word.slice(1).toLowerCase())
    .join(' ');
}

/** Order of names in API lists: by name ignoring case, then by key. Not locale-dependent. */
export function compareByName(
  a: { name: string; key: string },
  b: { name: string; key: string },
): number {
  const left = a.name.toLowerCase();
  const right = b.name.toLowerCase();
  if (left !== right) return left < right ? -1 : 1;
  if (a.key === b.key) return 0;
  return a.key < b.key ? -1 : 1;
}
