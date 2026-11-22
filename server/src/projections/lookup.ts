import { and, eq } from 'drizzle-orm';
import type { Queryable } from '../db/index.js';
import { accounts } from '../db/schema.js';

/** An OSRS account: the same hash under two users is two accounts. */
export interface AccountKey {
  userId: number;
  accountHash: string;
}

/**
 * The `accounts.id` of the event's account (its owner and hash). The accounts
 * projection runs first for every event, so a missing row means a bug, not
 * bad input.
 */
export function accountIdOf(tx: Queryable, { userId, accountHash }: AccountKey): number {
  const id = tx
    .select({ id: accounts.id })
    .from(accounts)
    .where(and(eq(accounts.userId, userId), eq(accounts.accountHash, accountHash)))
    .get()?.id;
  if (id === undefined)
    throw new Error('accounts row missing (accounts projection must run first)');
  return id;
}
