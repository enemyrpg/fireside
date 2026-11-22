import {
  addDays,
  fromLocal,
  PB_RECORDS_OVERALL,
  raidOf,
  toLocal,
  type BossKc,
  type TeamSizeTime,
} from '@fireside/shared';
import { sql, type SQL } from 'drizzle-orm';
import type { Queryable } from '../db/index.js';
import { kcGain } from '../projections/session-summaries.js';

// `GET …/kc`. Reads `kc_observations`, and `pb_records` for best times. `boss`
// is already normalized in both.

/** Local days in the `gainedLast30Days` window, today included. */
export const KC_GAIN_DAYS = 30;

/** Start of the `gainedLast30Days` window: local midnight 29 days before today, in UTC ms. */
export function kcGainWindowStart(nowMs: number, timeZone: string): number {
  return fromLocal(addDays(toLocal(nowMs, timeZone), 1 - KC_GAIN_DAYS), 0, 0, timeZone);
}

/** KC values of one (account, boss) pair around a window. */
export interface KcWindowRow {
  /** Highest KC in the window, `null` if none. */
  windowHigh: number | null;
  /** Last KC before the window. */
  beforeWindow: number | null;
  /** First KC in the window. */
  firstInWindow: number | null;
}

/**
 * SELECT columns `windowHigh`, `beforeWindow` and `firstInWindow` for the
 * window `[from, to)` (no upper bound without `to`), for a query whose pairs
 * come from an alias `pair` with `account_id` and `boss`. Indexed lookups on
 * (`account_id`, `boss`, `observed_at`, `event_id`). Shared by `kc`
 * (`gainedLast30Days`) and the weekly summary, so both use the same rule.
 */
export function kcWindowColumns(from: string, to?: string): SQL {
  const samePair = sql`x.account_id = pair.account_id AND x.boss = pair.boss`;
  const inWindow =
    to === undefined
      ? sql`x.observed_at >= ${from}`
      : sql`x.observed_at >= ${from} AND x.observed_at < ${to}`;
  return sql`
    (SELECT max(x.kill_count) FROM kc_observations AS x
      WHERE ${samePair} AND ${inWindow}) AS windowHigh,
    (SELECT x.kill_count FROM kc_observations AS x
      WHERE ${samePair} AND x.observed_at < ${from}
      ORDER BY x.observed_at DESC, x.event_id DESC LIMIT 1) AS beforeWindow,
    (SELECT x.kill_count FROM kc_observations AS x
      WHERE ${samePair} AND ${inWindow}
      ORDER BY x.observed_at ASC, x.event_id ASC LIMIT 1) AS firstInWindow`;
}

/**
 * KC gained in a window with the session KC rule: highest KC in the window
 * minus the last KC before it, or minus the first KC in the window if there
 * is none before. Never negative; 0 without observations in the window.
 */
export function kcWindowGain(row: KcWindowRow): number {
  return row.windowHigh === null
    ? 0
    : kcGain(row.beforeWindow ?? row.firstInWindow ?? row.windowHigh, row.windowHigh);
}

/**
 * Best time of one observation: the lower of `time_seconds` and
 * `personal_best_seconds` (since 1.14.0), `null` if neither is set. SQLite's
 * scalar `min` is `NULL` if either argument is, hence the `coalesce`.
 */
const BEST_OF_ROW = sql`coalesce(min(time_seconds, personal_best_seconds), time_seconds, personal_best_seconds)`;

/**
 * Every best time candidate in scope: one per kc observation with a time or
 * PB (`BEST_OF_ROW`), and one per `overall` record in `pb_records` (since
 * 1.17.0; room records are not used here). Columns `boss`, `teamSize`
 * (`null` if unknown) and `seconds`. PBs only get faster, so the lowest
 * candidate is always right.
 */
function bestTimeCandidates(account: SQL): SQL {
  return sql`
    SELECT boss, team_size AS teamSize, ${BEST_OF_ROW} AS seconds FROM kc_observations
    WHERE ${account} AND (time_seconds IS NOT NULL OR personal_best_seconds IS NOT NULL)
    UNION ALL
    SELECT boss, team_size AS teamSize, seconds FROM pb_records
    WHERE ${account} AND scope = ${PB_RECORDS_OVERALL}`;
}

interface PairRow extends KcWindowRow {
  accountId: number;
  boss: string;
  killCount: number;
  observedAt: string;
}

/**
 * Latest KC per boss: per account the newest observation by (`observed_at`,
 * `event_id`). For several accounts, their latest KCs are summed and
 * `lastObservedAt` is the newest. `bestTimeSeconds` is the lowest kill time,
 * reported PB or `overall` record for the boss (any account in scope,
 * `bestTimeCandidates`). `byAccount` lists each account's latest KC. Only
 * bosses with a KC observation are listed; records alone add no boss.
 *
 * `gainedLast30Days` per account uses the session KC rule (`bossKc`) on the
 * window `[windowStart, now]`: highest KC in the window minus the last KC
 * before it, or minus the first KC in the window if there is none before.
 * Never negative; summed over the accounts. Sorted by boss name.
 *
 * `category` and `raid` come from `RAIDS` (raid modes are `raid`).
 * `bestTimesByTeamSize` is the same per `team_size` (any account in scope;
 * raid PBs in the game are per team size), sorted by team size; observations
 * without a team size, or without both time and PB, are left out. A team
 * size may come from records only.
 */
export function latestKc(
  db: Queryable,
  accountIds: readonly number[],
  windowStart: string,
): BossKc[] {
  // No accounts: `0`, so nothing matches (an empty `IN ()` is a syntax error).
  const account =
    accountIds.length === 0
      ? sql`0`
      : sql`account_id IN (${sql.join(
          accountIds.map((id) => sql`${id}`),
          sql`, `,
        )})`;
  // Each (account, boss) pair, then indexed lookups on (account_id, boss,
  // observed_at, event_id): its newest row and the window values. Faster than
  // a window function, which sorts every observation.
  const samePair = sql`x.account_id = pair.account_id AND x.boss = pair.boss`;
  const rows = db.all<PairRow>(sql`
    SELECT pair.account_id AS accountId, k.boss AS boss, k.kill_count AS killCount,
      k.observed_at AS observedAt, ${kcWindowColumns(windowStart)}
    FROM (SELECT DISTINCT account_id, boss FROM kc_observations WHERE ${account}) AS pair
    JOIN kc_observations AS k ON k.id = (
      SELECT x.id FROM kc_observations AS x
      WHERE ${samePair}
      ORDER BY x.observed_at DESC, x.event_id DESC
      LIMIT 1
    )
    ORDER BY pair.account_id
  `);
  const bestTimes = db.all<{ boss: string; best: number }>(sql`
    SELECT boss, min(seconds) AS best FROM (${bestTimeCandidates(account)}) GROUP BY boss
  `);
  const best = new Map(bestTimes.map((row) => [row.boss, row.best]));
  const teamTimes = db.all<{ boss: string; teamSize: number; seconds: number }>(sql`
    SELECT boss, teamSize, min(seconds) AS seconds FROM (${bestTimeCandidates(account)})
    WHERE teamSize IS NOT NULL
    GROUP BY boss, teamSize ORDER BY boss, teamSize
  `);
  const byTeamSize = new Map<string, TeamSizeTime[]>();
  for (const { boss, teamSize, seconds } of teamTimes) {
    const times = byTeamSize.get(boss) ?? [];
    times.push({ teamSize, seconds });
    byTeamSize.set(boss, times);
  }

  const byBoss = new Map<string, BossKc>();
  for (const row of rows) {
    const gained = kcWindowGain(row);
    const entry = { accountId: row.accountId, killCount: row.killCount };
    const sum = byBoss.get(row.boss);
    if (!sum) {
      const raid = raidOf(row.boss)?.name ?? null;
      byBoss.set(row.boss, {
        boss: row.boss,
        killCount: row.killCount,
        lastObservedAt: row.observedAt,
        bestTimeSeconds: best.get(row.boss) ?? null,
        gainedLast30Days: gained,
        byAccount: [entry],
        category: raid === null ? 'boss' : 'raid',
        raid,
        bestTimesByTeamSize: byTeamSize.get(row.boss) ?? [],
      });
    } else {
      sum.killCount += row.killCount;
      sum.gainedLast30Days += gained;
      // Rows are sorted by account, so `byAccount` stays sorted.
      sum.byAccount.push(entry);
      if (row.observedAt > sum.lastObservedAt) sum.lastObservedAt = row.observedAt;
    }
  }
  return [...byBoss.values()].sort((a, b) => (a.boss < b.boss ? -1 : a.boss > b.boss ? 1 : 0));
}
