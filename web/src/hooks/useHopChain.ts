import type {
  AccountScope,
  Session,
  SessionDetailResponse,
  SessionsResponse,
} from '@fireside/shared';
import { useQueries, useQueryClient, type InfiniteData } from '@tanstack/react-query';
import { useMemo } from 'react';
import { sessionQuery } from '@/api/hooks';
import { SESSIONS_PAGE_SIZE } from '@/lib/session-groups';
import { chainFromList, listSessions, walkHopChain, type KnownSession } from '@/lib/hop-chain';

export interface HopChain {
  /** Oldest first, with the session itself. One part: not a chain. */
  parts: readonly Session[];
  /** The walk stopped at its limit, so there may be more parts. */
  capped: boolean;
}

/**
 * The Sessions list of a scope as it is in the cache, without fetching
 * (the mobile screen, opened from the list). `undefined` when not loaded.
 */
export function useCachedSessionList(
  scope: AccountScope,
): { sessions: Session[]; hasMore: boolean } | undefined {
  const queryClient = useQueryClient();
  const data = queryClient.getQueryData<InfiniteData<SessionsResponse>>([
    'sessions',
    scope,
    { limit: SESSIONS_PAGE_SIZE },
  ]);
  return useMemo(() => (data ? listSessions(data.pages) : undefined), [data]);
}

/**
 * The hop chain of a session. From the loaded list when it surely has the whole chain,
 * else by walking `neighbors` with the same queries as `useSession` (at most
 * `HOP_CHAIN_MAX_STEPS` fetches). `undefined` while the walk is still going, so the bar
 * does not flicker in. `list`: the loaded list, `'loading'` while it loads, or
 * `undefined` when there is none.
 */
export function useHopChain(
  detail: SessionDetailResponse,
  list: { sessions: readonly Session[]; hasMore: boolean } | 'loading' | undefined,
): HopChain | undefined {
  const id = detail.session.id;
  const loaded = list === 'loading' ? undefined : list;
  const fromList = useMemo(
    () => (loaded ? chainFromList(loaded.sessions, loaded.hasMore, detail.session) : undefined),
    [loaded, detail.session],
  );

  // Walks over what the cache has (the same keys as `useSession`), asking for
  // what is missing; `useQueries` fetches those and renders again when they
  // arrive, and the walk goes one step further. No state of its own.
  const queryClient = useQueryClient();
  const lookup = (sessionId: string): KnownSession | null | undefined => {
    if (sessionId === id) return detail;
    const query = queryClient
      .getQueryCache()
      .find<SessionDetailResponse>({ queryKey: sessionQuery(sessionId).queryKey, exact: true });
    const state = query?.state;
    if (state?.data === undefined) return state?.status === 'error' ? null : undefined;
    // A copy that is out of date and being fetched again (e.g. cached while the
    // part was live, before its hop) waits for the new one, so the walk does not
    // stop early on old data. After a failed fetch the old copy is the best there is.
    if (state.status !== 'error' && state.fetchStatus === 'fetching' && query?.isStale()) {
      return undefined;
    }
    return state.data;
  };
  // While the list is still loading, wait for it: it usually has the chain.
  const walk =
    fromList === undefined && list !== 'loading' ? walkHopChain(detail, lookup) : undefined;
  // Every session the walk has looked at stays subscribed, so the chain follows updates.
  const touched = walk ? [...walk.parts.map((part) => part.id), ...walk.pending] : [];
  useQueries({
    queries: touched
      .filter((sessionId) => sessionId !== id)
      // The usual retries, so a short outage does not end the chain.
      .map((sessionId) => sessionQuery(sessionId)),
  });

  if (fromList !== undefined) return { parts: fromList, capped: false };
  if (walk === undefined || walk.pending.length > 0) return undefined;
  return { parts: walk.parts, capped: walk.capped };
}
