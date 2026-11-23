import type { AccountDetailResponse, AccountSummary, LatestSession } from '@fireside/shared';
import { and, asc, desc, eq, sql, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/sqlite-core';
import type { Queryable } from '../db/index.js';
import { accountNames, accounts, sessions, xpSnapshots } from '../db/schema.js';

// `GET /accounts` and `GET /accounts/:accountId`. Reads `accounts`,
// `account_names`, the latest `xp_snapshots` row and the newest `sessions`
// row per account.
//
// Every lookup here takes the user: a user only ever sees their own accounts,
// and another user's account ID is not found, the same as an unknown one.
// Routes resolve `:accountId` with `routes/account-scope.ts`.

const latest = alias(xpSnapshots, 'latest');
const newest = alias(sessions, 'newest');

/**
 * The user's accounts (narrowed by `where`) with totals from their latest
 * snapshot and the state of their newest session, in one query: each row
 * joins the snapshot and the session found by an indexed lookup
 * (`xp_snapshots_account_taken_idx`, `sessions_account_started_idx`), so the
 * cost does not grow with the number of sessions.
 */
function summaries(db: Queryable, userId: number, where?: SQL): AccountSummary[] {
  // A query builder (not raw column names) keeps the columns table-qualified.
  const latestId = db
    .select({ id: xpSnapshots.id })
    .from(xpSnapshots)
    .where(eq(xpSnapshots.accountId, accounts.id))
    .orderBy(desc(xpSnapshots.takenAt), desc(xpSnapshots.eventId))
    .limit(1);
  const newestId = db
    .select({ id: sessions.id })
    .from(sessions)
    .where(eq(sessions.accountId, accounts.id))
    .orderBy(desc(sessions.startedAt), desc(sessions.id))
    .limit(1);
  return db
    .select({
      account: accounts,
      totalXp: latest.totalXp,
      totalLevel: latest.totalLevel,
      sessionId: newest.id,
      endedAt: newest.endedAt,
      endReason: newest.endReason,
    })
    .from(accounts)
    .leftJoin(latest, eq(latest.id, sql`(${latestId})`))
    .leftJoin(newest, eq(newest.id, sql`(${newestId})`))
    .where(and(eq(accounts.userId, userId), where))
    .orderBy(asc(accounts.id))
    .all()
    .map(({ account, totalXp, totalLevel, sessionId, endedAt, endReason }) => ({
      id: account.id,
      // Both are `null` until the first `session.start`.
      displayName: account.displayName,
      accountType: account.accountType as AccountSummary['accountType'],
      firstSeenAt: account.firstSeenAt,
      lastSeenAt: account.lastSeenAt,
      totalLevel,
      totalXp,
      // Facts only: the dashboard decides "online" with its own clock.
      latestSession:
        sessionId === null ? null : { endedAt, endReason: endReason as LatestSession['endReason'] },
    }));
}

/** The user's accounts, by ID. */
export function listAccounts(db: Queryable, userId: number): AccountSummary[] {
  return summaries(db, userId);
}

/** IDs of the user's accounts, by ID: what `all` means. */
export function ownedAccountIds(db: Queryable, userId: number): number[] {
  return db
    .select({ id: accounts.id })
    .from(accounts)
    .where(eq(accounts.userId, userId))
    .orderBy(asc(accounts.id))
    .all()
    .map((row) => row.id);
}

/** Whether the user has an account with this ID. */
export function ownsAccount(db: Queryable, userId: number, id: number): boolean {
  return (
    db
      .select({ id: accounts.id })
      .from(accounts)
      .where(and(eq(accounts.id, id), eq(accounts.userId, userId)))
      .get() !== undefined
  );
}

/** One of the user's accounts with its name history (oldest first), or `undefined`. */
export function accountDetail(
  db: Queryable,
  userId: number,
  id: number,
): AccountDetailResponse | undefined {
  const [summary] = summaries(db, userId, eq(accounts.id, id));
  if (!summary) return undefined;
  const names = db
    .select({
      displayName: accountNames.displayName,
      firstSeenAt: accountNames.firstSeenAt,
      lastSeenAt: accountNames.lastSeenAt,
    })
    .from(accountNames)
    .where(eq(accountNames.accountId, id))
    .orderBy(asc(accountNames.firstSeenAt), asc(accountNames.firstEventId))
    .all();
  return { ...summary, names };
}
