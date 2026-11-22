import {
  isRaidPurple,
  normalizeBossName,
  raidOf,
  raidSpecialLootPayloadSchema,
  type Event,
  type RaidSpecialLootPayload,
} from '@fireside/shared';
import { and, asc, eq, isNotNull, or } from 'drizzle-orm';
import type { Queryable } from '../db/index.js';
import { accounts, events, lootEvents, lootItems, raidSpecialLoot } from '../db/schema.js';
import type { Projection } from './framework.js';
import { accountIdOf, type AccountKey } from './lookup.js';

// `raid_special_loot`.
//
// Own purples arrive twice: as a `raid.special_loot` event (`SELF`) and as an
// item in the chest's `loot` event. They must count once. Refresh from raw per
// (account, session): on a `raid.special_loot` event or raid loot, the
// session's rows are rebuilt from its projected `raid.special_loot` events and
// the purple items in its projected raid loot. Each `SELF` event takes the
// first unmatched loot purple of the same raid and item. The result depends
// only on the set of events, so arrival order and `rebuild` give the same rows.
//
// The `loot` tables are unchanged: loot totals still include own purples once.

type Row = typeof raidSpecialLoot.$inferInsert;

/** The raid (group name) a normalized raid or loot source name belongs to. */
function raidGroupOf(name: string): string {
  return raidOf(name)?.name ?? name;
}

/** True if the event can change a session's special loot. */
function affectsSpecialLoot(event: Event): boolean {
  if (event.type === 'raid.special_loot') return true;
  if (event.type !== 'loot' || event.payload.source.name === null) return false;
  const raid = raidOf(normalizeBossName(event.payload.source.name));
  return raid !== undefined && event.payload.items.some((item) => isRaidPurple(raid, item.itemId));
}

interface SpecialEvent {
  eventId: string;
  occurredAt: string;
  payload: RaidSpecialLootPayload;
}

/**
 * The session's projected `raid.special_loot` events, plus `currentEventId`,
 * oldest first. Failed and pending events are never read.
 */
function specialEvents(
  tx: Queryable,
  { userId, accountHash }: AccountKey,
  sessionId: string,
  currentEventId: string,
): SpecialEvent[] {
  return tx
    .select({ eventId: events.eventId, occurredAt: events.occurredAt, payload: events.payload })
    .from(events)
    .where(
      and(
        eq(events.sessionId, sessionId),
        eq(events.type, 'raid.special_loot'),
        eq(events.userId, userId),
        eq(events.accountHash, accountHash),
        or(isNotNull(events.processedAt), eq(events.eventId, currentEventId)),
      ),
    )
    .orderBy(asc(events.occurredAt), asc(events.eventId))
    .all()
    .map((row) => ({
      eventId: row.eventId,
      occurredAt: row.occurredAt,
      // Stored events passed the contract; parse again for the type.
      payload: raidSpecialLootPayloadSchema.parse(JSON.parse(row.payload)),
    }));
}

interface LootPurple {
  eventId: string;
  occurredAt: string;
  raid: string;
  raidGroup: string;
  position: number;
  itemId: number;
  itemName: string;
  quantity: number;
  gePriceEach: number;
  killCount: number | null;
}

/** Purple items in the session's raid loot (already projected), oldest first. */
function lootPurples(tx: Queryable, accountId: number, sessionId: string): LootPurple[] {
  const rows = tx
    .select({
      eventId: lootEvents.eventId,
      occurredAt: lootEvents.occurredAt,
      sourceName: lootEvents.sourceName,
      killCount: lootEvents.killCount,
      position: lootItems.position,
      itemId: lootItems.itemId,
      itemName: lootItems.itemName,
      quantity: lootItems.quantity,
      gePriceEach: lootItems.gePriceEach,
    })
    .from(lootEvents)
    .innerJoin(lootItems, eq(lootItems.lootEventId, lootEvents.id))
    .where(and(eq(lootEvents.sessionId, sessionId), eq(lootEvents.accountId, accountId)))
    .orderBy(asc(lootEvents.occurredAt), asc(lootEvents.eventId), asc(lootItems.position))
    .all();
  return rows.flatMap((row) => {
    if (row.sourceName === null) return [];
    const raidName = normalizeBossName(row.sourceName);
    const raid = raidOf(raidName);
    if (!raid || !isRaidPurple(raid, row.itemId)) return [];
    return [{ ...row, raid: raidName, raidGroup: raid.name }];
  });
}

/**
 * The session's special loot: every `raid.special_loot` event, with `SELF`
 * events matched to a loot purple, plus loot purples no event matched.
 */
export function specialLootRows(
  accountId: number,
  sessionId: string,
  specials: readonly SpecialEvent[],
  purples: readonly LootPurple[],
): Row[] {
  const unmatched = [...purples];
  const rows: Row[] = specials.map(({ eventId, occurredAt, payload }) => {
    const raid = normalizeBossName(payload.raid);
    const raidGroup = raidGroupOf(raid);
    const index =
      payload.recipient === 'SELF'
        ? unmatched.findIndex(
            (purple) => purple.raidGroup === raidGroup && purple.itemId === payload.item.itemId,
          )
        : -1;
    const [loot] = index === -1 ? [] : unmatched.splice(index, 1);
    return {
      accountId,
      sessionId,
      occurredAt,
      raid,
      raidGroup,
      itemId: payload.item.itemId,
      itemName: payload.item.name,
      quantity: payload.item.quantity,
      gePriceEach: payload.item.gePrice,
      recipient: payload.recipient,
      teamSize: payload.teamSize ?? null,
      killCount: payload.killCount ?? loot?.killCount ?? null,
      specialEventId: eventId,
      lootEventId: loot?.eventId ?? null,
      lootItemPosition: loot?.position ?? null,
    };
  });
  for (const loot of unmatched) {
    rows.push({
      accountId,
      sessionId,
      occurredAt: loot.occurredAt,
      raid: loot.raid,
      raidGroup: loot.raidGroup,
      itemId: loot.itemId,
      itemName: loot.itemName,
      quantity: loot.quantity,
      gePriceEach: loot.gePriceEach,
      recipient: 'SELF',
      teamSize: null,
      killCount: loot.killCount,
      specialEventId: null,
      lootEventId: loot.eventId,
      lootItemPosition: loot.position,
    });
  }
  return rows;
}

export const raidSpecialLootProjection: Projection = {
  name: 'raid-special-loot',

  apply(tx, event) {
    if (!affectsSpecialLoot(event)) return;
    const accountId = accountIdOf(tx, event);
    const { sessionId } = event;
    tx.delete(raidSpecialLoot)
      .where(
        and(eq(raidSpecialLoot.sessionId, sessionId), eq(raidSpecialLoot.accountId, accountId)),
      )
      .run();
    const rows = specialLootRows(
      accountId,
      sessionId,
      specialEvents(tx, event, sessionId, event.eventId),
      lootPurples(tx, accountId, sessionId),
    );
    if (rows.length > 0) tx.insert(raidSpecialLoot).values(rows).run();
  },

  reset(tx) {
    tx.delete(raidSpecialLoot).run();
  },

  snapshot(db) {
    return db
      .select({
        userId: accounts.userId,
        accountHash: accounts.accountHash,
        sessionId: raidSpecialLoot.sessionId,
        occurredAt: raidSpecialLoot.occurredAt,
        raid: raidSpecialLoot.raid,
        raidGroup: raidSpecialLoot.raidGroup,
        itemId: raidSpecialLoot.itemId,
        itemName: raidSpecialLoot.itemName,
        quantity: raidSpecialLoot.quantity,
        gePriceEach: raidSpecialLoot.gePriceEach,
        recipient: raidSpecialLoot.recipient,
        teamSize: raidSpecialLoot.teamSize,
        killCount: raidSpecialLoot.killCount,
        specialEventId: raidSpecialLoot.specialEventId,
        lootEventId: raidSpecialLoot.lootEventId,
        lootItemPosition: raidSpecialLoot.lootItemPosition,
      })
      .from(raidSpecialLoot)
      .innerJoin(accounts, eq(raidSpecialLoot.accountId, accounts.id))
      .orderBy(
        asc(accounts.userId),
        asc(accounts.accountHash),
        asc(raidSpecialLoot.occurredAt),
        asc(raidSpecialLoot.specialEventId),
        asc(raidSpecialLoot.lootEventId),
        asc(raidSpecialLoot.lootItemPosition),
      )
      .all();
  },
};
