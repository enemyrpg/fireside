import type { AccountScope } from '@fireside/shared';
import { keepPreviousData, QueryCache, QueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { isServerDown } from './errors';
import { getServerStatus, subscribeServerStatus } from './server-status';

/** Data is fresh for 30 s. */
export const STALE_TIME_MS = 30_000;

/** Polling interval while a session is in progress. */
export const LIVE_POLL_MS = 30_000;

/**
 * For queries by account and period: keep showing the last data while a new
 * account or period loads. Not for single items (a session, an account), where
 * old data would show under the wrong URL.
 */
export const KEEP_PREVIOUS = { placeholderData: keepPreviousData } as const;

/**
 * Like `KEEP_PREVIOUS`, but only keeps data from the same kind of scope (one
 * account, or `all`). For data that is summed for `all` or looks different
 * there, data from `all` must not stand in for one account, or the other way
 * round: levels (a "Level 198" column), KC (summed, split per account only for
 * `all`) and loot (drops named by account only for `all`). The account scope
 * is the second part of every query key in `hooks.ts`.
 */
export function keepPreviousOfSameScopeKind(scope: AccountScope) {
  return {
    placeholderData: <T>(
      previous: T | undefined,
      previousQuery: { queryKey: readonly unknown[] } | undefined,
    ): T | undefined =>
      previousQuery !== undefined && (previousQuery.queryKey[1] === 'all') === (scope === 'all')
        ? previous
        : undefined,
  } as const;
}

/**
 * Like `KEEP_PREVIOUS`, but only keeps data of the very same scope, e.g. while
 * a new period loads. For data that belongs to one account and is shown with
 * that account's name or link (the net worth), where another account's
 * numbers must never stand in, not even between two single accounts.
 */
export function keepPreviousOfSameScope(scope: AccountScope) {
  return {
    placeholderData: <T>(
      previous: T | undefined,
      previousQuery: { queryKey: readonly unknown[] } | undefined,
    ): T | undefined => (previousQuery?.queryKey[1] === scope ? previous : undefined),
  } as const;
}

/**
 * Query options for pages that poll while a session is open: every 30 s, paused
 * while the tab is hidden. `live` is a flag, or a test of the query's own data,
 * checked again after every fetch.
 */
export function livePolling<T>(live: boolean | ((data: T | undefined) => boolean)) {
  return {
    refetchInterval: (query: { state: { data: T | undefined } }) =>
      (typeof live === 'function' ? live(query.state.data) : live) ? LIVE_POLL_MS : false,
    refetchIntervalInBackground: false,
  } as const;
}

export function createQueryClient(): QueryClient {
  return new QueryClient({
    queryCache: new QueryCache({
      onError: (error) => {
        // Never shown to the user; useful while developing.
        if (import.meta.env.DEV) console.error(error);
      },
    }),
    defaultOptions: {
      queries: {
        staleTime: STALE_TIME_MS,
        // Only retry when the server is unreachable; 4xx and 5xx answers won't change.
        retry: (failureCount, error) => isServerDown(error) && failureCount < 2,
      },
    },
  });
}

/** When the server comes back, retry every query that failed meanwhile. Used once, in App. */
export function useRefetchWhenServerBack(client: QueryClient): void {
  useEffect(() => {
    let wasDown = getServerStatus().down;
    return subscribeServerStatus(() => {
      const { down } = getServerStatus();
      if (wasDown && !down) {
        void client.refetchQueries({
          type: 'active',
          predicate: (query) => query.state.status === 'error',
        });
      }
      wasDown = down;
    });
  }, [client]);
}
