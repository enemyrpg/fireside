import { and, eq, inArray, isNotNull, isNull, notExists, or, sql } from 'drizzle-orm';
import type { Queryable } from '../db/index.js';
import { events, raidDropChoices, raidSpecialLoot } from '../db/schema.js';

// Keeps the user's split choices (`raid_drop_choices`) on the drop they were
// made for, as drops change keys. Choices are typed by the user and can't be
// rebuilt, so nothing here removes a value the user typed, except a choice
// whose drop is definitely gone (see `deleteOrphanedChoices`). Never logs any
// text from a choice: nicknames are about other players (ADR 0006).
//
// A detected purple is keyed by its `raid.special_loot` event (index 0), or,
// while only the chest is known, by the chest's `loot` event and the item's
// position. Once a purple has its own event, a choice under its chest key is
// moved to the event key ("settled"). From then on it no longer depends on
// which chest the event is matched with. See docs/architecture.md#raid-split-choices.

type ChoiceRow = typeof raidDropChoices.$inferSelect;

/** A special loot row's keys, as far as it has them. */
export interface DropKeys {
  specialEventId?: string | null | undefined;
  lootEventId?: string | null | undefined;
  lootItemPosition?: number | null | undefined;
}

/**
 * The event row merged with the chest row, field by field: the value of the
 * row changed last wins (the event row on a tie), but an empty field never
 * replaces a filled one.
 */
export function mergeChoices(eventRow: ChoiceRow, chestRow: ChoiceRow): ChoiceRow {
  const chestNewer = chestRow.updatedAt > eventRow.updatedAt;
  const [newer, older] = chestNewer ? [chestRow, eventRow] : [eventRow, chestRow];
  return {
    eventId: eventRow.eventId,
    itemIndex: eventRow.itemIndex,
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
 * Moves the chest key's choices of one drop to its event key, merging with
 * choices already there. Returns true if a row was moved or merged.
 */
export function settleDrop(tx: Queryable, drop: DropKeys): boolean {
  const { specialEventId, lootEventId, lootItemPosition } = drop;
  if (specialEventId == null || lootEventId == null || lootItemPosition == null) return false;
  const chest = rowAt(tx, lootEventId, lootItemPosition);
  if (!chest) return false;
  const existing = rowAt(tx, specialEventId, 0);
  const target: ChoiceRow = existing
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
  const { eventId, itemIndex, ...values } = target;
  tx.insert(raidDropChoices)
    .values({ eventId, itemIndex, ...values })
    .onConflictDoUpdate({
      target: [raidDropChoices.eventId, raidDropChoices.itemIndex],
      set: values,
    })
    .run();
  return true;
}

/** Settles every given drop. Returns how many choice rows moved. */
export function settleDrops(tx: Queryable, drops: readonly DropKeys[]): number {
  let moved = 0;
  for (const drop of drops) if (settleDrop(tx, drop)) moved += 1;
  return moved;
}

const dropKeyColumns = {
  specialEventId: raidSpecialLoot.specialEventId,
  lootEventId: raidSpecialLoot.lootEventId,
  lootItemPosition: raidSpecialLoot.lootItemPosition,
};

/** The keys of one session's special loot rows as they are now. */
export function sessionDropKeys(tx: Queryable, accountId: number, sessionId: string): DropKeys[] {
  return tx
    .select(dropKeyColumns)
    .from(raidSpecialLoot)
    .where(and(eq(raidSpecialLoot.accountId, accountId), eq(raidSpecialLoot.sessionId, sessionId)))
    .all();
}

/**
 * Settles every drop that has both keys and a choice under its chest key.
 * Returns how many choice rows moved.
 */
export function settleAllChoices(tx: Queryable): number {
  const chestKeyed = tx.select({ eventId: raidDropChoices.eventId }).from(raidDropChoices);
  const drops = tx
    .select(dropKeyColumns)
    .from(raidSpecialLoot)
    .where(
      and(
        isNotNull(raidSpecialLoot.specialEventId),
        inArray(raidSpecialLoot.lootEventId, chestKeyed),
      ),
    )
    .all();
  return settleDrops(tx, drops);
}

/**
 * Deletes the choices of drops that are definitely gone: their raw event was
 * projected without an error, and no special loot row has their key (as an
 * event key or a chest key). A failed or pending event never loses its
 * choices: they show again once it is projected. Call it only after settling,
 * so a drop that changed keys is never taken for a gone one. Returns how many
 * rows were deleted.
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

/** Settles every choice, then deletes the orphaned ones. For after a full replay or a retry. */
export function tidyChoices(tx: Queryable): { moved: number; deleted: number } {
  const moved = settleAllChoices(tx);
  const deleted = deleteOrphanedChoices(tx);
  return { moved, deleted };
}
