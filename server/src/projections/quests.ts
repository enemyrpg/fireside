import type { DiariesSnapshotEvent, QuestsSnapshotEvent } from '@fireside/shared';
import { asc, desc, eq, sql } from 'drizzle-orm';
import type { Queryable } from '../db/index.js';
import {
  accounts,
  diaryCompletions,
  diarySnapshots,
  diaryStates,
  questCompletions,
  questSnapshots,
  questStates,
} from '../db/schema.js';
import { inChunks } from './bank.js';
import type { Projection, Stored } from './framework.js';
import { accountIdOf } from './lookup.js';

// `quest_snapshots`, `quest_states`, `quest_completions`, `diary_snapshots`,
// `diary_states` and `diary_completions`.
//
// Keyed insert: every snapshot event gets a row. The states are kept only for
// each account's latest snapshot, by (`taken_at`, `event_id`): when the event
// being projected is the newest, the account's states are replaced; an older,
// late event leaves them alone. The completions hold, per quest and diary
// tier, the earliest snapshot that showed it as finished: a minimum, so the
// arrival order does not matter. Snapshot rows exist only for events that
// projected without errors, so the tables depend only on the set of events.

type SnapshotTable = typeof questSnapshots | typeof diarySnapshots;

/** True if snapshot `id` is the account's newest. One row of the account index. */
function isLatest(tx: Queryable, table: SnapshotTable, accountId: number, id: number): boolean {
  const newest = tx
    .select({ id: table.id })
    .from(table)
    .where(eq(table.accountId, accountId))
    .orderBy(desc(table.takenAt), desc(table.eventId))
    .limit(1)
    .get();
  return newest?.id === id;
}

function applyQuests(tx: Queryable, event: Stored<QuestsSnapshotEvent>): void {
  const accountId = accountIdOf(tx, event);
  const { questPoints, quests } = event.payload;
  const snapshot = tx
    .insert(questSnapshots)
    .values({
      accountId,
      sessionId: event.sessionId,
      eventId: event.eventId,
      takenAt: event.occurredAt,
      questPoints,
    })
    .returning({ id: questSnapshots.id })
    .get();

  inChunks(
    quests
      .filter((entry) => entry.state === 'FINISHED')
      .map((entry) => ({
        accountId,
        quest: entry.quest,
        firstFinishedAt: event.occurredAt,
        eventId: event.eventId,
      })),
    (chunk) =>
      tx
        .insert(questCompletions)
        .values(chunk)
        .onConflictDoUpdate({
          target: [questCompletions.accountId, questCompletions.quest],
          set: {
            firstFinishedAt: sql`excluded.first_finished_at`,
            eventId: sql`excluded.event_id`,
          },
          // Keep the earliest; the event ID breaks ties, as everywhere.
          setWhere: sql`(excluded.first_finished_at, excluded.event_id) < (${questCompletions.firstFinishedAt}, ${questCompletions.eventId})`,
        })
        .run(),
  );

  if (!isLatest(tx, questSnapshots, accountId, snapshot.id)) return;
  tx.delete(questStates).where(eq(questStates.accountId, accountId)).run();
  inChunks(
    quests.map((entry) => ({
      accountId,
      quest: entry.quest,
      name: entry.name,
      state: entry.state,
      kind: entry.kind ?? null,
    })),
    (chunk) => tx.insert(questStates).values(chunk).run(),
  );
}

function applyDiaries(tx: Queryable, event: Stored<DiariesSnapshotEvent>): void {
  const accountId = accountIdOf(tx, event);
  const { diaries } = event.payload;
  const snapshot = tx
    .insert(diarySnapshots)
    .values({
      accountId,
      sessionId: event.sessionId,
      eventId: event.eventId,
      takenAt: event.occurredAt,
    })
    .returning({ id: diarySnapshots.id })
    .get();

  inChunks(
    diaries
      .filter((entry) => entry.completed)
      .map((entry) => ({
        accountId,
        region: entry.region,
        tier: entry.tier,
        firstCompletedAt: event.occurredAt,
        eventId: event.eventId,
      })),
    (chunk) =>
      tx
        .insert(diaryCompletions)
        .values(chunk)
        .onConflictDoUpdate({
          target: [diaryCompletions.accountId, diaryCompletions.region, diaryCompletions.tier],
          set: {
            firstCompletedAt: sql`excluded.first_completed_at`,
            eventId: sql`excluded.event_id`,
          },
          setWhere: sql`(excluded.first_completed_at, excluded.event_id) < (${diaryCompletions.firstCompletedAt}, ${diaryCompletions.eventId})`,
        })
        .run(),
  );

  if (!isLatest(tx, diarySnapshots, accountId, snapshot.id)) return;
  tx.delete(diaryStates).where(eq(diaryStates.accountId, accountId)).run();
  inChunks(
    diaries.map((entry) => ({
      accountId,
      region: entry.region,
      tier: entry.tier,
      completed: entry.completed,
    })),
    (chunk) => tx.insert(diaryStates).values(chunk).run(),
  );
}

export const questsProjection: Projection = {
  name: 'quests',

  apply(tx, event) {
    if (event.type === 'quests.snapshot') applyQuests(tx, event);
  },

  reset(tx) {
    tx.delete(questCompletions).run();
    tx.delete(questStates).run();
    tx.delete(questSnapshots).run();
  },

  snapshot(db) {
    const snapshots = db
      .select({
        userId: accounts.userId,
        accountHash: accounts.accountHash,
        eventId: questSnapshots.eventId,
        sessionId: questSnapshots.sessionId,
        takenAt: questSnapshots.takenAt,
        questPoints: questSnapshots.questPoints,
      })
      .from(questSnapshots)
      .innerJoin(accounts, eq(questSnapshots.accountId, accounts.id))
      .orderBy(
        asc(accounts.userId),
        asc(accounts.accountHash),
        asc(questSnapshots.takenAt),
        asc(questSnapshots.eventId),
      )
      .all();
    const states = db
      .select({
        userId: accounts.userId,
        accountHash: accounts.accountHash,
        quest: questStates.quest,
        name: questStates.name,
        state: questStates.state,
        kind: questStates.kind,
      })
      .from(questStates)
      .innerJoin(accounts, eq(questStates.accountId, accounts.id))
      .orderBy(asc(accounts.userId), asc(accounts.accountHash), asc(questStates.quest))
      .all();
    const completions = db
      .select({
        userId: accounts.userId,
        accountHash: accounts.accountHash,
        quest: questCompletions.quest,
        firstFinishedAt: questCompletions.firstFinishedAt,
        eventId: questCompletions.eventId,
      })
      .from(questCompletions)
      .innerJoin(accounts, eq(questCompletions.accountId, accounts.id))
      .orderBy(asc(accounts.userId), asc(accounts.accountHash), asc(questCompletions.quest))
      .all();
    return { snapshots, states, completions };
  },
};

export const diariesProjection: Projection = {
  name: 'diaries',

  apply(tx, event) {
    if (event.type === 'diaries.snapshot') applyDiaries(tx, event);
  },

  reset(tx) {
    tx.delete(diaryCompletions).run();
    tx.delete(diaryStates).run();
    tx.delete(diarySnapshots).run();
  },

  snapshot(db) {
    const snapshots = db
      .select({
        userId: accounts.userId,
        accountHash: accounts.accountHash,
        eventId: diarySnapshots.eventId,
        sessionId: diarySnapshots.sessionId,
        takenAt: diarySnapshots.takenAt,
      })
      .from(diarySnapshots)
      .innerJoin(accounts, eq(diarySnapshots.accountId, accounts.id))
      .orderBy(
        asc(accounts.userId),
        asc(accounts.accountHash),
        asc(diarySnapshots.takenAt),
        asc(diarySnapshots.eventId),
      )
      .all();
    const states = db
      .select({
        userId: accounts.userId,
        accountHash: accounts.accountHash,
        region: diaryStates.region,
        tier: diaryStates.tier,
        completed: diaryStates.completed,
      })
      .from(diaryStates)
      .innerJoin(accounts, eq(diaryStates.accountId, accounts.id))
      .orderBy(
        asc(accounts.userId),
        asc(accounts.accountHash),
        asc(diaryStates.region),
        asc(diaryStates.tier),
      )
      .all();
    const completions = db
      .select({
        userId: accounts.userId,
        accountHash: accounts.accountHash,
        region: diaryCompletions.region,
        tier: diaryCompletions.tier,
        firstCompletedAt: diaryCompletions.firstCompletedAt,
        eventId: diaryCompletions.eventId,
      })
      .from(diaryCompletions)
      .innerJoin(accounts, eq(diaryCompletions.accountId, accounts.id))
      .orderBy(
        asc(accounts.userId),
        asc(accounts.accountHash),
        asc(diaryCompletions.region),
        asc(diaryCompletions.tier),
      )
      .all();
    return { snapshots, states, completions };
  },
};
