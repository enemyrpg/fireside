import type { AccountScope } from '@fireside/shared';
import { DESTINATIONS, destinationPages, pageHref, type DestinationId } from '@/pages/registry';
import { useVisiblePages } from '@/pages/useVisiblePages';

/**
 * Link per destination that exists: its first sub-tab that exists. A
 * destination without a page that exists (Bank without bank data, Collections
 * before any of its pages) is left out.
 */
export function useDestinationLinks(scope: AccountScope): ReadonlyMap<DestinationId, string> {
  const pages = useVisiblePages();
  const links = new Map<DestinationId, string>();
  for (const destination of DESTINATIONS) {
    const first = destinationPages(destination.id, pages)[0];
    if (first) links.set(destination.id, pageHref(first, scope));
  }
  return links;
}
