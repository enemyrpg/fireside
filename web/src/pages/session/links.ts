import type { SessionDetailResponse } from '@fireside/shared';
import { ApiError, isNotFound } from '@/api/errors';
import { readLastAccount, sessionScope } from '@/lib/accounts';
import { hrefOf } from '../registry';

// Shared by the Sessions list (the pane on PC) and the Session screen.

/** A malformed ID (`400` on the path) is just as missing as an unknown one. */
export function isMissingSession(error: unknown): boolean {
  return (
    isNotFound(error) ||
    (error instanceof ApiError &&
      error.code === 'VALIDATION_ERROR' &&
      error.details.some((detail) => detail.path.startsWith('params.')))
  );
}

/** The Sessions list a session belongs under: its own account, or `all` if that was last. */
export function sessionsListPath(detail: SessionDetailResponse): string {
  return hrefOf('sessions', sessionScope(detail.session.accountId, readLastAccount()));
}
