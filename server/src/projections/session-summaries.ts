import { isKnownSkill } from '@fireside/shared';
import { and, asc, count, desc, eq, gt, lt, ne, or, sql } from 'drizzle-orm';
import type { Queryable } from '../db/index.js';
import {
  kcObservations,
  lootEvents,
  sessionSummaries,
  sessions,
  xpSnapshotSkills,
  xpSnapshots,
  type SessionSummaryRow,
} from '../db/schema.js';
import type { Projection } from './framework.js';
import { kcObservationOf } from './kc-observation.js';
import { lootTotals } from './loot.js';
import { accountIdOf } from './lookup.js';

// `session_summaries` (see docs/architecture.md#sessions).
//
// A summary exists while the session row is closed, and never while it is
// open. Its content comes from `xp_snapshots`, `loot_events` and
// `kc_observations` only (rows that exist only for projected events), never
// from session times, so it is the same whatever order events arrive in.
//
// It is built in full when the session closes. After that, each XP, loot or
// KC event updates only the part it can change, with a few indexed lookups,
// so a rebuild (where old sessions are closed from their first event) stays
// linear. Runs after the sessions, xp, loot and kc projections, so their rows
// for the current event are visible.

export interface XpGains {
  total: number;
  /** Only skills with a gain. */
  bySkill: Record<string, number>;
}

/**
 * XP gained between two snapshots (skill → XP). Only skills in `SKILLS` that
 * are in both count. Gains are at least 0. The total is the sum per skill.
 */
export function xpGains(
  first: Readonly<Record<string, number>>,
  last: Readonly<Record<string, number>>,
): XpGains {
  let total = 0;
  const bySkill: Record<string, number> = {};
  for (const [skill, endXp] of Object.entries(last)) {
    const startXp = first[skill];
    if (!isKnownSkill(skill) || startXp === undefined) continue;
    const gain = endXp - startXp;
    if (gain <= 0) continue;
    bySkill[skill] = gain;
    total += gain;
  }
  return { total, bySkill };
}

/** KC gained from `start` to the highest KC `end`, at least 0. */
export function kcGain(start: number, end: number): number {
  return Math.max(0, end - start);
}

/**
 * A loot total capped at the largest exact integer. Only absurd data gets
 * there; capping keeps one bad session from failing other events.
 */
export function capLootValue(value: number): number {
  return Math.min(value, Number.MAX_SAFE_INTEGER);
}

/** JSON with keys in sorted order, so equal objects give equal text. */
function sortedJson(values: Readonly<Record<string, number>>): string {
  return JSON.stringify(
    Object.fromEntries(Object.entries(values).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))),
  );
}

type SummaryContent = Omit<SessionSummaryRow, 'sessionId'>;

// --- XP ---------------------------------------------------------------------

interface SnapshotRef {
  id: number;
  eventId: string;
}

function sessionSnapshot(
  tx: Queryable,
  sessionId: string,
  which: 'first' | 'last',
): SnapshotRef | undefined {
  const order = which === 'first' ? asc : desc;
  return tx
    .select({ id: xpSnapshots.id, eventId: xpSnapshots.eventId })
    .from(xpSnapshots)
    .where(eq(xpSnapshots.sessionId, sessionId))
    .orderBy(order(xpSnapshots.takenAt), order(xpSnapshots.eventId))
    .limit(1)
    .get();
}

function snapshotXp(tx: Queryable, snapshotId: number): Record<string, number> {
  return Object.fromEntries(
    tx
      .select({ skill: xpSnapshotSkills.skill, xp: xpSnapshotSkills.xp })
      .from(xpSnapshotSkills)
      .where(eq(xpSnapshotSkills.snapshotId, snapshotId))
      .all()
      .map((row) => [row.skill, row.xp]),
  );
}

function xpContent(
  tx: Queryable,
  first: SnapshotRef | undefined,
  last: SnapshotRef | undefined,
): Pick<SummaryContent, 'xpGainedTotal' | 'xpGainedBySkill'> {
  const gains =
    first && last && first.id !== last.id
      ? xpGains(snapshotXp(tx, first.id), snapshotXp(tx, last.id))
      : { total: 0, bySkill: {} };
  return { xpGainedTotal: gains.total, xpGainedBySkill: sortedJson(gains.bySkill) };
}

// --- KC ---------------------------------------------------------------------

/** Start and end KC of one boss in a session. */
export interface BossKc {
  /** Last KC before the session, or the first KC seen in it. */
  start: number;
  /** Highest KC in the session. */
  end: number;
}

/**
 * KC for one boss in the session: `end` is the highest KC in the session,
 * `start` the last KC of the same account and boss in another session, before
 * the session's first observation of the boss. Without one, the first
 * observation in the session is the start, so it counts as 0. `undefined`
 * if the session has no observation of the boss. Shared by the summary and
 * the session detail endpoint, so they always agree.
 */
export function bossKc(tx: Queryable, sessionId: string, boss: string): BossKc | undefined {
  const inSession = and(eq(kcObservations.sessionId, sessionId), eq(kcObservations.boss, boss));
  const first = tx
    .select({
      accountId: kcObservations.accountId,
      killCount: kcObservations.killCount,
      observedAt: kcObservations.observedAt,
      eventId: kcObservations.eventId,
    })
    .from(kcObservations)
    .where(inSession)
    .orderBy(asc(kcObservations.observedAt), asc(kcObservations.eventId))
    .limit(1)
    .get();
  if (!first) return undefined;

  const highest = tx
    .select({ killCount: kcObservations.killCount })
    .from(kcObservations)
    .where(inSession)
    .orderBy(desc(kcObservations.killCount))
    .limit(1)
    .get();
  const before = tx
    .select({ killCount: kcObservations.killCount })
    .from(kcObservations)
    .where(
      and(
        eq(kcObservations.accountId, first.accountId),
        eq(kcObservations.boss, boss),
        ne(kcObservations.sessionId, sessionId),
        or(
          lt(kcObservations.observedAt, first.observedAt),
          and(
            eq(kcObservations.observedAt, first.observedAt),
            lt(kcObservations.eventId, first.eventId),
          ),
        ),
      ),
    )
    .orderBy(desc(kcObservations.observedAt), desc(kcObservations.eventId))
    .limit(1)
    .get();
  return {
    start: before?.killCount ?? first.killCount,
    end: highest?.killCount ?? first.killCount,
  };
}

/** KC gained for one boss in the session (at least 0), `undefined` if not seen. */
function bossGain(tx: Queryable, sessionId: string, boss: string): number | undefined {
  const kc = bossKc(tx, sessionId, boss);
  return kc && kcGain(kc.start, kc.end);
}

/** `kc_gained_by_boss` with one boss recomputed. */
function withBossGain(tx: Queryable, sessionId: string, boss: string, current: string): string {
  const gains = Object.entries(JSON.parse(current) as Record<string, number>).filter(
    ([name]) => name !== boss,
  );
  const gain = bossGain(tx, sessionId, boss);
  if (gain !== undefined) gains.push([boss, gain]);
  return sortedJson(Object.fromEntries(gains));
}

/**
 * The session holding the next observation of the same account and boss
 * after this one, in another session. This observation may be the "last KC
 * before" that session, so its gain for the boss must be updated too.
 */
function nextKcSession(
  tx: Queryable,
  accountId: number,
  boss: string,
  sessionId: string,
  at: { observedAt: string; eventId: string },
): string | undefined {
  return tx
    .select({ sessionId: kcObservations.sessionId })
    .from(kcObservations)
    .where(
      and(
        eq(kcObservations.accountId, accountId),
        eq(kcObservations.boss, boss),
        ne(kcObservations.sessionId, sessionId),
        or(
          gt(kcObservations.observedAt, at.observedAt),
          and(eq(kcObservations.observedAt, at.observedAt), gt(kcObservations.eventId, at.eventId)),
        ),
      ),
    )
    .orderBy(asc(kcObservations.observedAt), asc(kcObservations.eventId))
    .limit(1)
    .get()?.sessionId;
}

// --- Whole summary ----------------------------------------------------------

/**
 * The summary of a session computed from scratch. Used when a session closes,
 * and by tests to check the step-by-step updates.
 */
export function computeSessionSummary(tx: Queryable, sessionId: string): SummaryContent {
  const loot = tx
    .select({
      // `total()` is a float sum, so it never overflows; capped below.
      geValue: sql<number>`total(${lootEvents.totalGeValue})`,
      count: count(),
    })
    .from(lootEvents)
    .where(eq(lootEvents.sessionId, sessionId))
    .get();
  return {
    ...xpContent(
      tx,
      sessionSnapshot(tx, sessionId, 'first'),
      sessionSnapshot(tx, sessionId, 'last'),
    ),
    lootGeValue: capLootValue(loot?.geValue ?? 0),
    lootCount: loot?.count ?? 0,
    kcGainedByBoss: kcContent(tx, sessionId),
  };
}

/** `kc_gained_by_boss` of a session computed from scratch. */
function kcContent(tx: Queryable, sessionId: string): string {
  const bosses = tx
    .selectDistinct({ boss: kcObservations.boss })
    .from(kcObservations)
    .where(eq(kcObservations.sessionId, sessionId))
    .all();
  const kc: Record<string, number> = {};
  for (const { boss } of bosses) kc[boss] = bossGain(tx, sessionId, boss) ?? 0;
  return sortedJson(kc);
}

/**
 * Whether the session is closed, and its summary if there is one. `undefined`
 * if there is no session row.
 */
function summaryState(
  tx: Queryable,
  sessionId: string,
): { closed: boolean; summary: SummaryContent | undefined } | undefined {
  const row = tx
    .select({
      endedAt: sessions.endedAt,
      summaryId: sessionSummaries.sessionId,
      xpGainedTotal: sessionSummaries.xpGainedTotal,
      xpGainedBySkill: sessionSummaries.xpGainedBySkill,
      lootGeValue: sessionSummaries.lootGeValue,
      lootCount: sessionSummaries.lootCount,
      kcGainedByBoss: sessionSummaries.kcGainedByBoss,
    })
    .from(sessions)
    .leftJoin(sessionSummaries, eq(sessionSummaries.sessionId, sessions.id))
    .where(eq(sessions.id, sessionId))
    .get();
  if (!row) return undefined;
  const { endedAt, summaryId, ...summary } = row;
  return {
    closed: endedAt !== null,
    summary:
      summaryId === null
        ? undefined
        : {
            // Not null when the joined row exists (all columns are NOT NULL).
            xpGainedTotal: summary.xpGainedTotal ?? 0,
            xpGainedBySkill: summary.xpGainedBySkill ?? '{}',
            lootGeValue: summary.lootGeValue ?? 0,
            lootCount: summary.lootCount ?? 0,
            kcGainedByBoss: summary.kcGainedByBoss ?? '{}',
          },
  };
}

function insertSummary(tx: Queryable, sessionId: string): void {
  tx.insert(sessionSummaries)
    .values({ sessionId, ...computeSessionSummary(tx, sessionId) })
    .run();
}

/**
 * Makes the summary match whether the session is closed: builds it if the
 * session is closed and has none, removes it if the session is open. A
 * summary that exists is kept: session events never change its content.
 * Used for `session.*` events and by the timeout job.
 */
export function syncSessionSummary(tx: Queryable, sessionId: string): void {
  const state = summaryState(tx, sessionId);
  // A missing session row takes its summary with it (ON DELETE CASCADE).
  if (!state) return;
  if (!state.closed) {
    if (state.summary) {
      tx.delete(sessionSummaries).where(eq(sessionSummaries.sessionId, sessionId)).run();
    }
  } else if (!state.summary) {
    insertSummary(tx, sessionId);
  }
}

/**
 * Applies `change` to the summary of a closed session. Open sessions have no
 * summary, so nothing happens for them.
 */
function updateSummary(
  tx: Queryable,
  sessionId: string,
  change: (summary: SummaryContent) => Partial<SummaryContent> | undefined,
): void {
  const state = summaryState(tx, sessionId);
  if (!state?.closed) return;
  if (!state.summary) {
    // Shouldn't happen (a summary is built when the session closes), but a
    // full build gives the right result anyway.
    insertSummary(tx, sessionId);
    return;
  }
  const set = change(state.summary);
  if (set && Object.keys(set).length > 0) {
    tx.update(sessionSummaries).set(set).where(eq(sessionSummaries.sessionId, sessionId)).run();
  }
}

/**
 * Updates the gain for `boss` in a closed session that has, or had, an
 * observation at `at`, and in the account's next session that saw the boss
 * after it. Used for each KC observation, and by the kc projection for an
 * observation it replaced (projections/kc.ts).
 */
export function refreshBossGain(
  tx: Queryable,
  accountId: number,
  boss: string,
  sessionId: string,
  at: { observedAt: string; eventId: string },
): void {
  updateSummary(tx, sessionId, (summary) => ({
    kcGainedByBoss: withBossGain(tx, sessionId, boss, summary.kcGainedByBoss),
  }));
  const next = nextKcSession(tx, accountId, boss, sessionId, at);
  if (next !== undefined) {
    updateSummary(tx, next, (summary) => ({
      kcGainedByBoss: withBossGain(tx, next, boss, summary.kcGainedByBoss),
    }));
  }
}

/** Recomputes the KC gains of a closed session from scratch (kc rule changes). */
export function recomputeKcGains(tx: Queryable, sessionId: string): void {
  updateSummary(tx, sessionId, () => ({ kcGainedByBoss: kcContent(tx, sessionId) }));
}

export const sessionSummariesProjection: Projection = {
  name: 'session-summaries',

  apply(tx, event) {
    const { sessionId } = event;
    switch (event.type) {
      case 'session.start':
      case 'session.heartbeat':
      case 'session.afk':
      case 'session.end':
        syncSessionSummary(tx, sessionId);
        return;

      case 'loot': {
        const { totalGeValue } = lootTotals(event.payload.items);
        updateSummary(tx, sessionId, (summary) => ({
          lootGeValue: capLootValue(summary.lootGeValue + totalGeValue),
          lootCount: summary.lootCount + 1,
        }));
        break;
      }

      case 'xp.snapshot':
        // Only a new first or last snapshot changes the gains.
        updateSummary(tx, sessionId, () => {
          const first = sessionSnapshot(tx, sessionId, 'first');
          const last = sessionSnapshot(tx, sessionId, 'last');
          if (first?.eventId !== event.eventId && last?.eventId !== event.eventId) return;
          return xpContent(tx, first, last);
        });
        return;

      case 'kc':
        break;
    }

    // `kc` events and `loot` events with a kill count.
    const observation = kcObservationOf(event);
    if (!observation) return;
    refreshBossGain(tx, accountIdOf(tx, event), observation.boss, sessionId, {
      observedAt: event.occurredAt,
      eventId: event.eventId,
    });
  },

  reset(tx) {
    tx.delete(sessionSummaries).run();
  },

  snapshot(db) {
    return db
      .select()
      .from(sessionSummaries)
      .orderBy(asc(sessionSummaries.sessionId))
      .all()
      .map((row) => ({
        ...row,
        xpGainedBySkill: JSON.parse(row.xpGainedBySkill) as unknown,
        kcGainedByBoss: JSON.parse(row.kcGainedByBoss) as unknown,
      }));
  },
};
