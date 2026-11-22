import type { AccountScope } from '@fireside/shared';
import { SegmentedTabs } from '@/components/Segmented';
import { destinationPages, pageHref, type Destination, type PageId } from '@/pages/registry';
import { useVisiblePages } from '@/pages/useVisiblePages';

/**
 * Sub-tabs of a destination next to the page title: `SegmentedTabs` from the
 * registry. Only pages that exist; nothing when fewer than two do.
 */
export function SubTabs({
  destination,
  active,
  scope,
}: {
  destination: Destination;
  active: PageId | undefined;
  scope: AccountScope;
}) {
  const tabs = destinationPages(destination.id, useVisiblePages());
  if (tabs.length < 2) return null;

  return (
    <SegmentedTabs
      label={`${destination.label} views`}
      tabs={tabs.map((page) => ({
        key: page.id,
        to: pageHref(page, scope),
        label: page.tab ?? page.title,
        ...(page.tabShort === undefined ? {} : { shortLabel: page.tabShort }),
        current: page.id === active,
      }))}
    />
  );
}
