import { generatePath, Navigate, useLocation, useParams } from 'react-router';
import { PageNotFoundError } from '@/api/errors';
import { Card } from '@/components/Card';
import { CardSkeleton } from '@/components/states';
import {
  destinationPages,
  pageHref,
  PAGES,
  type DestinationId,
  type PageDef,
} from '@/pages/registry';
import { usePageExists } from '@/pages/useVisiblePages';

/**
 * An old path (`/:acc/loot/kc?x`) that moved: replaces itself with the
 * page's new path, keeping the parameters (`:week`), the query and the hash.
 * `replace`, so Back skips the old URL.
 */
export function LegacyRedirect({ page }: { page: PageDef }) {
  const { acc = 'all', ...params } = useParams();
  const { search, hash } = useLocation();
  const path = generatePath(`/:acc/${page.path}`, { ...params, acc });
  return <Navigate to={`${path}${search}${hash}`} replace />;
}

/**
 * A destination's own path (`/:acc/collections`): its first sub-tab that
 * exists, with the query and hash kept. Waits while that is unknown; the
 * full-page 404 when none of its pages exists.
 */
export function DestinationRedirect({ destination }: { destination: DestinationId }) {
  const { acc } = useParams();
  const { search, hash } = useLocation();
  const exists = usePageExists();
  // In menu order: a later tab only once every earlier one is known to be
  // missing, so the result never depends on which answer came first.
  for (const page of destinationPages(destination, PAGES)) {
    const known = exists(page);
    if (known === true) {
      return <Navigate to={`${pageHref(page, acc ?? 'all')}${search}${hash}`} replace />;
    }
    if (known === undefined) return <Waiting />;
  }
  throw new PageNotFoundError("This page doesn't exist.");
}

function Waiting() {
  return (
    <Card>
      <CardSkeleton />
    </Card>
  );
}
