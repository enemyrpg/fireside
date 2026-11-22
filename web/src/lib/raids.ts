import type { BossKc, Raid, RaidShare, RaidSummary } from '@fireside/shared';

// Raids tab of Progress: one card per raid with completions per mode and best
// time per team size (from `kc`), loot values (from `raids`) and your share of
// its purples (from `raids/splits`, 2.5).

export interface RaidModeRow {
  /** Normalized mode name, as in `kc` (e.g. "Tombs of Amascut: Expert Mode"). */
  mode: string;
  /** Short label within the raid card ("Normal", "Expert Mode"). */
  label: string;
  /** `undefined` when the mode has no completions yet. */
  kc: BossKc | undefined;
}

export interface RaidCardData {
  raid: string;
  modes: RaidModeRow[];
  /** `undefined` if `raids` has no entry for this raid. */
  summary: RaidSummary | undefined;
  /**
   * Your share of the raid's purples. `undefined` for a raid the tracker
   * doesn't list, and while the tracker is loading or failed.
   */
  share: number | undefined;
  /**
   * GE value of the own purples added by hand (`manualSpecialLootValue` in
   * `raids/splits`). They come on top of `summary.specialLootGeValue`, which
   * only has purples the plugin recorded. 0 without any, for a raid the
   * tracker doesn't list, and while the tracker is loading or failed.
   */
  manualSpecialLoot: number;
}

/** In the Special loot tooltip of a raid card with purples added by hand. */
export const SPECIAL_LOOT_RECORDED = 'Recorded by the plugin';
export const SPECIAL_LOOT_MANUAL = 'Added manually';
export const SPECIAL_LOOT_MANUAL_RULE =
  'Purples you added count at their GE price, or at what they sold for when no GE price was known.';

/** Special loot on the card: own purples the plugin recorded plus those added by hand. */
export function specialLootValue(card: RaidCardData): number {
  return Math.min(
    (card.summary?.specialLootGeValue ?? 0) + card.manualSpecialLoot,
    Number.MAX_SAFE_INTEGER,
  );
}

/** A raid card with loot or a share but no completions. The card's title names the raid. */
export const RAID_EMPTY = 'No completions yet.';

const ENTRY_MODE = 'Entry Mode';

/** The mode's name within its raid: the part after "<raid>: ", or "Normal" for the base mode. */
export function modeLabel(mode: string, raid: string): string {
  if (mode === raid) return 'Normal';
  const prefix = `${raid}: `;
  return mode.startsWith(prefix) ? mode.slice(prefix.length) : mode;
}

/** 1 Solo, 2 Duo, 3 Trio, else the number. */
export function teamSizeLabel(teamSize: number): string {
  if (teamSize === 1) return 'Solo';
  if (teamSize === 2) return 'Duo';
  if (teamSize === 3) return 'Trio';
  return String(teamSize);
}

/**
 * Modes from easiest to hardest: Entry Mode first,
 * then the base raid, then the other modes in `RAIDS` order.
 */
function orderedModes(raid: Raid): string[] {
  const names = raid.modes.map((mode) => mode.name);
  const entry = names.filter((name) => modeLabel(name, raid.name) === ENTRY_MODE);
  return [...entry, ...names.filter((name) => !entry.includes(name))];
}

/**
 * One card per raid in `raids` order, with every mode (completed or not).
 * A `category: raid` KC entry for a mode that `raids` doesn't list is added at
 * the end of its raid by name, and one for an unknown raid gets its own card,
 * so unknown game data still shows.
 */
export function raidCards(
  raids: readonly Raid[],
  bosses: readonly BossKc[],
  summaries: readonly RaidSummary[],
  shares: readonly RaidShare[] = [],
): RaidCardData[] {
  const raidKc = bosses.filter((boss) => boss.category === 'raid');
  const byMode = new Map(raidKc.map((boss) => [boss.boss, boss]));
  const known = new Set(raids.flatMap((raid) => raid.modes.map((mode) => mode.name)));
  const summaryOf = (name: string) => summaries.find((summary) => summary.raid === name);
  const extraModes = (name: string) =>
    raidKc.filter((boss) => boss.raid === name && !known.has(boss.boss)).map((boss) => boss.boss);
  const card = (name: string, modes: string[]): RaidCardData => ({
    raid: name,
    modes: modes.map((mode) => ({
      mode,
      label: modeLabel(mode, name),
      kc: byMode.get(mode),
    })),
    summary: summaryOf(name),
    share: shares.find((entry) => entry.raid === name)?.share,
    manualSpecialLoot: shares.find((entry) => entry.raid === name)?.manualSpecialLootValue ?? 0,
  });

  const cards = raids.map((raid) =>
    card(raid.name, [...orderedModes(raid), ...extraModes(raid.name)]),
  );
  const knownRaids = new Set(raids.map((raid) => raid.name));
  const unknownRaids = [
    ...new Set(
      raidKc.flatMap((boss) =>
        boss.raid !== null && !knownRaids.has(boss.raid) ? [boss.raid] : [],
      ),
    ),
  ];
  return [...cards, ...unknownRaids.map((name) => card(name, extraModes(name)))];
}

/**
 * The team sizes with the fastest time in one mode (2.4: the fastest time per
 * mode is highlighted). Times are compared as shown, to a tenth of a second, so
 * every size tied for fastest is highlighted.
 */
export function fastestTeamSizes(
  times: readonly { teamSize: number; seconds: number }[],
): Set<number> {
  const tenths = (seconds: number) => Math.round(seconds * 10);
  const best = Math.min(...times.map((time) => tenths(time.seconds)));
  return new Set(
    times.filter((time) => tenths(time.seconds) === best).map((time) => time.teamSize),
  );
}

/** Where `raids/splits` (the share and the purples added by hand) is. */
export type SharesState = 'loading' | 'loaded' | 'failed';

/** Completions in any mode, or loot (`raids`): known without the tracker. */
function hasCompletionsOrLoot(card: RaidCardData): boolean {
  return (
    card.modes.some((row) => row.kc !== undefined) ||
    (card.summary !== undefined &&
      (card.summary.lootCount > 0 || card.summary.specialLootGeValue > 0))
  );
}

/**
 * Raid cards, in `raidCards` order. A raid with completions or loot gets a card
 * right away. A raid with neither waits for `raids/splits`, since a share or a
 * purple added by hand also earns a card: while it loads the raid is in neither
 * list (`pending`), so it never jumps from the dashed line into a card. When it
 * failed, completions and loot alone decide. A raid is never in two lists.
 */
export function splitRaidCards(
  cards: readonly RaidCardData[],
  shares: SharesState = 'loaded',
): { shown: RaidCardData[]; empty: string[]; pending: number } {
  const shown: RaidCardData[] = [];
  const empty: string[] = [];
  let pending = 0;
  for (const card of cards) {
    if (hasCompletionsOrLoot(card)) shown.push(card);
    else if (shares === 'loading') pending += 1;
    else if (shares === 'loaded' && !isRaidEmpty(card)) shown.push(card);
    else empty.push(card.raid);
  }
  return { shown, empty, pending };
}

/**
 * Column of a shown card on wide screens: alternating left and right among
 * the cards shown, so a raid without a card never leaves a gap.
 */
export function raidColumn(index: number): 'left' | 'right' {
  return index % 2 === 0 ? 'left' : 'right';
}

/** The modes with completions, the only ones a card lists. */
export function completedModes(card: RaidCardData): (RaidModeRow & { kc: BossKc })[] {
  return card.modes.filter((row): row is RaidModeRow & { kc: BossKc } => row.kc !== undefined);
}

/** Completions over every raid mode, and how many raids have any ("2,871 · 4 raids"). */
export function raidCompletions(cards: readonly RaidCardData[]): {
  completions: number;
  raids: number;
} {
  let completions = 0;
  let raids = 0;
  for (const card of cards) {
    const modes = completedModes(card);
    if (modes.length > 0) raids += 1;
    completions += modes.reduce((sum, row) => sum + row.kc.killCount, 0);
  }
  return { completions, raids };
}

/** Special loot over every raid, purples added by hand included. */
export function totalSpecialLoot(cards: readonly RaidCardData[]): number {
  return Math.min(
    cards.reduce((sum, card) => sum + specialLootValue(card), 0),
    Number.MAX_SAFE_INTEGER,
  );
}

/** True if the raid has neither completions, loot, a share of a purple nor a purple added by hand. */
export function isRaidEmpty(card: RaidCardData): boolean {
  return (
    card.modes.every((row) => row.kc === undefined) &&
    (card.share ?? 0) === 0 &&
    card.manualSpecialLoot === 0 &&
    (card.summary === undefined ||
      (card.summary.lootCount === 0 && card.summary.specialLootGeValue === 0))
  );
}
