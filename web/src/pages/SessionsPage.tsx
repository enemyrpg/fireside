import type { Session } from '@fireside/shared';
import { useId, useMemo } from 'react';
import { Navigate, useSearchParams } from 'react-router';
import { useAccounts, useSession, useSessions } from '@/api/hooks';
import { Card } from '@/components/Card';
import { SessionRow } from '@/components/SessionRow';
import { ShortSessionsRow } from '@/components/ShortSessionsRow';
import { CardSkeleton, EmptyState, ErrorState } from '@/components/states';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { formatDuration, formatInt } from '@/format';
import { useDelayedFlag } from '@/hooks/useDelayedFlag';
import { useFormat } from '@/hooks/useFormat';
import { useHopChain } from '@/hooks/useHopChain';
import { useIsDesktop } from '@/hooks/useIsDesktop';
import { useStickyTop } from '@/hooks/useStickyTop';
import { accountColors, accountNameById } from '@/lib/accounts';
import { pickSession } from '@/lib/overview';
import {
  foldShortSessions,
  groupByDay,
  mergeHops,
  SESSION_PARAM,
  SESSIONS_PAGE_SIZE,
  sessionHref,
  sessionPath,
  type SessionDay,
  type SessionGroup,
} from '@/lib/session-groups';
import { cn } from '@/lib/utils';
import { useAccountScope } from '@/routing/useAccountScope';
import { hrefOf } from './registry';
import { SESSION_NOT_FOUND } from './SessionPage';
import { isMissingSession } from './session/links';
import { SessionDetail } from './session/SessionDetail';

// Sessions: grouped by local day with a day total, world hops under 2 minutes
// merged, short sessions folded, 20 sessions per "Load more". On PC the
// selected session sits to the right of the list (`?session=<id>`); on mobile a
// session opens its own screen.

export { SESSIONS_PAGE_SIZE };

export const SESSIONS_EMPTY = 'Your sessions show up here after you log in to the game.';

/** Day headers and rows in the shape of the list. Appears after 200 ms, like `CardSkeleton`. */
function SessionsSkeleton() {
  const shown = useDelayedFlag(true);
  return (
    <div aria-busy="true" aria-label="Loading" className="flex flex-col gap-2">
      <Skeleton className={cn('mb-1 h-5 w-40 rounded-md', !shown && 'invisible')} />
      {Array.from({ length: 5 }, (_, index) => (
        <Skeleton
          key={index}
          data-testid="skeleton-line"
          className={cn('h-[62px] rounded-xl', !shown && 'invisible')}
        />
      ))}
    </div>
  );
}

function DayHeader({ day }: { day: SessionDay }) {
  const format = useFormat();
  const count = day.groups.length;
  return (
    <h2 className="mb-2 flex items-baseline justify-between gap-2.5 px-1 text-sm">
      <span className="font-semibold">{format.localDate(day.date)}</span>
      <span className="text-xs font-normal text-text-3 tabular-nums">
        {formatDuration(day.durationSeconds)} · {formatInt(count)}{' '}
        {count === 1 ? 'session' : 'sessions'}
      </span>
    </h2>
  );
}

const holds = (group: SessionGroup, sessionId: string | undefined) =>
  sessionId !== undefined && group.parts.some((part) => part.id === sessionId);

/** The selected session on PC, in a sticky card that sticks only while it fits. */
function SessionPane({
  sessionId,
  list,
  hrefOf: linkOf,
}: {
  sessionId: string;
  list: { sessions: readonly Session[]; hasMore: boolean } | 'loading' | undefined;
  hrefOf: (sessionId: string) => string;
}) {
  const session = useSession(sessionId);
  // Re-measured when the card changes height (a section unfolds, Older/Newer).
  const { attach, top } = useStickyTop();
  const headingId = useId();

  let body;
  let named: { 'aria-labelledby': string } | { 'aria-label': string } = {
    'aria-label': 'Selected session',
  };
  if (session.data !== undefined) {
    named = { 'aria-labelledby': headingId };
    body = (
      <PaneDetail
        // Keyed by session, so "Show all" and the loot order start fresh on Older/Newer.
        key={session.data.session.id}
        detail={session.data}
        list={list}
        hrefOf={linkOf}
        headingId={headingId}
      />
    );
  } else if (isMissingSession(session.error)) {
    body = <EmptyState className="min-h-[240px]">{SESSION_NOT_FOUND}</EmptyState>;
  } else if (session.isError) {
    body = <ErrorState onRetry={() => void session.refetch()} />;
  } else {
    body = <CardSkeleton lines={6} />;
  }

  return (
    <Card ref={attach} style={{ top }} {...named} className="sticky min-w-0 desk:p-8">
      {body}
    </Card>
  );
}

function PaneDetail({
  detail,
  list,
  hrefOf: linkOf,
  headingId,
}: {
  detail: NonNullable<ReturnType<typeof useSession>['data']>;
  list: { sessions: readonly Session[]; hasMore: boolean } | 'loading' | undefined;
  hrefOf: (sessionId: string) => string;
  headingId: string;
}) {
  const chain = useHopChain(detail, list);
  return (
    <SessionDetail
      detail={detail}
      chain={chain}
      hrefOf={linkOf}
      variant="pane"
      headingId={headingId}
    />
  );
}

export function SessionsPage() {
  const scope = useAccountScope();
  const format = useFormat();
  const desktop = useIsDesktop();
  const [searchParams] = useSearchParams();
  // An empty `?session=` is no selection.
  const raw = searchParams.get(SESSION_PARAM);
  const param = raw === null || raw === '' ? undefined : raw;
  const sessions = useSessions(scope, { limit: SESSIONS_PAGE_SIZE }, { pollWhileOpen: true });
  const accounts = useAccounts().data?.accounts;
  const colors = useMemo(() => accountColors(accounts ?? []), [accounts]);
  const items = useMemo(() => sessions.data?.pages.flatMap((page) => page.items), [sessions.data]);
  const days = useMemo(
    () => (items ? groupByDay(mergeHops(items), format.timeZone) : undefined),
    [items, format.timeZone],
  );
  const list = useMemo(
    () =>
      items !== undefined
        ? { sessions: items, hasMore: sessions.hasNextPage }
        : sessions.isPending
          ? ('loading' as const)
          : undefined,
    [items, sessions.hasNextPage, sessions.isPending],
  );

  // Mobile has no pane: a selected session opens its own screen.
  if (!desktop && param !== undefined) return <Navigate replace to={sessionPath(param)} />;

  const listPath = hrefOf('sessions', scope);
  const linkOf = (sessionId: string) => sessionHref(sessionId, desktop, listPath);
  // No `?session`: the open session, else the newest. Not written to the URL.
  const selectedId = desktop ? (param ?? (items ? pickSession(items)?.id : undefined)) : undefined;

  const account = (accountId: number) => ({
    name: accountNameById(accountId, accounts ?? []),
    color: colors.get(accountId) ?? 'var(--afk)',
  });
  const row = (group: SessionGroup) => (
    <SessionRow
      key={group.key}
      group={group}
      account={account(group.accountId)}
      hrefOf={linkOf}
      selectedId={selectedId}
    />
  );

  let body;
  if (days !== undefined) {
    body =
      days.length === 0 ? (
        <Card>
          <EmptyState className="min-h-[240px]">{SESSIONS_EMPTY}</EmptyState>
        </Card>
      ) : (
        <>
          {days.map((day) => (
            <section key={day.date} aria-label={format.localDate(day.date)} className="mb-5">
              <DayHeader day={day} />
              <ul className="m-0 p-0">
                {foldShortSessions(day.groups).map((item) =>
                  item.kind === 'group' ? (
                    row(item.group)
                  ) : (
                    <ShortSessionsRow
                      key={item.run.key}
                      run={item.run}
                      colorOf={(accountId) => account(accountId).color}
                      nameOf={(accountId) => account(accountId).name}
                      selected={item.run.groups.some((group) => holds(group, selectedId))}
                    >
                      {item.run.groups.map(row)}
                    </ShortSessionsRow>
                  ),
                )}
              </ul>
            </section>
          ))}
          {sessions.hasNextPage && (
            <div className="flex justify-center">
              <Button
                variant="outline"
                size="sm"
                disabled={sessions.isFetchingNextPage}
                onClick={() => void sessions.fetchNextPage()}
              >
                {sessions.isFetchingNextPage ? 'Loading…' : 'Load more'}
              </Button>
            </div>
          )}
          {sessions.isFetchNextPageError && (
            <ErrorState className="min-h-0" onRetry={() => void sessions.fetchNextPage()} />
          )}
        </>
      );
  } else if (sessions.isError) {
    body = (
      <Card>
        <ErrorState onRetry={() => void sessions.refetch()} />
      </Card>
    );
  } else {
    body = <SessionsSkeleton />;
  }

  // The rows follow the list's own width (`@container/list`, 500 px), not the
  // window: on PC at about 960 px the list column is as narrow as a phone.
  if (!desktop) return <div className="@container/list w-full">{body}</div>;

  return (
    <div
      className={cn(
        'grid items-start gap-6 wide:gap-7',
        selectedId !== undefined && 'grid-cols-[minmax(0,2fr)_minmax(0,3fr)]',
      )}
    >
      <div className="@container/list min-w-0">{body}</div>
      {selectedId !== undefined && (
        <SessionPane sessionId={selectedId} list={list} hrefOf={linkOf} />
      )}
    </div>
  );
}
