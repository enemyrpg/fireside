import type { AccountScope } from '@fireside/shared';
import type { FastifyRequest } from 'fastify';
import type { UserRow } from '../db/schema.js';
import { ApiError } from '../errors.js';
import { ownedAccountIds, ownsAccount } from '../read/accounts.js';

// Ownership of `:accountId` on dashboard endpoints. The one place that turns
// the request's user and `:accountId` (an ID or `all`) into the account IDs a
// read may touch. `all` means "all my accounts". Another user's account ID is
// not found, the same `404` as an unknown ID, for admins too: an admin can't
// see other users' game data in the dashboard.

export function accountNotFound(): ApiError {
  return new ApiError(404, 'NOT_FOUND', 'Account not found');
}

/**
 * The user the request acts as (set by the dashboard hook, see
 * auth/dashboard-auth.ts). Only missing on a `public` route without a
 * session, where it is a `401`.
 */
export function requestUser(request: FastifyRequest): UserRow {
  if (!request.user) throw new ApiError(401, 'UNAUTHORIZED', 'Log in to continue');
  return request.user;
}

/**
 * Account IDs for `:accountId`: the ID itself if the user owns it, or every
 * account the user owns for `all` (possibly none). `404` for any other ID.
 */
export function scopeIds(request: FastifyRequest, scope: AccountScope): number[] {
  const user = requestUser(request);
  if (scope === 'all') return ownedAccountIds(request.server.db, user.id);
  return [ownedAccount(request, scope)];
}

/** `:accountId` on routes that take one account only. `404` unless the user owns it. */
export function ownedAccount(request: FastifyRequest, accountId: number): number {
  const user = requestUser(request);
  if (!ownsAccount(request.server.db, user.id, accountId)) throw accountNotFound();
  return accountId;
}
