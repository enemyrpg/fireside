import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { accounts, events, kcObservations } from '../db/schema.js';
import { compareEventRows, type Projection } from './framework.js';
import { kcObservationOf, type Observation } from './kc-observation.js';
import { accountIdOf } from './lookup.js';
import { recomputeKcGains, refreshBossGain } from './session-summaries.js';
import { invalidateWeeksFrom, weeklySummariesProjection } from './weekly-summaries.js';

// `kc_observations`: one observation per kill, that is per (account,
// normalized boss, kill count). A kill usually gives two events in the same
// tick: a `kc` event (with time, PB and team size) and a `loot` event with the
// same `killCount`. Loot alone still gives an observation (e.g. chests whose
// count message is not sent as `kc`).
//
// Of all events for one kill, the observation comes from the first in a fixed
// order (`compareCandidates`, and `WINNER_ORDER` in SQL): a `kc` event before
// a loot event, then one with a time or PB before one without, then the
// earliest (`occurred_at`, `event_id`). `apply` keeps the winner of the
// projected events so far: a new event either loses (skipped) or replaces the
// row. The result is the winner of the set, so it is the same in any arrival
// order. Only rows of projected events are read, and a failed event's changes
// are rolled back, so failures leave no trace.

/** What decides which event's observation is kept for a kill. */
interface Candidate {
  fromKc: boolean;
  timed: boolean;
  occurredAt: string;
  eventId: string;
}

/** Negative if `a` wins over `b` as the observation of a kill. */
export function compareCandidates(a: Candidate, b: Candidate): number {
  if (a.fromKc !== b.fromKc) return a.fromKc ? -1 : 1;
  if (a.timed !== b.timed) return a.timed ? -1 : 1;
  return compareEventRows(a, b);
}

function isTimed(row: Pick<Observation, 'timeSeconds' | 'personalBestSeconds'>): boolean {
  return row.timeSeconds !== null || row.personalBestSeconds !== null;
}

/**
 * `compareCandidates` as an ORDER BY over `kc_observations AS o` joined to
 * `events AS e`: the winner of each kill sorts first.
 */
const WINNER_ORDER = sql.raw(
  `(e.type = 'kc') DESC,
   (o.time_seconds IS NOT NULL OR o.personal_best_seconds IS NOT NULL) DESC,
   o.observed_at ASC, o.event_id ASC`,
);

/** Rows deleted per statement in `recompute` (below SQLite's variable limit). */
const DELETE_CHUNK = 500;

export const kcProjection: Projection = {
  name: 'kc',
  // 2: one observation per kill instead of one per event.
  version: 2,

  apply(tx, event) {
    const observation = kcObservationOf(event);
    if (!observation) return;
    const accountId = accountIdOf(tx, event);
    const candidate: Candidate = {
      fromKc: event.type === 'kc',
      timed: isTimed(observation),
      occurredAt: event.occurredAt,
      eventId: event.eventId,
    };

    // At most one row by this rule; a list so anything else is cleaned up too.
    const existing = tx
      .select({
        id: kcObservations.id,
        sessionId: kcObservations.sessionId,
        eventId: kcObservations.eventId,
        occurredAt: kcObservations.observedAt,
        timeSeconds: kcObservations.timeSeconds,
        personalBestSeconds: kcObservations.personalBestSeconds,
        type: events.type,
      })
      .from(kcObservations)
      .innerJoin(events, eq(events.eventId, kcObservations.eventId))
      .where(
        and(
          eq(kcObservations.accountId, accountId),
          eq(kcObservations.boss, observation.boss),
          eq(kcObservations.killCount, observation.killCount),
        ),
      )
      .all();
    const wins = existing.every(
      (row) =>
        compareCandidates(candidate, { ...row, fromKc: row.type === 'kc', timed: isTimed(row) }) <
        0,
    );
    if (!wins) return;

    if (existing.length > 0) {
      const ids = existing.map((row) => row.id);
      tx.delete(kcObservations).where(inArray(kcObservations.id, ids)).run();
    }
    tx.insert(kcObservations)
      .values({
        accountId,
        sessionId: event.sessionId,
        eventId: event.eventId,
        observedAt: event.occurredAt,
        ...observation,
      })
      .run();

    // This event's session summary and weeks are updated by their own
    // projections. A replaced row may be in another session or week (a kill
    // at a boundary), so those are updated here.
    for (const row of existing) {
      refreshBossGain(tx, accountId, observation.boss, row.sessionId, {
        observedAt: row.occurredAt,
        eventId: row.eventId,
      });
      invalidateWeeksFrom(tx, accountId, row.occurredAt);
    }
  },

  // From version 1 (one row per event): delete every row that is not its
  // kill's winner, recompute the KC gains of the sessions that saw an
  // affected boss, and empty the weekly cache (filled again when read).
  recompute(tx) {
    const losers = tx.all<{ id: number; accountId: number; boss: string; sessionId: string }>(sql`
      SELECT id, account_id AS accountId, boss, session_id AS sessionId FROM (
        SELECT o.id, o.account_id, o.boss, o.session_id,
          row_number() OVER (
            PARTITION BY o.account_id, o.boss, o.kill_count ORDER BY ${WINNER_ORDER}
          ) AS rank
        FROM kc_observations AS o JOIN events AS e ON e.event_id = o.event_id
      ) WHERE rank > 1
    `);
    for (let start = 0; start < losers.length; start += DELETE_CHUNK) {
      const ids = losers.slice(start, start + DELETE_CHUNK).map((row) => row.id);
      tx.delete(kcObservations).where(inArray(kcObservations.id, ids)).run();
    }

    // A removed row can change the start of a later session of the same
    // account and boss, so every session that saw an affected boss is redone.
    const sessionIds = new Set(losers.map((row) => row.sessionId));
    const pairs = new Map(losers.map((row) => [`${String(row.accountId)}|${row.boss}`, row]));
    for (const { accountId, boss } of pairs.values()) {
      const rows = tx
        .selectDistinct({ sessionId: kcObservations.sessionId })
        .from(kcObservations)
        .where(and(eq(kcObservations.accountId, accountId), eq(kcObservations.boss, boss)))
        .all();
      for (const { sessionId } of rows) sessionIds.add(sessionId);
    }
    for (const sessionId of sessionIds) recomputeKcGains(tx, sessionId);
    weeklySummariesProjection.reset(tx);

    return {
      tables: ['kc_observations', 'session_summaries', 'weekly_summaries'],
      counts: { kcObservationsRemoved: losers.length, kcSessions: sessionIds.size },
    };
  },

  reset(tx) {
    tx.delete(kcObservations).run();
  },

  snapshot(db) {
    return db
      .select({
        userId: accounts.userId,
        accountHash: accounts.accountHash,
        eventId: kcObservations.eventId,
        sessionId: kcObservations.sessionId,
        observedAt: kcObservations.observedAt,
        boss: kcObservations.boss,
        killCount: kcObservations.killCount,
        timeSeconds: kcObservations.timeSeconds,
        personalBest: kcObservations.personalBest,
        personalBestSeconds: kcObservations.personalBestSeconds,
        teamSize: kcObservations.teamSize,
      })
      .from(kcObservations)
      .innerJoin(accounts, eq(kcObservations.accountId, accounts.id))
      .orderBy(
        asc(accounts.userId),
        asc(accounts.accountHash),
        asc(kcObservations.observedAt),
        asc(kcObservations.eventId),
      )
      .all();
  },
};
