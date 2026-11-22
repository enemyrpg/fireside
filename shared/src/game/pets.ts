// Pets (since 1.27.0).

/**
 * The chat messages the game shows when a pet drops, as the plugin reports
 * them. The chat text itself is never sent. From RuneLite 1.13.6
 * (`ScreenshotPlugin.PET_MESSAGES`):
 * - `FOLLOWED`: "You have a funny feeling like you're being followed". A new
 *   pet that now follows the player.
 * - `BACKPACK`: "You feel something weird sneaking into your backpack". A new
 *   pet, placed in the inventory.
 * - `DUPLICATE`: "You have a funny feeling like you would have been
 *   followed". A pet the account already has. Never counts as a pet.
 */
export const PET_MESSAGES = ['FOLLOWED', 'BACKPACK', 'DUPLICATE'] as const;
export type PetMessage = (typeof PET_MESSAGES)[number];

/** True for a message that means the account got a pet it did not have. */
export function isNewPetMessage(message: PetMessage): boolean {
  return message !== 'DUPLICATE';
}

/**
 * What a pet came from:
 * - `ACTIVITY`: a boss, NPC, raid or minigame, named as in `loot` and `kc`.
 * - `SKILL`: a skill, by its RuneLite `Skill` name.
 */
export const PET_SOURCE_TYPES = ['ACTIVITY', 'SKILL'] as const;
export type PetSourceType = (typeof PET_SOURCE_TYPES)[number];

/** Where an account's pet is known from. A pet seen in both is `CHAT`, confirmed. */
export const PET_ORIGINS = ['CLOG', 'CHAT'] as const;
export type PetOrigin = (typeof PET_ORIGINS)[number];

/** The collection log page that lists every pet once. */
export const CLOG_ALL_PETS_PAGE = 'All Pets';

/** Longest pet or source name accepted. */
export const MAX_PET_NAME_LENGTH = 100;

/** What the order of a pet list looks at. */
export interface PetOrderKey {
  obtainedAt: string | null;
  name: string;
  accountId: number;
  itemId: number;
}

function compareText(a: string, b: string): number {
  return a === b ? 0 : a < b ? -1 : 1;
}

/**
 * Order of `pets`: newest first, pets without a time last. Ties (and pets
 * without a time) by name without regard to case, then name, account and item.
 * Lives here, not with the schema, so the dashboard can use it without Zod.
 */
export function comparePets(a: PetOrderKey, b: PetOrderKey): number {
  if (a.obtainedAt !== b.obtainedAt) {
    if (a.obtainedAt === null) return 1;
    if (b.obtainedAt === null) return -1;
    // Timestamps are fixed-format UTC, so string order is time order.
    return a.obtainedAt > b.obtainedAt ? -1 : 1;
  }
  return (
    compareText(a.name.toLowerCase(), b.name.toLowerCase()) ||
    compareText(a.name, b.name) ||
    a.accountId - b.accountId ||
    a.itemId - b.itemId
  );
}
