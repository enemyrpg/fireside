import { comparePets, normalizeBossName, type Pet, type PetsResponse } from '@fireside/shared';
import { and, asc, desc, eq, gt, inArray, lte } from 'drizzle-orm';
import type { Queryable } from '../db/index.js';
import {
  accountPets,
  accounts,
  kcObservations,
  xpSnapshots,
  xpSnapshotSkills,
} from '../db/schema.js';

// `GET …/pets`. Reads `account_pets`, and the KC or XP at the time of a chat
// drop from `kc_observations` and `xp_snapshots`. Those are looked up here, not
// stored with the pet, so a `kc` event that arrives late is still found.

/**
 * How long after the pet message a KC still counts as the kill that dropped
 * the pet: the game can show the KC line just after the pet line.
 */
export const PET_KC_GRACE_MS = 2000;

/** The account's KC for `boss` when the pet dropped, or `null` if it has none by then. */
function killCountAt(db: Queryable, accountId: number, boss: string, at: string): number | null {
  const until = new Date(new Date(at).getTime() + PET_KC_GRACE_MS).toISOString();
  return (
    db
      .select({ killCount: kcObservations.killCount })
      .from(kcObservations)
      .where(
        and(
          eq(kcObservations.accountId, accountId),
          eq(kcObservations.boss, normalizeBossName(boss)),
          lte(kcObservations.observedAt, until),
        ),
      )
      .orderBy(desc(kcObservations.observedAt), desc(kcObservations.eventId))
      .limit(1)
      .get()?.killCount ?? null
  );
}

/**
 * The account's XP in `skill` when the pet dropped: from the last snapshot
 * at or before the drop (snapshots are up to five minutes apart), else from
 * the first one after it. `null` when no snapshot has the skill.
 */
function xpAt(db: Queryable, accountId: number, skill: string, at: string): number | null {
  const snapshot =
    db
      .select({ id: xpSnapshots.id })
      .from(xpSnapshots)
      .where(and(eq(xpSnapshots.accountId, accountId), lte(xpSnapshots.takenAt, at)))
      .orderBy(desc(xpSnapshots.takenAt), desc(xpSnapshots.eventId))
      .limit(1)
      .get() ??
    db
      .select({ id: xpSnapshots.id })
      .from(xpSnapshots)
      .where(and(eq(xpSnapshots.accountId, accountId), gt(xpSnapshots.takenAt, at)))
      .orderBy(asc(xpSnapshots.takenAt), asc(xpSnapshots.eventId))
      .limit(1)
      .get();
  if (!snapshot) return null;
  return (
    db
      .select({ xp: xpSnapshotSkills.xp })
      .from(xpSnapshotSkills)
      .where(and(eq(xpSnapshotSkills.snapshotId, snapshot.id), eq(xpSnapshotSkills.skill, skill)))
      .get()?.xp ?? null
  );
}

export type AccountPetRow = typeof accountPets.$inferSelect;

/**
 * One `account_pets` row as the API shows it, with the KC or XP at the drop
 * looked up now. The Pets page and the weekly summary both use it, so they
 * always show the same numbers.
 */
export function petOf(db: Queryable, pet: AccountPetRow): Pet {
  const source =
    pet.sourceType !== null && pet.sourceName !== null
      ? { type: pet.sourceType, name: pet.sourceName }
      : null;
  // Only a chat drop has an exact time to look up.
  const at = pet.origin === 'CHAT' ? pet.obtainedAt : null;
  return {
    accountId: pet.accountId,
    itemId: pet.petItemId,
    name: pet.name,
    obtainedAt: pet.obtainedAt,
    approximate: pet.approximate,
    source,
    killCount:
      source?.type === 'ACTIVITY' && at !== null
        ? killCountAt(db, pet.accountId, source.name, at)
        : null,
    xp: source?.type === 'SKILL' && at !== null ? xpAt(db, pet.accountId, source.name, at) : null,
    confirmed: pet.confirmed,
    origin: pet.origin,
  };
}

/** Every pet of the given (owned) accounts: newest first, pets without a time last. */
export function pets(db: Queryable, accountIds: readonly number[]): PetsResponse {
  const rows = db
    .select({ pet: accountPets })
    .from(accountPets)
    // Only accounts with projected events are shown anywhere in the dashboard.
    .innerJoin(accounts, eq(accounts.id, accountPets.accountId))
    .where(inArray(accountPets.accountId, accountIds))
    .all();
  return { pets: rows.map(({ pet }) => petOf(db, pet)).sort(comparePets) };
}
