import { useRef } from 'react';
import { Outlet, ScrollRestoration, useMatches } from 'react-router';
import { useServerStatus } from '@/api/server-status';
import { AppShell } from '@/components/shell/AppShell';
import { useAccounts, useCachedSessionAccount } from '@/api/hooks';
import { parseScope, readLastAccount, sessionScope } from '@/lib/accounts';
import { SESSION_PAGE_ID } from '@/pages/registry';
import { ForbiddenPage } from '@/pages/ErrorPages';
import { useCurrentDestinationRoute, useCurrentPage } from './current-page';
import { scrollKey } from './scroll-key';
import { useFocusHeadingOnNavigation } from './useFocusHeadingOnNavigation';

/** Route id of the `/:acc` route. */
export const ACCOUNT_ROUTE_ID = 'account';

/**
 * Root layout: the shell around the current page. A `403` from any request
 * replaces the whole app with an explanation.
 */
export function RootLayout() {
  const { forbidden } = useServerStatus();
  const matches = useMatches();
  const page = useCurrentPage();
  const destinationRoute = useCurrentDestinationRoute();
  const sessionAccount = useCachedSessionAccount(
    page?.id === SESSION_PAGE_ID ? matches.at(-1)?.params.sessionId : undefined,
  );
  const accounts = useAccounts().data?.accounts;
  const heading = useRef<HTMLHeadingElement>(null);
  useFocusHeadingOnNavigation(heading);
  if (forbidden) return <ForbiddenPage />;

  const accountParam = matches.find((match) => match.id === ACCOUNT_ROUTE_ID)?.params.acc;
  // The remembered account may be gone (deleted, or a database reset): menu
  // links would then lead to "That account doesn't exist". Until the list is
  // known, `all`, which always exists.
  const remembered = readLastAccount();
  const last =
    remembered === 'all' || accounts?.some((account) => account.id === remembered) === true
      ? remembered
      : remembered === null
        ? null
        : 'all';
  // Session detail follows the session's account once loaded; other pages
  // without an account (Settings) link back to the last chosen one.
  const scope =
    parseScope(accountParam) ??
    (sessionAccount === undefined ? null : sessionScope(sessionAccount, last)) ??
    last ??
    'all';

  return (
    <>
      {/* A new page starts at the top, Back/forward returns to where it was,
          and a change of the query only never scrolls (see scroll-key.ts). */}
      <ScrollRestoration getKey={scrollKey} />
      <AppShell page={page} destinationRoute={destinationRoute} scope={scope} headingRef={heading}>
        <Outlet />
      </AppShell>
    </>
  );
}
