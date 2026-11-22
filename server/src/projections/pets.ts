import { asc, eq } from 'drizzle-orm';
import { accountIds, accountPets, accounts, petDrops } from '../db/schema.js';
import { refreshAccountPets } from '../pets/merge.js';
import type { Projection } from './framework.js';
import { accountIdOf } from './lookup.js';

// `pet_drops` and `account_pets`. Keyed insert: one `pet_drops` row per
// `pet.drop` event. The account's `account_pets` rows are then rebuilt from all
// its drops and its collection log (server/src/pets/merge.ts), so the order of
// arrival does not matter.

export const petsProjection: Projection = {
  name: 'pets',

  apply(tx, event) {
    if (event.type !== 'pet.drop') return;
    const { message, guessedPet, guessedSource } = event.payload;
    const accountId = accountIdOf(tx, event);
    tx.insert(petDrops)
      .values({
        accountId,
        sessionId: event.sessionId,
        eventId: event.eventId,
        occurredAt: event.occurredAt,
        message,
        petItemId: guessedPet?.itemId ?? null,
        petName: guessedPet?.name ?? null,
        sourceType: guessedSource?.type ?? null,
        sourceName: guessedSource?.name ?? null,
      })
      .run();
    refreshAccountPets(tx, accountId);
  },

  reset(tx) {
    // Pets known only from the collection log come back when the collection
    // log is rebuilt, right after the events (server/src/admin/rebuild.ts).
    tx.delete(accountPets).run();
    tx.delete(petDrops).run();
  },

  snapshot(db) {
    return {
      drops: db
        .select({
          userId: accounts.userId,
          accountHash: accounts.accountHash,
          eventId: petDrops.eventId,
          sessionId: petDrops.sessionId,
          occurredAt: petDrops.occurredAt,
          message: petDrops.message,
          petItemId: petDrops.petItemId,
          petName: petDrops.petName,
          sourceType: petDrops.sourceType,
          sourceName: petDrops.sourceName,
        })
        .from(petDrops)
        .innerJoin(accounts, eq(petDrops.accountId, accounts.id))
        .orderBy(
          asc(accounts.userId),
          asc(accounts.accountHash),
          asc(petDrops.occurredAt),
          asc(petDrops.eventId),
        )
        .all(),
      pets: db
        .select({
          userId: accountIds.userId,
          accountHash: accountIds.accountHash,
          petItemId: accountPets.petItemId,
          name: accountPets.name,
          obtainedAt: accountPets.obtainedAt,
          approximate: accountPets.approximate,
          sourceType: accountPets.sourceType,
          sourceName: accountPets.sourceName,
          confirmed: accountPets.confirmed,
          origin: accountPets.origin,
          eventId: accountPets.eventId,
        })
        .from(accountPets)
        .innerJoin(accountIds, eq(accountPets.accountId, accountIds.id))
        .orderBy(asc(accountIds.userId), asc(accountIds.accountHash), asc(accountPets.petItemId))
        .all(),
    };
  },
};
