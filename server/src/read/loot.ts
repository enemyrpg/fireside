import {
  periodAt,
  periodKey,
  type ApiLootSource,
  type Drop,
  type LootDayGroup,
  type LootItemTotal,
  type LootSourceGroup,
  type LootTotals,
  type Page,
} from '@fireside/shared';
import { and, asc, count, desc, eq, gte, inArray, lt, or, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import type { Queryable } from '../db/index.js';
import { lootEvents, lootItems } from '../db/schema.js';
import { capLootValue } from '../projections/session-summaries.js';
import { cursorParts, decodeCursor, encodeCursor } from './cursor.js';

// `GET …/loot` and `…/loot/drops`. Reads only `loot_events` and `loot_items`.
//
// Sums use SQLite `total()` (a float sum that never overflows) and are capped
// at the largest exact integer, like session summaries.

export interface LootFilter {
  /** The accounts to read: owned account IDs, resolved by the route. */
  accountIds: readonly number[];
  /** Half-open `[from, to)` in UTC. Either end may be open. */
  from?: string | undefined;
  to?: string | undefined;
}

/** WHERE conditions on `loot_events` for the accounts and time range. */
export function lootWhere({ accountIds, from, to }: LootFilter): SQL[] {
  const conditions: SQL[] = [inArray(lootEvents.accountId, accountIds)];
  if (from !== undefined) conditions.push(gte(lootEvents.occurredAt, from));
  if (to !== undefined) conditions.push(lt(lootEvents.occurredAt, to));
  return conditions;
}

/** Loot source in responses. Only PLAYER has no name (never stored). */
export function apiSource(type: string, name: string | null): ApiLootSource {
  if (type === 'PLAYER') return { type: 'PLAYER', name: null };
  return { type: type as Exclude<ApiLootSource['type'], 'PLAYER'>, name: name ?? '' };
}

function emptyTotals(): LootTotals {
  return { lootCount: 0, geValue: 0, haValue: 0 };
}

function addTotals(sum: LootTotals, add: LootTotals): void {
  sum.lootCount += add.lootCount;
  sum.geValue = capLootValue(sum.geValue + add.geValue);
  sum.haValue = capLootValue(sum.haValue + add.haValue);
}

const compareText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

// --- Grouped by source --------------------------------------------------------

/**
 * Loot grouped by source (`source_type`, `source_name` as stored), with items
 * summed per item ID. PLAYER loot has no name and is its own group.
 * Groups and items by GE value, highest first.
 */
export function lootBySource(
  db: Queryable,
  filter: LootFilter,
): { totals: LootTotals; groups: LootSourceGroup[] } {
  const where = and(...lootWhere(filter));
  const groupRows = db
    .select({
      type: lootEvents.sourceType,
      name: lootEvents.sourceName,
      lootCount: count(),
      geValue: sql<number>`total(${lootEvents.totalGeValue})`,
      haValue: sql<number>`total(${lootEvents.totalHaValue})`,
    })
    .from(lootEvents)
    .where(where)
    .groupBy(lootEvents.sourceType, lootEvents.sourceName)
    .all();

  // One max() in the query, so SQLite takes `item_name` from the newest drop
  // of the item. `occurred_at` and `event_id` have fixed widths, so the
  // concatenation sorts like (occurred_at, event_id).
  const itemRows = db
    .select({
      type: lootEvents.sourceType,
      sourceName: lootEvents.sourceName,
      itemId: lootItems.itemId,
      name: lootItems.itemName,
      newest: sql<string>`max(${lootEvents.occurredAt} || ${lootEvents.eventId})`,
      quantity: sql<number>`total(${lootItems.quantity})`,
      geValue: sql<number>`total(${lootItems.quantity} * ${lootItems.gePriceEach})`,
      haValue: sql<number>`total(${lootItems.quantity} * ${lootItems.haPriceEach})`,
    })
    .from(lootItems)
    .innerJoin(lootEvents, eq(lootItems.lootEventId, lootEvents.id))
    .where(where)
    .groupBy(lootEvents.sourceType, lootEvents.sourceName, lootItems.itemId)
    .all();

  const keyOf = (type: string, name: string | null) => JSON.stringify([type, name]);
  const itemsBySource = new Map<string, LootItemTotal[]>();
  for (const row of itemRows) {
    const key = keyOf(row.type, row.sourceName);
    const items = itemsBySource.get(key) ?? [];
    items.push({
      itemId: row.itemId,
      name: row.name,
      quantity: capLootValue(row.quantity),
      geValue: capLootValue(row.geValue),
      haValue: capLootValue(row.haValue),
    });
    itemsBySource.set(key, items);
  }

  const totals = emptyTotals();
  const groups = groupRows.map((row): LootSourceGroup => {
    const values = {
      lootCount: row.lootCount,
      geValue: capLootValue(row.geValue),
      haValue: capLootValue(row.haValue),
    };
    addTotals(totals, values);
    const items = itemsBySource.get(keyOf(row.type, row.name)) ?? [];
    items.sort((a, b) => b.geValue - a.geValue || a.itemId - b.itemId);
    return { source: apiSource(row.type, row.name), ...values, items };
  });
  groups.sort(
    (a, b) =>
      b.geValue - a.geValue ||
      compareText(a.source.type, b.source.type) ||
      // PLAYER (null) never ties with a named source: the types differ.
      compareText(a.source.name ?? '', b.source.name ?? ''),
  );
  return { totals, groups };
}

// --- Grouped by local day -----------------------------------------------------

/** Loot per local date (`timeZone`), oldest first. Days without loot are left out. */
export function lootByDay(
  db: Queryable,
  filter: LootFilter,
  timeZone: string,
): { totals: LootTotals; groups: LootDayGroup[] } {
  const rows = db
    .select({
      occurredAt: lootEvents.occurredAt,
      geValue: lootEvents.totalGeValue,
      haValue: lootEvents.totalHaValue,
    })
    .from(lootEvents)
    .where(and(...lootWhere(filter)))
    .orderBy(asc(lootEvents.occurredAt))
    .all();

  const totals = emptyTotals();
  const groups: LootDayGroup[] = [];
  let day: { end: number; group: LootDayGroup } | undefined;
  for (const row of rows) {
    const ms = Date.parse(row.occurredAt);
    // Rows are sorted, so a new day starts only when we pass the current one's end.
    if (!day || ms >= day.end) {
      const period = periodAt(ms, 'day', timeZone);
      day = { end: period.end, group: { date: periodKey(ms, 'day', timeZone), ...emptyTotals() } };
      groups.push(day.group);
    }
    const values = { lootCount: 1, geValue: row.geValue, haValue: row.haValue };
    addTotals(day.group, values);
    addTotals(totals, values);
  }
  return { totals, groups };
}

// --- Single drops -------------------------------------------------------------

/** Cursor key: the last drop's (`occurred_at`, `event_id`, item position). */
const dropCursorSchema = z.tuple([cursorParts.timestamp, cursorParts.eventId, cursorParts.index]);

export interface DropsOptions extends LootFilter {
  /** Only drops with `geValue >= minValue`. */
  minValue?: number | undefined;
  cursor?: string | undefined;
  limit: number;
}

/** A drop with its sort key: the loot event's `event_id` and the item's position. */
export interface DropRow {
  drop: Drop;
  eventId: string;
  position: number;
}

export interface DropRowsOptions extends LootFilter {
  minValue?: number | undefined;
  /** Only drops after this key, in the order below. */
  after?: readonly [occurredAt: string, eventId: string, position: number] | undefined;
  limit: number;
}

/**
 * One row per item per loot event. Newest loot event first (`occurred_at`,
 * then `event_id`); items in payload order within an event. `loot/drops` and
 * the feed both use it.
 */
export function dropRows(db: Queryable, options: DropRowsOptions): DropRow[] {
  const conditions = lootWhere(options);
  const geValue = sql<number>`${lootItems.quantity} * ${lootItems.gePriceEach}`;
  if (options.minValue !== undefined) conditions.push(sql`${geValue} >= ${options.minValue}`);
  if (options.after !== undefined) {
    const [at, eventId, position] = options.after;
    const after = or(
      lt(lootEvents.occurredAt, at),
      and(eq(lootEvents.occurredAt, at), lt(lootEvents.eventId, eventId)),
      and(
        eq(lootEvents.occurredAt, at),
        eq(lootEvents.eventId, eventId),
        sql`${lootItems.position} > ${position}`,
      ),
    );
    if (after) conditions.push(after);
  }

  const rows = db
    .select({
      lootEventId: lootEvents.id,
      eventId: lootEvents.eventId,
      position: lootItems.position,
      accountId: lootEvents.accountId,
      sessionId: lootEvents.sessionId,
      occurredAt: lootEvents.occurredAt,
      sourceType: lootEvents.sourceType,
      sourceName: lootEvents.sourceName,
      itemId: lootItems.itemId,
      name: lootItems.itemName,
      quantity: lootItems.quantity,
      gePriceEach: lootItems.gePriceEach,
      haPriceEach: lootItems.haPriceEach,
    })
    // CROSS JOIN fixes the join order in SQLite: walk loot events newest first
    // on the (account_id,) occurred_at, event_id index and look up their items,
    // instead of sorting every item.
    .from(lootEvents)
    .crossJoin(lootItems)
    .where(and(eq(lootItems.lootEventId, lootEvents.id), ...conditions))
    .orderBy(desc(lootEvents.occurredAt), desc(lootEvents.eventId), asc(lootItems.position))
    .limit(options.limit)
    .all();
  return rows.map((row) => ({
    eventId: row.eventId,
    position: row.position,
    drop: {
      lootEventId: row.lootEventId,
      accountId: row.accountId,
      sessionId: row.sessionId,
      occurredAt: row.occurredAt,
      source: apiSource(row.sourceType, row.sourceName),
      itemId: row.itemId,
      name: row.name,
      quantity: row.quantity,
      gePriceEach: row.gePriceEach,
      haPriceEach: row.haPriceEach,
      // Exact: the loot projection rejects events whose totals aren't safe integers.
      geValue: row.quantity * row.gePriceEach,
      haValue: row.quantity * row.haPriceEach,
    },
  }));
}

/** `GET …/loot/drops`: `dropRows` with a cursor. */
export function drops(db: Queryable, options: DropsOptions): Page<Drop> {
  const rows = dropRows(db, {
    ...options,
    after:
      options.cursor === undefined ? undefined : decodeCursor(options.cursor, dropCursorSchema),
    limit: options.limit + 1,
  });
  const page = rows.slice(0, options.limit);
  const last = page.at(-1);
  return {
    items: page.map((row) => row.drop),
    nextCursor:
      rows.length > options.limit && last
        ? encodeCursor([last.drop.occurredAt, last.eventId, last.position])
        : null,
  };
}
