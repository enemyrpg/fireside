import {
  isRaidPurple,
  normalizeBossName,
  raidOf,
  raidSpecialLootPayloadSchema,
  type Event,
  type RaidSpecialLootPayload,
} from '@fireside/shared';
import { and, asc, eq, getTableName, isNotNull, or } from 'drizzle-orm';
import type { Queryable } from '../db/index.js';
import {
  accounts,
  events,
  lootEvents,
  lootItems,
  raidDropChoices,
  raidSpecialLoot,
} from '../db/schema.js';
import { deleteOrphanedChoices, settleAllChoices } from '../raids/choice-keys.js';
import type { Projection } from './framework.js';
import { accountIdOf, type AccountKey } from './lookup.js';

// `raid_special_loot`.
//
// Own purples arrive twice: as a `raid.special_loot` event (`SELF`) and as an
// item in the chest's `loot` event. They must count once. Refresh from raw per
// (account, session): on a `raid.special_loot` event or raid loot, the
// session's rows are rebuilt from its projected `raid.special_loot` events and
// the purple items in its projected raid loot. Each `SELF` event, oldest
// first, takes the unmatched loot purple of the same raid and item nearest to
// it in time (the older one on a tie). The result depends only on the set of
// events, so arrival order and `rebuild` give the same rows.
//
// The `loot` tables are unchanged: loot totals still include own purples once.
//
// The user's split choices are not derived, but are keyed by these rows. A
// refresh never moves them: the matching can change while events arrive, and
// a drop reads both its keys (docs/decisions/0020-raid-split-choice-keys.md).

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
 * The session's projected `raid.special_loot` events, plus `currentEventId`
 * (if not `null`), oldest first. Failed and pending events are never read.
 */
function specialEvents(
  tx: Queryable,
  { userId, accountHash }: AccountKey,
  sessionId: string,
  currentEventId: string | null,
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
        currentEventId === null
          ? isNotNull(events.processedAt)
          : or(isNotNull(events.processedAt), eq(events.eventId, currentEventId)),
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
 * Index of the unmatched purple of the event's raid and item nearest to
 * `occurredAt`, or -1. `purples` is oldest first, so a tie keeps the older one.
 */
function nearestPurple(
  purples: readonly LootPurple[],
  raidGroup: string,
  payload: RaidSpecialLootPayload,
  occurredAt: string,
): number {
  const at = Date.parse(occurredAt);
  let best = -1;
  let bestDistance = Infinity;
  purples.forEach((purple, index) => {
    if (purple.raidGroup !== raidGroup || purple.itemId !== payload.item.itemId) return;
    const distance = Math.abs(Date.parse(purple.occurredAt) - at);
    if (distance < bestDistance) {
      best = index;
      bestDistance = distance;
    }
  });
  return best;
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
      payload.recipient === 'SELF' ? nearestPurple(unmatched, raidGroup, payload, occurredAt) : -1;
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

/**
 * Rebuilds one session's rows from raw. `currentEventId` is the event being
 * projected (not marked processed yet), if any.
 */
function refreshSession(
  tx: Queryable,
  account: AccountKey,
  accountId: number,
  sessionId: string,
  currentEventId: string | null,
): void {
  tx.delete(raidSpecialLoot)
    .where(and(eq(raidSpecialLoot.sessionId, sessionId), eq(raidSpecialLoot.accountId, accountId)))
    .run();
  const rows = specialLootRows(
    accountId,
    sessionId,
    specialEvents(tx, account, sessionId, currentEventId),
    lootPurples(tx, accountId, sessionId),
  );
  if (rows.length > 0) tx.insert(raidSpecialLoot).values(rows).run();
}

export const raidSpecialLootProjection: Projection = {
  name: 'raid-special-loot',
  // 2: a `SELF` event takes the nearest unmatched chest purple, not the oldest.
  version: 2,

  // Before re-matching, with the version 1 rows: move every chest-key choice
  // to its drop's event, so it stays on the drop the owner saw. Also runs
  // before the fallback full rebuild.
  beforeUpgrade(tx) {
    return { choicesMoved: settleAllChoices(tx) };
  },

  // Refreshes every session that has special loot. A session without rows has
  // no projected raid purples, so the new rule changes nothing there.
  recompute(tx) {
    const sessions = tx
      .selectDistinct({
        accountId: raidSpecialLoot.accountId,
        sessionId: raidSpecialLoot.sessionId,
        userId: accounts.userId,
        accountHash: accounts.accountHash,
      })
      .from(raidSpecialLoot)
      .innerJoin(accounts, eq(raidSpecialLoot.accountId, accounts.id))
      .all();
    for (const { accountId, sessionId, userId, accountHash } of sessions) {
      refreshSession(tx, { userId, accountHash }, accountId, sessionId, null);
    }
    return {
      tables: [getTableName(raidSpecialLoot), getTableName(raidDropChoices)],
      counts: { raidSessions: sessions.length, choicesDeleted: deleteOrphanedChoices(tx) },
    };
  },

  apply(tx, event) {
    if (!affectsSpecialLoot(event)) return;
    refreshSession(tx, event, accountIdOf(tx, event), event.sessionId, event.eventId);
  },

  // Only removes choices of drops that are definitely gone; never moves one.
  afterReplay(tx, { log }) {
    const deleted = deleteOrphanedChoices(tx);
    // Counts only: choices hold nicknames and notes.
    if (deleted > 0) log?.warn({ deleted }, 'Removed split choices of drops that no longer exist');
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
