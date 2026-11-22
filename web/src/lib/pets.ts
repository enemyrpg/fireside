import { comparePets, type Pet } from '@fireside/shared';
import { formatCompact, formatInt, formatLocalDateLong, formatSkill, localDateIn } from '@/format';

// Rules of the Pets page: a trophy case of the pets an account has. The API
// gives them newest first; the order for A–Z and what a card says live here.
// Pets are never added or removed by hand.

/** Path of the Pets page below `/:acc` (also in the page registry). */
export const PETS_PAGE_PATH = 'collections/pets';

/** `?sort=`: newest first (the default, left out of the URL) or by name. */
export type PetSort = 'new' | 'az';

/** The order of `?sort=`. A missing or unknown value is newest first. */
export function parsePetSort(param: string | null): PetSort {
  return param === 'az' ? 'az' : 'new';
}

/** Link to the Pets page of an account or `all`. */
export function petsHref(scope: string | number, sort: PetSort = 'new'): string {
  return `/${String(scope)}/${PETS_PAGE_PATH}${sort === 'new' ? '' : `?sort=${sort}`}`;
}

/**
 * The pets in the chosen order. `new`: newest first, pets without a time last
 * by name (the API's own order, `comparePets`). `az`: by name without regard
 * to case; the same pet on several accounts in the order of `new`.
 */
export function sortPets(pets: readonly Pet[], sort: PetSort): Pet[] {
  const sorted = [...pets].sort(comparePets);
  if (sort === 'new') return sorted;
  // The sort is stable, so equal names keep the order of `new`.
  return sorted.sort((a, b) => {
    const left = a.name.toLowerCase();
    const right = b.name.toLowerCase();
    return left === right ? 0 : left < right ? -1 : 1;
  });
}

/**
 * Where the pet came from, with the KC or XP at the time when that is known:
 * "Vorkath · 1,204 KC", "Woodcutting · 9.84M XP", "Vorkath". `null` without a source.
 */
export function petDetail(pet: Pick<Pet, 'source' | 'killCount' | 'xp'>): string | null {
  if (pet.source === null) return null;
  const name = pet.source.type === 'SKILL' ? formatSkill(pet.source.name) : pet.source.name;
  if (pet.killCount !== null) return `${name} · ${formatInt(pet.killCount)} KC`;
  if (pet.xp !== null) return `${name} · ${formatCompact(pet.xp)} XP`;
  return name;
}

/**
 * The day the pet came, always with the year: "Mon 2 Nov 2026". With "~" in
 * front when it is the sync that found the pet, not the drop. `null` when the
 * time is not known.
 */
export function petDate(
  pet: Pick<Pet, 'obtainedAt' | 'approximate'>,
  timeZone: string,
): string | null {
  if (pet.obtainedAt === null) return null;
  const date = formatLocalDateLong(localDateIn(pet.obtainedAt, timeZone));
  return pet.approximate ? `~${date}` : date;
}

/** The word after the count: "8 pets", "1 pet". */
export function petNoun(count: number): string {
  return count === 1 ? 'pet' : 'pets';
}
