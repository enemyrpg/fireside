import { RAIDS } from './raids.js';

export interface BossAlias {
  /** Canonical name, following OSRS Wiki naming. */
  name: string;
  /** Other names the plugin may send (chat messages, loot sources, old names). */
  aliases: readonly string[];
}

/**
 * Canonical boss names and their known aliases. Matching ignores case and
 * extra whitespace, so bosses without aliases are listed only to fix casing.
 * Best effort: extend it when new chat or loot variants show up. Unknown
 * names are kept as sent, so missing entries never cause errors.
 * Raid modes come from `RAIDS` (raids.ts), so they are listed once.
 * The aliases ending in "chests opened" and "Deep delves" are the names in
 * the game's hiscore table, which the plugin sends as boss icon keys.
 */
export const BOSS_ALIASES: readonly BossAlias[] = [
  { name: 'Abyssal Sire', aliases: [] },
  { name: 'Alchemical Hydra', aliases: [] },
  { name: 'Amoxliatl', aliases: [] },
  { name: 'Araxxor', aliases: [] },
  { name: 'Artio', aliases: [] },
  { name: 'Barrows Chests', aliases: ['Barrows', 'Barrows chest'] },
  { name: 'Bryophyta', aliases: ['Bryophyta chests opened'] },
  { name: 'Callisto', aliases: [] },
  { name: "Calvar'ion", aliases: ['Calvarion'] },
  { name: 'Cerberus', aliases: [] },
  { name: 'Chaos Elemental', aliases: [] },
  { name: 'Chaos Fanatic', aliases: [] },
  { name: 'Commander Zilyana', aliases: [] },
  { name: 'Corporeal Beast', aliases: [] },
  { name: 'Crazy Archaeologist', aliases: [] },
  { name: 'Dagannoth Prime', aliases: [] },
  { name: 'Dagannoth Rex', aliases: [] },
  { name: 'Dagannoth Supreme', aliases: [] },
  { name: 'Deranged Archaeologist', aliases: [] },
  { name: 'Doom of Mokhaiotl', aliases: ['Doom of Mokhaiotl: Deep delves'] },
  { name: 'Duke Sucellus', aliases: [] },
  { name: 'General Graardor', aliases: [] },
  { name: 'Giant Mole', aliases: [] },
  { name: 'Grotesque Guardians', aliases: ['Dusk', 'Dawn'] },
  { name: 'Hespori', aliases: [] },
  { name: "K'ril Tsutsaroth", aliases: ['Kril Tsutsaroth'] },
  { name: 'Kalphite Queen', aliases: [] },
  { name: 'King Black Dragon', aliases: [] },
  { name: 'Kraken', aliases: [] },
  { name: "Kree'arra", aliases: ['Kreearra'] },
  { name: 'Lunar Chests', aliases: ['Lunar Chest', 'Moons of Peril'] },
  { name: 'Mad Angel', aliases: ['The Mad Angel'] },
  { name: 'Maggot King', aliases: [] },
  { name: 'Mimic', aliases: [] },
  { name: 'Nex', aliases: [] },
  { name: 'Obor', aliases: ['Obor chests opened'] },
  { name: 'Phantom Muspah', aliases: [] },
  { name: "Phosani's Nightmare", aliases: [] },
  { name: 'Sarachnis', aliases: [] },
  { name: 'Scorpia', aliases: [] },
  { name: 'Scurrius', aliases: [] },
  { name: 'Shellbane Gryphon', aliases: [] },
  { name: 'Skotizo', aliases: [] },
  { name: 'Sol Heredit', aliases: ['Fortis Colosseum'] },
  { name: 'Spindel', aliases: [] },
  { name: 'Tempoross', aliases: [] },
  { name: 'The Corrupted Gauntlet', aliases: ['Corrupted Gauntlet', 'Corrupted Hunllef'] },
  { name: 'The Gauntlet', aliases: ['Gauntlet', 'Crystalline Hunllef'] },
  { name: 'The Hueycoatl', aliases: ['Hueycoatl'] },
  { name: 'The Leviathan', aliases: ['Leviathan'] },
  { name: 'The Nightmare', aliases: ['Nightmare', 'The Nightmare of Ashihama'] },
  { name: 'The Royal Titans', aliases: ['Royal Titans'] },
  { name: 'The Whisperer', aliases: ['Whisperer'] },
  { name: 'Thermonuclear Smoke Devil', aliases: [] },
  { name: 'TzKal-Zuk', aliases: ['Zuk'] },
  { name: 'TzTok-Jad', aliases: ['Jad'] },
  { name: 'Vardorvis', aliases: [] },
  { name: 'Venenatis', aliases: [] },
  { name: "Vet'ion", aliases: ['Vetion'] },
  { name: 'Vorkath', aliases: [] },
  { name: 'Wintertodt', aliases: ['Subdued Wintertodt'] },
  { name: 'Yama', aliases: [] },
  { name: 'Zalcano', aliases: [] },
  { name: 'Zulrah', aliases: [] },
  ...RAIDS.flatMap((raid) => raid.modes),
];

/** Trims, collapses whitespace and turns typographic apostrophes into `'`. */
function clean(name: string): string {
  return name
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/[\u2018\u2019\u02BC]/g, "'");
}

const lookup: ReadonlyMap<string, string> = new Map(
  BOSS_ALIASES.flatMap((boss) =>
    [boss.name, ...boss.aliases].map((alias) => [clean(alias).toLowerCase(), boss.name] as const),
  ),
);

/**
 * Maps a boss name from the plugin to its canonical name. Unknown names are
 * returned cleaned up (whitespace, apostrophes), so new bosses are stored by name.
 */
export function normalizeBossName(raw: string): string {
  const name = clean(raw);
  return lookup.get(name.toLowerCase()) ?? name;
}
