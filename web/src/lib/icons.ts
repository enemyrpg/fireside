import { apiUrl } from '@/api/client';
import { titleCase } from '@/format';

// Text for placeholder icons. No game graphics.

/**
 * URL of an item's real icon. The ID from the data is used as is: noted items
 * have their own icon, and the server never maps IDs.
 */
export function itemIconUrl(itemId: number): string {
  return apiUrl(`/items/${String(itemId)}/icon`);
}

/**
 * URL of a skill's real icon. The skill name from the data is used as is
 * (`ATTACK`); the total level is `OVERALL`.
 */
export function skillIconUrl(skill: string): string {
  return apiUrl(`/skills/${encodeURIComponent(skill)}/icon`);
}

/**
 * URL of a boss's or raid's real icon. The name from the data is sent as is:
 * the server normalizes it, and a raid mode without an icon of its own gets its
 * raid's.
 */
export function bossIconUrl(boss: string): string {
  return apiUrl(`/bosses/${encodeURIComponent(boss)}/icon`);
}

/** How long after the last stored icon the plugin's import counts as running. */
export const ICON_IMPORT_WINDOW_MS = 2 * 60_000;

/**
 * Whether the plugin is probably importing icons right now: the newest icon
 * was stored under two minutes ago. The server doesn't know how many icons
 * the game has, so this is the only sign (`GET /admin/icons`).
 */
export function isImportingIcons(lastStoredAt: string | null, now: number): boolean {
  if (lastStoredAt === null) return false;
  const age = now - Date.parse(lastStoredAt);
  return age < ICON_IMPORT_WINDOW_MS;
}

/** First two letters or digits of an item name: `Abyssal whip` -> `Ab`. */
export function itemInitials(name: string): string {
  const letters = Array.from(name.replace(/[^\p{L}\p{N}]/gu, ''));
  return letters.slice(0, 2).join('') || '?';
}

/**
 * Initials of a boss name as players abbreviate it: the first letter of every
 * word, short words too, in capitals, up to 3 (`Chambers of Xeric` -> `COX`,
 * `Tombs of Amascut` -> `TOA`, `The Fractured Archive` -> `TFA`, `King Black
 * Dragon` -> `KBD`), or the first two letters of a one-word name (`Vorkath` ->
 * `Vo`). A mode after a colon is left out.
 */
export function bossInitials(name: string): string {
  const base = name.split(':')[0] ?? name;
  const words = base.split(/\s+/).filter((word) => /^[\p{L}\p{N}]/u.test(word));
  if (words.length >= 2)
    return words
      .map((word) => word.charAt(0).toUpperCase())
      .join('')
      .slice(0, 3);
  return itemInitials(base);
}

/** Fixed abbreviations. Skills have no colours and no game icons. */
export const SKILL_ABBREVIATIONS: Record<string, string> = {
  OVERALL: 'All',
  ATTACK: 'At',
  DEFENCE: 'De',
  STRENGTH: 'St',
  HITPOINTS: 'HP',
  RANGED: 'Ra',
  PRAYER: 'Pr',
  MAGIC: 'Ma',
  COOKING: 'Co',
  WOODCUTTING: 'WC',
  FLETCHING: 'Fl',
  FISHING: 'Fi',
  FIREMAKING: 'FM',
  CRAFTING: 'Cr',
  SMITHING: 'Sm',
  MINING: 'Mi',
  HERBLORE: 'He',
  AGILITY: 'Ag',
  THIEVING: 'Th',
  SLAYER: 'Sl',
  FARMING: 'Fa',
  RUNECRAFT: 'RC',
  HUNTER: 'Hu',
  CONSTRUCTION: 'Con',
  SAILING: 'Sa',
};

/** Abbreviation for a skill. Unknown skills get their first two letters. */
export function skillAbbreviation(skill: string): string {
  return SKILL_ABBREVIATIONS[skill] ?? titleCase(skill).slice(0, 2);
}
