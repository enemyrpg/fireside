import type { SessionStartEvent } from '@fireside/shared';
import { and, asc, desc, eq, isNotNull, sql, type SQL } from 'drizzle-orm';
import type { Queryable } from '../db/index.js';
import { accountIds, accountNames, accounts, events, type AccountNameRow } from '../db/schema.js';
import type { Projection, Stored } from './framework.js';
import type { AccountKey } from './lookup.js';

// `accounts` and `account_names`.
//
// Incremental, and the same for any arrival order:
// - first/last seen are a running min/max;
// - name and type follow the latest *projected* `session.start`;
// - a name period's `last_seen_at` is a running max, and a `session.start`
//   that lands inside a period splits it, recomputing only the pieces from
//   events that were projected successfully.
// Events that failed or are still pending are never read from `events`, so a
// failed event never shows up in the derived state.

/** Position of an event in the global order: `occurredAt`, then `eventId`. */
interface Key {
  occurredAt: string;
  eventId: string;
}

function isBefore(a: Key, b: Key): boolean {
  return a.occurredAt < b.occurredAt || (a.occurredAt === b.occurredAt && a.eventId < b.eventId);
}

function startKey(period: AccountNameRow): Key {
  return { occurredAt: period.firstSeenAt, eventId: period.firstEventId };
}

function atOrAfter(key: Key): SQL {
  return sql`(${events.occurredAt}, ${events.eventId}) >= (${key.occurredAt}, ${key.eventId})`;
}

function before(key: Key): SQL {
  return sql`(${events.occurredAt}, ${events.eventId}) < (${key.occurredAt}, ${key.eventId})`;
}

interface Range {
  type?: string | undefined;
  /** Inclusive. */
  from?: Key | undefined;
  /** Exclusive. */
  to?: Key | undefined;
}

/** First or last successfully projected event of the account (owner and hash) in the range. */
function projectedEvent(
  tx: Queryable,
  { userId, accountHash }: AccountKey,
  { type, from, to }: Range,
  which: 'first' | 'last',
): Key | undefined {
  const order = which === 'first' ? asc : desc;
  return tx
    .select({ occurredAt: events.occurredAt, eventId: events.eventId })
    .from(events)
    .where(
      and(
        eq(events.userId, userId),
        eq(events.accountHash, accountHash),
        type === undefined ? undefined : eq(events.type, type),
        isNotNull(events.processedAt),
        from && atOrAfter(from),
        to && before(to),
      ),
    )
    .orderBy(order(events.occurredAt), order(events.eventId))
    .limit(1)
    .get();
}

/** Latest `occurredAt` in `[from, to)` over projected events, plus `current` if it's in range. */
function lastSeenIn(
  tx: Queryable,
  account: AccountKey,
  from: Key,
  to: Key | undefined,
  current?: Key,
): string {
  let last = projectedEvent(tx, account, { from, to }, 'last')?.occurredAt ?? from.occurredAt;
  if (
    current &&
    !isBefore(current, from) &&
    (!to || isBefore(current, to)) &&
    current.occurredAt > last
  ) {
    last = current.occurredAt;
  }
  return last;
}

/**
 * The account's ID from `account_ids` (created on first sight). Looked up
 * first, so an existing account never uses up a number of the AUTOINCREMENT
 * counter (an `INSERT … ON CONFLICT DO NOTHING` does, once per event).
 * Projections run inside a write transaction, so nobody can insert the same
 * row between the lookup and the insert.
 */
export function accountIdFor(tx: Queryable, { userId, accountHash }: AccountKey): number {
  const existing = tx
    .select({ id: accountIds.id })
    .from(accountIds)
    .where(and(eq(accountIds.userId, userId), eq(accountIds.accountHash, accountHash)))
    .get();
  if (existing) return existing.id;
  return tx
    .insert(accountIds)
    .values({ userId, accountHash })
    .returning({ id: accountIds.id })
    .get().id;
}

/**
 * The account's ID from `account_ids`, with its row in `accounts` up to date.
 * The account is (owner, hash): another user's copy of the same hash is a
 * different account.
 */
function upsertAccount(tx: Queryable, account: AccountKey, occurredAt: string): number {
  const { userId, accountHash } = account;
  const id = accountIdFor(tx, account);

  tx.insert(accounts)
    .values({ id, userId, accountHash, firstSeenAt: occurredAt, lastSeenAt: occurredAt })
    .onConflictDoUpdate({
      target: accounts.id,
      set: {
        firstSeenAt: sql`min(${accounts.firstSeenAt}, excluded.first_seen_at)`,
        lastSeenAt: sql`max(${accounts.lastSeenAt}, excluded.last_seen_at)`,
      },
    })
    .run();
  return id;
}

function periodsOf(tx: Queryable, accountId: number): AccountNameRow[] {
  return tx
    .select()
    .from(accountNames)
    .where(eq(accountNames.accountId, accountId))
    .orderBy(asc(accountNames.firstSeenAt), asc(accountNames.firstEventId))
    .all();
}

/** Index of the period that `key` falls in (the last one starting at or before it), or -1. */
function containingPeriod(periods: readonly AccountNameRow[], key: Key): number {
  let found = -1;
  periods.forEach((period, index) => {
    if (!isBefore(key, startKey(period))) found = index;
  });
  return found;
}

function insertPeriod(
  tx: Queryable,
  accountId: number,
  displayName: string,
  start: Key,
  lastSeenAt: string,
): void {
  tx.insert(accountNames)
    .values({
      accountId,
      displayName,
      firstSeenAt: start.occurredAt,
      firstEventId: start.eventId,
      lastSeenAt,
    })
    .run();
}

/** Updates the current name/type and the name periods for a new `session.start`. */
function applySessionStart(
  tx: Queryable,
  accountId: number,
  event: Stored<SessionStartEvent>,
): void {
  const account: AccountKey = event;
  const { displayName, accountType } = event.payload;
  const key: Key = { occurredAt: event.occurredAt, eventId: event.eventId };

  // Name and type: only if this is later than every projected session.start.
  const latest = projectedEvent(tx, account, { type: 'session.start' }, 'last');
  if (!latest || isBefore(latest, key)) {
    tx.update(accounts).set({ displayName, accountType }).where(eq(accounts.id, accountId)).run();
  }

  const periods = periodsOf(tx, accountId);
  const index = containingPeriod(periods, key);
  const current = periods[index];
  const next = periods[index + 1];
  const nextKey = next && startKey(next);

  // Same name as the period it lands in: only `last_seen_at` can change.
  if (current?.displayName === displayName) return;

  if (current) {
    // Split: `current` now ends just before this event.
    if (current.lastSeenAt >= key.occurredAt) {
      tx.update(accountNames)
        .set({ lastSeenAt: lastSeenIn(tx, account, startKey(current), key) })
        .where(eq(accountNames.id, current.id))
        .run();
    }
    // A later login with the old name inside the old period continues it.
    const resumed = projectedEvent(
      tx,
      account,
      { type: 'session.start', from: key, to: nextKey },
      'first',
    );
    if (resumed) {
      insertPeriod(tx, accountId, displayName, key, lastSeenIn(tx, account, key, resumed, key));
      insertPeriod(
        tx,
        accountId,
        current.displayName,
        resumed,
        lastSeenIn(tx, account, resumed, nextKey),
      );
      return;
    }
  }

  if (next?.displayName === displayName) {
    // Starts the next period earlier. Its `last_seen_at` is already later.
    tx.update(accountNames)
      .set({ firstSeenAt: key.occurredAt, firstEventId: key.eventId })
      .where(eq(accountNames.id, next.id))
      .run();
    return;
  }
  insertPeriod(tx, accountId, displayName, key, lastSeenIn(tx, account, key, nextKey, key));
}

/** Extends the `last_seen_at` of the period the event falls in. */
function extendPeriod(tx: Queryable, accountId: number, key: Key): void {
  const periods = periodsOf(tx, accountId);
  const period = periods[containingPeriod(periods, key)];
  if (period && period.lastSeenAt < key.occurredAt) {
    tx.update(accountNames)
      .set({ lastSeenAt: key.occurredAt })
      .where(eq(accountNames.id, period.id))
      .run();
  }
}

export const accountsProjection: Projection = {
  name: 'accounts',

  apply(tx, event) {
    // Any event type creates the account; identity is (owner, hash), never the name.
    const accountId = upsertAccount(tx, event, event.occurredAt);
    if (event.type === 'session.start') applySessionStart(tx, accountId, event);
    extendPeriod(tx, accountId, { occurredAt: event.occurredAt, eventId: event.eventId });
  },

  reset(tx) {
    // `account_ids` is kept, so accounts get their old IDs back on replay.
    tx.delete(accountNames).run();
    tx.delete(accounts).run();
  },

  snapshot(db) {
    const accountRows = db
      .select({
        userId: accounts.userId,
        accountHash: accounts.accountHash,
        accountType: accounts.accountType,
        displayName: accounts.displayName,
        firstSeenAt: accounts.firstSeenAt,
        lastSeenAt: accounts.lastSeenAt,
      })
      .from(accounts)
      .orderBy(asc(accounts.userId), asc(accounts.accountHash))
      .all();
    const nameRows = db
      .select({
        userId: accounts.userId,
        accountHash: accounts.accountHash,
        displayName: accountNames.displayName,
        firstSeenAt: accountNames.firstSeenAt,
        firstEventId: accountNames.firstEventId,
        lastSeenAt: accountNames.lastSeenAt,
      })
      .from(accountNames)
      .innerJoin(accounts, eq(accountNames.accountId, accounts.id))
      .orderBy(
        asc(accounts.userId),
        asc(accounts.accountHash),
        asc(accountNames.firstSeenAt),
        asc(accountNames.firstEventId),
      )
      .all();
    return { accounts: accountRows, accountNames: nameRows };
  },
};
