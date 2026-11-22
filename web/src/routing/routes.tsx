import type { RouteObject } from 'react-router';
import { NotFoundPage, RouteErrorPage } from '@/pages/ErrorPages';
import { DESTINATIONS, PAGES, type PageDef } from '@/pages/registry';
import { AccountRoute, RootRedirect } from './AccountRoute';
import type { DestinationHandle, PageHandle, RedirectHandle } from './current-page';
import { DestinationRedirect, LegacyRedirect } from './LegacyRedirect';
import { PageGate } from './PageGate';
import { PAGE_COMPONENTS } from './page-components';
import { ACCOUNT_ROUTE_ID, RootLayout } from './RootLayout';

function pageRoute(page: PageDef): RouteObject {
  const handle: PageHandle = { page };
  const Component = PAGE_COMPONENTS[page.id];
  // A page that needs data exists only once the data does (`requires`).
  const element = (
    <PageGate page={page}>
      <Component />
    </PageGate>
  );
  if (page.scoped && page.path === '') return { index: true, element, handle };
  return { path: page.path, element, handle };
}

/** The old paths of a page, each redirecting to its current path. */
function oldPathRoutes(page: PageDef): RouteObject[] {
  // The handle marks the page in the menus for the moment before the redirect.
  const handle: PageHandle & RedirectHandle = { page, redirect: true };
  return (page.oldPaths ?? []).map((path) => ({
    path,
    element: <LegacyRedirect page={page} />,
    handle,
  }));
}

/**
 * Routes from the page registry. Account pages live under `/:acc`, with redirects
 * from their old paths and from each destination's own path to its first sub-tab;
 * anything that matches nothing gets the full-page 404.
 */
export function createRoutes(): RouteObject[] {
  const scoped = PAGES.filter((page) => page.scoped);
  return [
    {
      id: 'root',
      element: <RootLayout />,
      errorElement: <RouteErrorPage />,
      children: [
        {
          index: true,
          element: <RootRedirect />,
          handle: { redirect: true } satisfies RedirectHandle,
        },
        ...PAGES.filter((page) => !page.scoped).map(pageRoute),
        {
          id: ACCOUNT_ROUTE_ID,
          path: ':acc',
          element: <AccountRoute />,
          children: [
            ...scoped.map(pageRoute),
            ...scoped.flatMap(oldPathRoutes),
            ...DESTINATIONS.flatMap(({ id, path }) =>
              path === undefined
                ? []
                : [
                    {
                      path,
                      element: <DestinationRedirect destination={id} />,
                      handle: { destination: id, redirect: true } satisfies DestinationHandle &
                        RedirectHandle,
                    },
                  ],
            ),
          ],
        },
      ],
    },
    { path: '*', element: <NotFoundPage /> },
  ];
}
