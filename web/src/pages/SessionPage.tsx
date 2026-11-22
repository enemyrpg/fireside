import type { SessionDetailResponse } from '@fireside/shared';
import { Navigate, useParams } from 'react-router';
import { PageNotFoundError } from '@/api/errors';
import { useSession } from '@/api/hooks';
import { Card } from '@/components/Card';
import { CardSkeleton, ErrorState } from '@/components/states';
import { useHopChain, useCachedSessionList } from '@/hooks/useHopChain';
import { useIsDesktop } from '@/hooks/useIsDesktop';
import { readLastAccount, sessionScope } from '@/lib/accounts';
import { sessionHref } from '@/lib/session-groups';
import { hrefOf } from './registry';
import { isMissingSession, sessionsListPath } from './session/links';
import { SessionDetail } from './session/SessionDetail';

// Session detail as its own screen, `/sessions/:id`. On mobile the screen; on
// PC it redirects to the Sessions list with the session selected (`?session=`),
// in the scope `sessionScope` gives.

export const SESSION_NOT_FOUND = "This session doesn't exist.";

function Screen({ detail }: { detail: SessionDetailResponse }) {
  const scope = sessionScope(detail.session.accountId, readLastAccount());
  const listPath = hrefOf('sessions', scope);
  // The list the user came from, if it is in the cache: the chain without fetching.
  const chain = useHopChain(detail, useCachedSessionList(scope));
  return (
    <SessionDetail
      detail={detail}
      chain={chain}
      hrefOf={(id) => sessionHref(id, false, listPath)}
      variant="screen"
      backHref={listPath}
    />
  );
}

export function SessionPage() {
  const sessionId = useParams().sessionId ?? '';
  const desktop = useIsDesktop();
  const session = useSession(sessionId);

  // The full-page 404 (with the footer) comes from the router's error page.
  if (session.data === undefined && isMissingSession(session.error)) {
    throw new PageNotFoundError(SESSION_NOT_FOUND);
  }
  if (session.data !== undefined) {
    // PC: the list with this session selected. The cache is shared, so it shows at once.
    if (desktop) {
      return <Navigate replace to={sessionHref(sessionId, true, sessionsListPath(session.data))} />;
    }
    // Keyed by session, so "Show all" and other state start fresh on Older/Newer.
    return <Screen key={session.data.session.id} detail={session.data} />;
  }
  if (session.isError) {
    return (
      <Card>
        <ErrorState onRetry={() => void session.refetch()} />
      </Card>
    );
  }
  return (
    <div className="flex flex-col gap-4">
      <CardSkeleton lines={1} className="max-w-[480px]" />
      <CardSkeleton lines={2} />
      <Card>
        <CardSkeleton lines={3} />
      </Card>
    </div>
  );
}
