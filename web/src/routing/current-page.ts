import { useMatches } from 'react-router';
import type { DestinationId, PageDef } from '@/pages/registry';

/** Route `handle` of every page route. */
export interface PageHandle {
  page: PageDef;
}

/** Route `handle` of a destination's own path (`/:acc/collections`), which redirects. */
export interface DestinationHandle {
  destination: DestinationId;
}

/** Marks a route that only redirects (`/`, old paths, a destination's own path). */
export interface RedirectHandle {
  redirect: true;
}

function isRedirectHandle(handle: unknown): handle is RedirectHandle {
  return typeof handle === 'object' && handle !== null && 'redirect' in handle;
}

/** Whether the current route only redirects, so no page is shown yet. */
export function useIsRedirectRoute(): boolean {
  const handle = useMatches().at(-1)?.handle;
  return isRedirectHandle(handle);
}

function isPageHandle(handle: unknown): handle is PageHandle {
  return typeof handle === 'object' && handle !== null && 'page' in handle;
}

function isDestinationHandle(handle: unknown): handle is DestinationHandle {
  return typeof handle === 'object' && handle !== null && 'destination' in handle;
}

/**
 * The destination of a route that is no page but redirects to one, while it
 * waits for the answer (`/:acc/collections`). The shell marks it meanwhile.
 */
export function useCurrentDestinationRoute(): DestinationId | undefined {
  return useMatches()
    .map((match) => match.handle)
    .findLast(isDestinationHandle)?.destination;
}

/** The registry page of the current route, if any (not on the 404 page). */
export function useCurrentPage(): PageDef | undefined {
  return useMatches()
    .map((match) => match.handle)
    .findLast(isPageHandle)?.page;
}
