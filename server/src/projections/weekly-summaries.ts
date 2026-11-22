import type { Event } from '@fireside/shared';
import { and, asc, eq, gt, min, sql } from 'drizzle-orm';
import type { Queryable } from '../db/index.js';
import {
  accounts,
  sessionAfkPeriods,
  sessionHeartbeats,
  sessions,
  weeklySummaries,
} from '../db/schema.js';
import type { Projection } from './framework.js';
import { accountIdOf } from './lookup.js';

// Invalidation of `weekly_summaries`. Stored weeks are filled by the read API
// (server/src/read/weekly.ts) when a completed week is first read. This
// projection never computes them: it deletes the stored weeks an event can
// change, and the next read computes them again.
//
// A week reads heartbeats, AFK periods, XP snapshots, loot and KC by time. An
// event at `t` changes the week it falls in and can change every later week:
// XP and KC gains start from the last value before the week, and each week
// has the previous week's play time. So the account's weeks that end after
// `t` are deleted: one indexed DELETE, no `TZ` needed (the row holds its end
// in UTC). Closing a session (also by the timeout job) changes none of these
// inputs, so no "session closed" hook is needed.
//
// Bank, potion storage, quest, diary and `pet.drop` events are covered by the
// same rule: the bank value is carried forward into later weeks, and a late
// snapshot can only move a completion or the quest baseline to its own time
// or later.
//
// Two inputs do not come from events alone, so their writers call
// `invalidateWeeksFrom` themselves: `account_pets` (server/src/pets/merge.ts,
// built from `pet.drop` events and the collection log) and the collection log
// tables (server/src/clog/project.ts, built from `external_snapshots`: syncs,
// the seed and `rebuildClog`).
//
// One exception: heartbeats and AFK periods count for the session's account,
// which a late `session.*` event can change (the account comes from the first
// `session.start`, else the earliest session event). The session's play time
// then moves from one account to another, and the old account isn't known
// any more. So a `session.*` event deletes every account's weeks that end
// after the session's earliest heartbeat, AFK period or start.

/** Earliest instant an event can change a week's content. */
export function earliestAffected(event: Event): string {
  // An AFK period is sent when it ends; it covers heartbeats from its start.
  if (event.type === 'session.afk' && event.payload.startedAt < event.occurredAt)
    return event.payload.startedAt;
  return event.occurredAt;
}

/** Earliest of the session's start, first heartbeat and first AFK period start. */
function sessionEarliest(tx: Queryable, sessionId: string): string | undefined {
  const times = [
    tx.select({ at: sessions.startedAt }).from(sessions).where(eq(sessions.id, sessionId)).get()
      ?.at,
    tx
      .select({ at: min(sessionHeartbeats.at) })
      .from(sessionHeartbeats)
      .where(eq(sessionHeartbeats.sessionId, sessionId))
      .get()?.at,
    tx
      .select({ at: min(sessionAfkPeriods.startedAt) })
      .from(sessionAfkPeriods)
      .where(eq(sessionAfkPeriods.sessionId, sessionId))
      .get()?.at,
  ].filter((at): at is string => typeof at === 'string');
  // Same timestamp format everywhere, so string order is time order.
  return times.sort()[0];
}

/** Whether no week is stored, e.g. during a rebuild (the table was just emptied). */
function nothingStored(tx: Queryable): boolean {
  return !tx
    .select({ one: sql`1` })
    .from(weeklySummaries)
    .limit(1)
    .get();
}

/**
 * Deletes one account's stored weeks that end after `from`: the weeks that
 * data at `from` can change. For writers of weekly inputs that are not
 * projections of a single event (pets and the collection log).
 */
export function invalidateWeeksFrom(tx: Queryable, accountId: number, from: string): void {
  if (nothingStored(tx)) return;
  tx.delete(weeklySummaries)
    .where(and(eq(weeklySummaries.accountId, accountId), gt(weeklySummaries.end, from)))
    .run();
}

export const weeklySummariesProjection: Projection = {
  name: 'weekly-summaries',

  apply(tx, event) {
    if (nothingStored(tx)) return;
    let from = earliestAffected(event);
    if (event.type.startsWith('session.')) {
      // The session may have moved between accounts: clear every account.
      const earliest = sessionEarliest(tx, event.sessionId);
      if (earliest !== undefined && earliest < from) from = earliest;
      tx.delete(weeklySummaries).where(gt(weeklySummaries.end, from)).run();
      return;
    }
    tx.delete(weeklySummaries)
      .where(
        and(eq(weeklySummaries.accountId, accountIdOf(tx, event)), gt(weeklySummaries.end, from)),
      )
      .run();
  },

  reset(tx) {
    tx.delete(weeklySummaries).run();
  },

  snapshot(db) {
    // Without `computed_at` (when it was read) or loot event IDs (surrogate).
    return db
      .select({
        userId: accounts.userId,
        accountHash: accounts.accountHash,
        isoWeek: weeklySummaries.isoWeek,
        start: weeklySummaries.start,
        end: weeklySummaries.end,
        data: weeklySummaries.data,
      })
      .from(weeklySummaries)
      .innerJoin(accounts, eq(weeklySummaries.accountId, accounts.id))
      .orderBy(asc(accounts.userId), asc(accounts.accountHash), asc(weeklySummaries.isoWeek))
      .all()
      .map((row) => ({ ...row, data: withoutLootEventIds(row.data) }));
  },
};

function withoutLootEventIds(data: string): unknown {
  const parsed = JSON.parse(data) as { loot?: { topDrops?: { lootEventId?: number }[] } };
  for (const drop of parsed.loot?.topDrops ?? []) delete drop.lootEventId;
  return parsed;
}
