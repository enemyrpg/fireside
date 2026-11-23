import { and, eq, gt, inArray, lt } from 'drizzle-orm';
import type { Queryable } from '../db/index.js';
import { sessionAfkEstimates, sessionAfkPeriods, sessions } from '../db/schema.js';

// The AFK periods every read path uses: the stored `session.afk` periods plus
// the estimate from idle heartbeats (`session_afk_estimates`, written by the
// sessions projection). Reads never apply AFK rules of their own
// (docs/architecture.md#sessions).

export interface SessionAfkPeriod {
  sessionId: string;
  startedAt: string;
  endedAt: string;
}

/** AFK periods of one session, real and estimated, unsorted. */
export function afkPeriodsOfSession(db: Queryable, sessionId: string): SessionAfkPeriod[] {
  const columns = (table: typeof sessionAfkPeriods | typeof sessionAfkEstimates) => ({
    sessionId: table.sessionId,
    startedAt: table.startedAt,
    endedAt: table.endedAt,
  });
  return [
    ...db
      .select(columns(sessionAfkPeriods))
      .from(sessionAfkPeriods)
      .where(eq(sessionAfkPeriods.sessionId, sessionId))
      .all(),
    ...db
      .select(columns(sessionAfkEstimates))
      .from(sessionAfkEstimates)
      .where(eq(sessionAfkEstimates.sessionId, sessionId))
      .all(),
  ];
}

/** AFK periods, real and estimated, of the accounts' sessions that overlap `[from, to)`. */
export function afkPeriodsOverlapping(
  db: Queryable,
  accountIds: readonly number[],
  from: string,
  to: string,
): SessionAfkPeriod[] {
  const read = (table: typeof sessionAfkPeriods | typeof sessionAfkEstimates) =>
    db
      .select({ sessionId: table.sessionId, startedAt: table.startedAt, endedAt: table.endedAt })
      .from(table)
      .innerJoin(sessions, eq(sessions.id, table.sessionId))
      .where(
        and(
          inArray(sessions.accountId, accountIds),
          lt(table.startedAt, to),
          gt(table.endedAt, from),
        ),
      )
      .all();
  return [...read(sessionAfkPeriods), ...read(sessionAfkEstimates)];
}
