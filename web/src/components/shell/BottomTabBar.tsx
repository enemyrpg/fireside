import type { AccountScope } from '@fireside/shared';
import { Link } from 'react-router';
import { cn } from '@/lib/utils';
import { DESTINATIONS, type DestinationId } from '@/pages/registry';
import { useDestinationLinks } from './useDestinationLinks';

/**
 * Fixed tab bar on mobile: the same destinations as the top bar on PC, only
 * those that exist. Settings is behind the profile icon in the page header, so
 * no tab is marked there.
 */
export function BottomTabBar({
  scope,
  active,
  className,
}: {
  scope: AccountScope;
  active: DestinationId | undefined;
  className?: string;
}) {
  const links = useDestinationLinks(scope);
  const tabs = DESTINATIONS.filter((destination) => links.has(destination.id));

  return (
    <nav
      aria-label="Main"
      style={{ gridTemplateColumns: `repeat(${String(tabs.length)}, minmax(0, 1fr))` }}
      className={cn(
        'fixed inset-x-0 bottom-0 z-30 grid border-t border-border bg-page pt-1.5 pr-[max(6px,var(--safe-right))] pb-[calc(6px+var(--safe-bottom))] pl-[max(6px,var(--safe-left))]',
        className,
      )}
    >
      {tabs.map((destination) => {
        const Icon = destination.icon;
        const isActive = destination.id === active;
        return (
          <Link
            key={destination.id}
            to={links.get(destination.id) ?? '/'}
            aria-current={isActive ? 'page' : undefined}
            className={cn(
              'flex min-h-[52px] flex-col items-center justify-center gap-1 rounded-xl text-axis no-underline',
              isActive
                ? 'bg-accent-wash font-semibold text-accent-text hover:text-accent-text'
                : 'text-text-3 hover:text-text',
            )}
          >
            <Icon aria-hidden="true" className="size-[22px]" />
            {destination.label}
          </Link>
        );
      })}
    </nav>
  );
}
