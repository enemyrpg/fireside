import {
  compareByName,
  DIARY_TIERS,
  diaryRegionName,
  questTotalsOf,
  type DiariesResponse,
  type DiaryRegionResponse,
  type DiaryTier,
  type QuestsResponse,
} from '@fireside/shared';
import { and, asc, desc, eq, ne } from 'drizzle-orm';
import type { Queryable } from '../db/index.js';
import {
  diaryCompletions,
  diarySnapshots,
  diaryStates,
  questCompletions,
  questSnapshots,
  questStates,
} from '../db/schema.js';

// Read side of `quest_*` and `diary_*`. One account at a time.

type SnapshotTable = typeof questSnapshots | typeof diarySnapshots;

/** Event ID of the account's earliest snapshot: its baseline. */
function baselineEventId(
  db: Queryable,
  table: SnapshotTable,
  accountId: number,
): string | undefined {
  return db
    .select({ eventId: table.eventId })
    .from(table)
    .where(eq(table.accountId, accountId))
    .orderBy(asc(table.takenAt), asc(table.eventId))
    .limit(1)
    .get()?.eventId;
}

/**
 * When each quest was first seen as finished, by quest key. The rule for
 * "first seen as finished", in one place (Weekly and goals use it too): what
 * was already finished in the account's earliest snapshot was finished before
 * tracking started and has no date, so it is left out.
 */
export function questCompletionDates(db: Queryable, accountId: number): Map<string, string> {
  const baseline = baselineEventId(db, questSnapshots, accountId);
  if (baseline === undefined) return new Map();
  const rows = db
    .select({ quest: questCompletions.quest, at: questCompletions.firstFinishedAt })
    .from(questCompletions)
    .where(and(eq(questCompletions.accountId, accountId), ne(questCompletions.eventId, baseline)))
    .all();
  return new Map(rows.map((row) => [row.quest, row.at]));
}

/** Key of one diary tier in `diaryCompletionDates`. */
export function diaryTierKey(region: string, tier: DiaryTier): string {
  return `${region}:${tier}`;
}

/** As `questCompletionDates`, for diary tiers: one row per tier with a date. */
export function diaryCompletionRows(
  db: Queryable,
  accountId: number,
): { region: string; tier: DiaryTier; at: string }[] {
  const baseline = baselineEventId(db, diarySnapshots, accountId);
  if (baseline === undefined) return [];
  return db
    .select({
      region: diaryCompletions.region,
      tier: diaryCompletions.tier,
      at: diaryCompletions.firstCompletedAt,
    })
    .from(diaryCompletions)
    .where(and(eq(diaryCompletions.accountId, accountId), ne(diaryCompletions.eventId, baseline)))
    .all();
}

/** `diaryCompletionRows` by `diaryTierKey`. */
export function diaryCompletionDates(db: Queryable, accountId: number): Map<string, string> {
  return new Map(
    diaryCompletionRows(db, accountId).map((row) => [diaryTierKey(row.region, row.tier), row.at]),
  );
}

/** `GET /accounts/:accountId/quests`. */
export function quests(db: Queryable, accountId: number): QuestsResponse {
  const latest = db
    .select({ takenAt: questSnapshots.takenAt, questPoints: questSnapshots.questPoints })
    .from(questSnapshots)
    .where(eq(questSnapshots.accountId, accountId))
    .orderBy(desc(questSnapshots.takenAt), desc(questSnapshots.eventId))
    .limit(1)
    .get();
  const dates = questCompletionDates(db, accountId);
  const list = db
    .select()
    .from(questStates)
    .where(eq(questStates.accountId, accountId))
    .all()
    .map((row) => ({
      quest: row.quest,
      name: row.name,
      kind: row.kind ?? ('QUEST' as const),
      state: row.state,
      // A quest that is no longer finished keeps its row but shows no date.
      finishedAt: row.state === 'FINISHED' ? (dates.get(row.quest) ?? null) : null,
    }))
    .sort((a, b) => compareByName({ name: a.name, key: a.quest }, { name: b.name, key: b.quest }));
  return {
    accountId,
    updatedAt: latest?.takenAt ?? null,
    questPoints: latest?.questPoints ?? 0,
    totals: questTotalsOf(list, 'QUEST'),
    miniquestTotals: questTotalsOf(list, 'MINIQUEST'),
    quests: list,
  };
}

/** `GET /accounts/:accountId/diaries`. */
export function diaries(db: Queryable, accountId: number): DiariesResponse {
  const latest = db
    .select({ takenAt: diarySnapshots.takenAt })
    .from(diarySnapshots)
    .where(eq(diarySnapshots.accountId, accountId))
    .orderBy(desc(diarySnapshots.takenAt), desc(diarySnapshots.eventId))
    .limit(1)
    .get();
  const dates = diaryCompletionDates(db, accountId);
  const byRegion = new Map<string, Map<DiaryTier, boolean>>();
  for (const row of db
    .select()
    .from(diaryStates)
    .where(eq(diaryStates.accountId, accountId))
    .all()) {
    const tiers = byRegion.get(row.region) ?? new Map<DiaryTier, boolean>();
    tiers.set(row.tier, row.completed);
    byRegion.set(row.region, tiers);
  }
  const regions: DiaryRegionResponse[] = [...byRegion]
    .map(([region, states]) => {
      const tiers = DIARY_TIERS.filter((tier) => states.has(tier)).map((tier) => {
        const completed = states.get(tier) === true;
        return {
          tier,
          completed,
          completedAt: completed ? (dates.get(diaryTierKey(region, tier)) ?? null) : null,
        };
      });
      return {
        region,
        name: diaryRegionName(region),
        completed: tiers.filter((tier) => tier.completed).length,
        tiers,
      };
    })
    .sort((a, b) =>
      compareByName({ name: a.name, key: a.region }, { name: b.name, key: b.region }),
    );
  return {
    accountId,
    updatedAt: latest?.takenAt ?? null,
    totals: {
      tiers: regions.reduce((sum, region) => sum + region.tiers.length, 0),
      completed: regions.reduce((sum, region) => sum + region.completed, 0),
      regionsCompleted: regions.filter((region) => region.completed === DIARY_TIERS.length).length,
    },
    regions,
  };
}
