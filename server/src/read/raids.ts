import {
  normalizeBossName,
  raidOf,
  RAIDS,
  type Page,
  type RaidLootRecipient,
  type RaidSummary,
  type SpecialLootItem,
} from '@fireside/shared';
import { and, asc, count, desc, eq, inArray, isNotNull, lt, or, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import type { Queryable } from '../db/index.js';
import { lootEvents, lootItems, raidSpecialLoot } from '../db/schema.js';
import { lootWhere } from './loot.js';
import { capLootValue } from '../projections/session-summaries.js';
import { cursorParts, decodeCursor, encodeCursor } from './cursor.js';

// `GET …/raids`. Reads only `loot_events`, `loot_items` and
// `raid_special_loot`.
//
// Each own purple counts once. A purple linked to a chest item is taken out
// of the raid's loot value and put in its special loot value, both at the
// chest item's value, so the two add up to the raid's loot in `loot`. An own
// purple without a chest item only counts as special loot (at the event's
// value). Teammates' purples never count.

/** `raid_special_loot` rows of the given (owned) accounts. */
export function specialScope(accountIds: readonly number[]): SQL {
  return inArray(raidSpecialLoot.accountId, accountIds);
}

// The chest item a purple is linked to. Joined with LEFT JOIN everywhere, so
// the sums and the list read the same rows: a purple whose chest item is
// missing falls back to the `raid.special_loot` event's values in both.
export const chestEvent = eq(lootEvents.eventId, raidSpecialLoot.lootEventId);
export const chestItem = and(
  eq(lootItems.lootEventId, lootEvents.id),
  eq(lootItems.position, raidSpecialLoot.lootItemPosition),
);
export const purpleQuantity = sql<number>`coalesce(${lootItems.quantity}, ${raidSpecialLoot.quantity})`;
export const purpleGePrice = sql<number>`coalesce(${lootItems.gePriceEach}, ${raidSpecialLoot.gePriceEach})`;

/** Loot count and value per raid, without own purples, and own purple value per raid. */
export function raidSummaries(db: Queryable, accountIds: readonly number[]): RaidSummary[] {
  const byRaid = new Map(
    RAIDS.map((raid) => [raid.name, { lootCount: 0, lootGeValue: 0, specialLootGeValue: 0 }]),
  );

  // Raid loot by source name, as stored; normalized and grouped here, like
  // the special loot projection does. PLAYER loot has no name.
  const sources = db
    .select({
      name: lootEvents.sourceName,
      lootCount: count(),
      geValue: sql<number>`total(${lootEvents.totalGeValue})`,
    })
    .from(lootEvents)
    .where(and(isNotNull(lootEvents.sourceName), ...lootWhere({ accountIds })))
    .groupBy(lootEvents.sourceName)
    .all();
  for (const source of sources) {
    if (source.name === null) continue;
    const raid = raidOf(normalizeBossName(source.name));
    const sums = raid && byRaid.get(raid.name);
    if (!sums) continue;
    sums.lootCount += source.lootCount;
    sums.lootGeValue += source.geValue;
  }

  // Own purples. A linked purple moves from loot to special loot at the
  // chest item's value; one without a chest item only adds to special loot.
  const own = db
    .select({
      raidGroup: raidSpecialLoot.raidGroup,
      linkedGeValue: sql<number>`total(case when ${lootItems.lootEventId} is not null then ${lootItems.quantity} * ${lootItems.gePriceEach} end)`,
      geValue: sql<number>`total(${purpleQuantity} * ${purpleGePrice})`,
    })
    .from(raidSpecialLoot)
    .leftJoin(lootEvents, chestEvent)
    .leftJoin(lootItems, chestItem)
    .where(
      and(
        specialScope(accountIds),
        eq(raidSpecialLoot.recipient, 'SELF' satisfies RaidLootRecipient),
      ),
    )
    .groupBy(raidSpecialLoot.raidGroup)
    .all();
  for (const row of own) {
    const sums = byRaid.get(row.raidGroup);
    if (!sums) continue;
    sums.lootGeValue -= row.linkedGeValue;
    sums.specialLootGeValue += row.geValue;
  }

  return RAIDS.map((raid) => {
    const sums = byRaid.get(raid.name) ?? { lootCount: 0, lootGeValue: 0, specialLootGeValue: 0 };
    return {
      raid: raid.name,
      lootCount: sums.lootCount,
      lootGeValue: capLootValue(Math.max(0, sums.lootGeValue)),
      specialLootGeValue: capLootValue(sums.specialLootGeValue),
    };
  });
}

// --- Special loot list --------------------------------------------------------

/**
 * Cursor key: (`occurred_at`, event ID, index). The event ID is the
 * `raid.special_loot` event, or the chest's loot event for a purple without
 * one; the index is then the item's position, else 0. Special and loot event
 * IDs never collide, so the key is unique and has no row IDs.
 */
const specialCursorSchema = z.tuple([
  cursorParts.timestamp,
  cursorParts.eventId,
  cursorParts.index,
]);

export interface SpecialLootOptions {
  /** The accounts to read: owned account IDs, resolved by the route. */
  accountIds: readonly number[];
  cursor?: string | undefined;
  limit: number;
}

/** Every purple (own and teammates'), newest first. Linked purples show the chest item. */
export function specialLoot(db: Queryable, options: SpecialLootOptions): Page<SpecialLootItem> {
  const keyId = sql<string>`coalesce(${raidSpecialLoot.specialEventId}, ${raidSpecialLoot.lootEventId})`;
  const keyIndex = sql<number>`case when ${raidSpecialLoot.specialEventId} is null then ${raidSpecialLoot.lootItemPosition} else 0 end`;

  const conditions: (SQL | undefined)[] = [specialScope(options.accountIds)];
  if (options.cursor !== undefined) {
    const [at, eventId, index] = decodeCursor(options.cursor, specialCursorSchema);
    conditions.push(
      or(
        lt(raidSpecialLoot.occurredAt, at),
        and(eq(raidSpecialLoot.occurredAt, at), sql`${keyId} < ${eventId}`),
        and(
          eq(raidSpecialLoot.occurredAt, at),
          sql`${keyId} = ${eventId}`,
          sql`${keyIndex} > ${index}`,
        ),
      ),
    );
  }

  const rows = db
    .select({
      occurredAt: raidSpecialLoot.occurredAt,
      accountId: raidSpecialLoot.accountId,
      sessionId: raidSpecialLoot.sessionId,
      raid: raidSpecialLoot.raid,
      raidGroup: raidSpecialLoot.raidGroup,
      itemId: raidSpecialLoot.itemId,
      name: raidSpecialLoot.itemName,
      // The chest item for a linked purple, so the list matches the sums.
      quantity: purpleQuantity,
      gePriceEach: purpleGePrice,
      recipient: raidSpecialLoot.recipient,
      teamSize: raidSpecialLoot.teamSize,
      killCount: raidSpecialLoot.killCount,
      keyId,
      keyIndex,
    })
    .from(raidSpecialLoot)
    .leftJoin(lootEvents, chestEvent)
    .leftJoin(lootItems, chestItem)
    .where(and(...conditions))
    .orderBy(desc(raidSpecialLoot.occurredAt), desc(keyId), asc(keyIndex))
    .limit(options.limit + 1)
    .all();

  const page = rows.slice(0, options.limit);
  const last = page.at(-1);
  return {
    items: page.map((row) => ({
      occurredAt: row.occurredAt,
      accountId: row.accountId,
      sessionId: row.sessionId,
      raid: row.raid,
      raidGroup: row.raidGroup,
      itemId: row.itemId,
      name: row.name,
      quantity: row.quantity,
      gePriceEach: row.gePriceEach,
      // Exact for chest items (the loot projection rejects unsafe totals). A
      // `raid.special_loot` item has no such check, so it is capped like the
      // sums (the schema allows the cap).
      geValue: capLootValue(row.quantity * row.gePriceEach),
      recipient: row.recipient as RaidLootRecipient,
      teamSize: row.teamSize,
      killCount: row.killCount,
    })),
    nextCursor:
      rows.length > options.limit && last
        ? encodeCursor([last.occurredAt, last.keyId, last.keyIndex])
        : null,
  };
}
