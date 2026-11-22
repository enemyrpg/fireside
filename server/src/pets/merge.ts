import { CLOG_ALL_PETS_PAGE, isNewPetMessage } from '@fireside/shared';
import { and, asc, eq, isNotNull } from 'drizzle-orm';
import type { Queryable } from '../db/index.js';
import { accountPets, clogItems, clogObtained, petDrops } from '../db/schema.js';
import { invalidateWeeksFrom } from '../projections/weekly-summaries.js';

// `account_pets`: the pets an account has, merged from two sources:
// - the collection log page "All Pets" (`clog_items` and `clog_obtained`);
// - `pet_drops`, one row per `pet.drop` event.
//
// An account has a few dozen pets at most, so its rows are rebuilt in full
// whenever either source changes. The result only depends on what the two
// sources hold, never on the order things arrived in.
//
// The weekly summary shows the pets obtained in a week, so every change here
// deletes the stored weeks it can affect (`invalidateWeeksFrom`).

type AccountPetRow = typeof accountPets.$inferInsert;

/**
 * The earliest `obtainedAt`, old or new, of the pets that differ between
 * `before` and `after`. `undefined` when no pet with a time changed.
 */
export function earliestPetChange(
  before: readonly AccountPetRow[],
  after: readonly AccountPetRow[],
): string | undefined {
  const key = (pet: AccountPetRow | undefined) =>
    pet &&
    JSON.stringify([
      pet.name,
      pet.obtainedAt ?? null,
      pet.approximate,
      pet.sourceType ?? null,
      pet.sourceName ?? null,
      pet.confirmed,
      pet.origin,
    ]);
  const old = new Map(before.map((pet) => [pet.petItemId, pet]));
  const now = new Map(after.map((pet) => [pet.petItemId, pet]));
  let earliest: string | undefined;
  for (const itemId of new Set([...old.keys(), ...now.keys()])) {
    const [a, b] = [old.get(itemId), now.get(itemId)];
    if (key(a) === key(b)) continue;
    for (const at of [a?.obtainedAt, b?.obtainedAt]) {
      if (at != null && (earliest === undefined || at < earliest)) earliest = at;
    }
  }
  return earliest;
}

/** Rebuilds one account's `account_pets` rows from both sources. */
export function refreshAccountPets(tx: Queryable, accountId: number): void {
  const pets = new Map<number, AccountPetRow>();

  // Collection log: pets on "All Pets" that the account has had.
  const fromClog = tx
    .select({
      itemId: clogItems.itemId,
      name: clogItems.name,
      firstSeenAt: clogObtained.firstSeenAt,
      approximate: clogObtained.approximate,
    })
    .from(clogItems)
    .innerJoin(
      clogObtained,
      and(
        eq(clogObtained.accountId, clogItems.accountId),
        eq(clogObtained.itemId, clogItems.itemId),
      ),
    )
    .where(and(eq(clogItems.accountId, accountId), eq(clogItems.page, CLOG_ALL_PETS_PAGE)))
    .all();
  for (const pet of fromClog) {
    pets.set(pet.itemId, {
      accountId,
      petItemId: pet.itemId,
      name: pet.name,
      obtainedAt: pet.firstSeenAt,
      approximate: pet.approximate,
      sourceType: null,
      sourceName: null,
      confirmed: true,
      origin: 'CLOG',
      eventId: null,
    });
  }

  // Chat: the earliest drop of each guessed pet. A duplicate message is a pet
  // the account already had, and a drop without a guess has no pet to show.
  const drops = tx
    .select()
    .from(petDrops)
    .where(and(eq(petDrops.accountId, accountId), isNotNull(petDrops.petItemId)))
    .orderBy(asc(petDrops.occurredAt), asc(petDrops.eventId))
    .all();
  const seen = new Set<number>();
  for (const drop of drops) {
    if (drop.petItemId === null || !isNewPetMessage(drop.message)) continue;
    if (seen.has(drop.petItemId)) continue;
    seen.add(drop.petItemId);
    const inClog = pets.get(drop.petItemId);
    pets.set(drop.petItemId, {
      accountId,
      petItemId: drop.petItemId,
      // The collection log's name when it has the pet, else the plugin's.
      name: inClog?.name ?? drop.petName ?? 'Unknown',
      // The chat message has the exact time.
      obtainedAt: drop.occurredAt,
      approximate: false,
      sourceType: drop.sourceType,
      sourceName: drop.sourceName,
      confirmed: inClog !== undefined,
      origin: 'CHAT',
      eventId: drop.eventId,
    });
  }

  const before = tx.select().from(accountPets).where(eq(accountPets.accountId, accountId)).all();
  tx.delete(accountPets).where(eq(accountPets.accountId, accountId)).run();
  if (pets.size > 0)
    tx.insert(accountPets)
      .values([...pets.values()])
      .run();
  // A pet that appeared, went away or changed moves in or out of a week.
  const changedFrom = earliestPetChange(before, [...pets.values()]);
  if (changedFrom !== undefined) invalidateWeeksFrom(tx, accountId, changedFrom);
}

/**
 * Rebuilds `account_pets` for every account that has pets or pet drops. For
 * when a whole source was emptied (a collection log rebuild).
 */
export function refreshAllAccountPets(tx: Queryable): void {
  const ids = new Set([
    ...tx
      .selectDistinct({ id: accountPets.accountId })
      .from(accountPets)
      .all()
      .map((row) => row.id),
    ...tx
      .selectDistinct({ id: petDrops.accountId })
      .from(petDrops)
      .all()
      .map((row) => row.id),
  ]);
  for (const id of [...ids].sort((a, b) => a - b)) refreshAccountPets(tx, id);
}

/** `account_pets` in a fixed order, for comparing in tests. */
export function accountPetsSnapshot(db: Queryable) {
  return db
    .select()
    .from(accountPets)
    .orderBy(asc(accountPets.accountId), asc(accountPets.petItemId))
    .all();
}
