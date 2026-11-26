import { and, eq, inArray, isNotNull, isNull, notExists, or, sql } from 'drizzle-orm';
import type { Queryable } from '../db/index.js';
import { events, raidDropChoices, raidSpecialLoot } from '../db/schema.js';

// The keys of the user's split choices (`raid_drop_choices`). Choices are
// typed by the user and can't be rebuilt, so nothing here edits what the user
// typed, and only a choice whose drop is definitely gone is ever deleted
// (`deleteOrphanedChoices`). Never logs any text from a choice: nicknames are
// about other players. See docs/decisions/0020-raid-split-choice-keys.md.
//
// A detected purple is keyed by its `raid.special_loot` event (index 0), or,
// for a purple known only from the chest, by the chest's `loot` event and the
// item's position. Which chest a `SELF` event is matched with can change while
// events arrive, so choices never move on ingest, retry or rebuild: a drop
// reads both its keys and merges them (`mergeChoices`). Only the owner's edit
// collapses them into one row under the event key (raids/choices.ts), and the
// one-time upgrade to nearest-chest matching moves them before re-matching
// (`settleAllChoices`).

export type ChoiceRow = typeof raidDropChoices.$inferSelect;

/**
 * Two rows of one drop, merged field by field: the row changed last wins
 * (`preferred` on a tie), but an empty field never replaces a filled one. Only
 * for rows the owner has not edited together: an edit collapses them.
 */
export function mergeChoices(preferred: ChoiceRow, other: ChoiceRow): ChoiceRow {
  const [newer, older] =
    other.updatedAt > preferred.updatedAt ? [other, preferred] : [preferred, other];
  return {
    eventId: preferred.eventId,
    itemIndex: preferred.itemIndex,
    mode: newer.mode ?? older.mode,
    ownValue: newer.ownValue ?? older.ownValue,
    partySize: newer.partySize ?? older.partySize,
    nickname: newer.nickname ?? older.nickname,
    note: newer.note ?? older.note,
    updatedAt: newer.updatedAt,
  };
}

function rowAt(tx: Queryable, eventId: string, itemIndex: number): ChoiceRow | undefined {
  return tx
    .select()
    .from(raidDropChoices)
    .where(and(eq(raidDropChoices.eventId, eventId), eq(raidDropChoices.itemIndex, itemIndex)))
    .get();
}

/**
 * Moves every chest-key row whose drop has its own event to that event key
 * (merged with a row already there), with the special loot rows as they are
 * now. Only for the upgrade to nearest-chest matching, before re-matching: it
 * keeps each choice on the drop the owner saw. Returns how many rows moved.
 */
export function settleAllChoices(tx: Queryable): number {
  const keyed = tx.select({ eventId: raidDropChoices.eventId }).from(raidDropChoices);
  const drops = tx
    .select({
      specialEventId: raidSpecialLoot.specialEventId,
      lootEventId: raidSpecialLoot.lootEventId,
      lootItemPosition: raidSpecialLoot.lootItemPosition,
    })
    .from(raidSpecialLoot)
    .where(
      and(isNotNull(raidSpecialLoot.specialEventId), inArray(raidSpecialLoot.lootEventId, keyed)),
    )
    .all();
  let moved = 0;
  for (const { specialEventId, lootEventId, lootItemPosition } of drops) {
    if (specialEventId === null || lootEventId === null || lootItemPosition === null) continue;
    const chest = rowAt(tx, lootEventId, lootItemPosition);
    if (!chest) continue;
    const existing = rowAt(tx, specialEventId, 0);
    const { eventId, itemIndex, ...values } = existing
      ? mergeChoices(existing, chest)
      : { ...chest, eventId: specialEventId, itemIndex: 0 };
    tx.delete(raidDropChoices)
      .where(
        and(
          eq(raidDropChoices.eventId, lootEventId),
          eq(raidDropChoices.itemIndex, lootItemPosition),
        ),
      )
      .run();
    tx.insert(raidDropChoices)
      .values({ eventId, itemIndex, ...values })
      .onConflictDoUpdate({
        target: [raidDropChoices.eventId, raidDropChoices.itemIndex],
        set: values,
      })
      .run();
    moved += 1;
  }
  return moved;
}

/**
 * Deletes the choices of drops that are definitely gone: their raw event was
 * projected without an error, and no special loot row has their key, as an
 * event key or as a chest key (a chest matched with an event still shows its
 * row). A failed or pending event never loses its choices: they show again
 * once it is projected. Returns how many rows were deleted.
 */
export function deleteOrphanedChoices(tx: Queryable): number {
  const c = raidDropChoices;
  const r = raidSpecialLoot;
  const projected = tx
    .select({ eventId: events.eventId })
    .from(events)
    .where(and(isNotNull(events.processedAt), isNull(events.projectionError)));
  const shown = tx
    .select({ one: sql`1` })
    .from(r)
    .where(
      or(
        and(eq(r.specialEventId, c.eventId), eq(c.itemIndex, 0)),
        and(eq(r.lootEventId, c.eventId), eq(r.lootItemPosition, c.itemIndex)),
      ),
    );
  return tx
    .delete(c)
    .where(and(inArray(c.eventId, projected), notExists(shown)))
    .run().changes;
}
