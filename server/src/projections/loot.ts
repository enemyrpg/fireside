import type { LootEvent, LootItem } from '@fireside/shared';
import { asc, eq } from 'drizzle-orm';
import type { Queryable } from '../db/index.js';
import { accounts, lootEvents, lootItems } from '../db/schema.js';
import type { Projection, Stored } from './framework.js';
import { accountIdOf } from './lookup.js';

// `loot_events` and `loot_items`. Keyed insert: one loot event per `loot` event.
// The KC observation a loot event with `killCount` gives is made by the kc
// projection.

/**
 * Sum of price × quantity, for GE and high alchemy prices. Throws if a total
 * is too large to store exactly, so the event fails instead of storing a
 * rounded value. All terms are ≥ 0, so checking the sums is enough.
 */
export function lootTotals(items: readonly LootItem[]): {
  totalGeValue: number;
  totalHaValue: number;
} {
  let totalGeValue = 0;
  let totalHaValue = 0;
  for (const item of items) {
    totalGeValue += item.gePrice * item.quantity;
    totalHaValue += item.haPrice * item.quantity;
  }
  if (!Number.isSafeInteger(totalGeValue) || !Number.isSafeInteger(totalHaValue)) {
    throw new Error('loot value too large to store exactly');
  }
  return { totalGeValue, totalHaValue };
}

function applyLoot(tx: Queryable, event: Stored<LootEvent>): void {
  const { source, items, killCount } = event.payload;
  const lootEvent = tx
    .insert(lootEvents)
    .values({
      accountId: accountIdOf(tx, event),
      sessionId: event.sessionId,
      eventId: event.eventId,
      occurredAt: event.occurredAt,
      sourceType: source.type,
      // `null` for PLAYER loot: we never store data about other players.
      sourceName: source.name,
      sourceNpcId: source.type === 'NPC' ? (source.npcId ?? null) : null,
      killCount: killCount ?? null,
      ...lootTotals(items),
    })
    .returning({ id: lootEvents.id })
    .get();

  tx.insert(lootItems)
    .values(
      items.map((item, position) => ({
        lootEventId: lootEvent.id,
        position,
        itemId: item.itemId,
        itemName: item.name,
        quantity: item.quantity,
        gePriceEach: item.gePrice,
        haPriceEach: item.haPrice,
      })),
    )
    .run();
}

export const lootProjection: Projection = {
  name: 'loot',

  apply(tx, event) {
    if (event.type === 'loot') applyLoot(tx, event);
  },

  reset(tx) {
    tx.delete(lootItems).run();
    tx.delete(lootEvents).run();
  },

  snapshot(db) {
    const lootRows = db
      .select({
        userId: accounts.userId,
        accountHash: accounts.accountHash,
        eventId: lootEvents.eventId,
        sessionId: lootEvents.sessionId,
        occurredAt: lootEvents.occurredAt,
        sourceType: lootEvents.sourceType,
        sourceName: lootEvents.sourceName,
        sourceNpcId: lootEvents.sourceNpcId,
        killCount: lootEvents.killCount,
        totalGeValue: lootEvents.totalGeValue,
        totalHaValue: lootEvents.totalHaValue,
      })
      .from(lootEvents)
      .innerJoin(accounts, eq(lootEvents.accountId, accounts.id))
      .orderBy(
        asc(accounts.userId),
        asc(accounts.accountHash),
        asc(lootEvents.occurredAt),
        asc(lootEvents.eventId),
      )
      .all();
    const items = db
      .select({
        eventId: lootEvents.eventId,
        position: lootItems.position,
        itemId: lootItems.itemId,
        itemName: lootItems.itemName,
        quantity: lootItems.quantity,
        gePriceEach: lootItems.gePriceEach,
        haPriceEach: lootItems.haPriceEach,
      })
      .from(lootItems)
      .innerJoin(lootEvents, eq(lootItems.lootEventId, lootEvents.id))
      .orderBy(asc(lootEvents.eventId), asc(lootItems.position))
      .all();
    return { lootEvents: lootRows, lootItems: items };
  },
};
