import type { AccountScope } from '@fireside/shared';
import { BRANDING } from '@fireside/shared';
import { Link } from 'react-router';
import { useIsDesktop } from '@/hooks/useIsDesktop';
import { cn } from '@/lib/utils';
import { DESTINATIONS, type DestinationId } from '@/pages/registry';
import { AccountSwitcher } from './AccountSwitcher';
import { Logo } from './Logo';
import { ProfileLink } from './ProfileLink';
import { SHELL_EDGE } from './edge';
import { useDestinationLinks } from './useDestinationLinks';

/**
 * The top bar on PC: logo and name (to Home), the five destinations that exist, the account
 * switcher and the profile icon, in that order for Tab too. Sticky below the safe area.
 * `data-top-bar` lets the Sessions pane and the page list measure it (`useStickyTop`,
 * `useViewportRoom`).
 */
export function TopBar({
  scope,
  active,
  settings,
  showAccountSwitcher,
  className,
}: {
  scope: AccountScope;
  /** The destination of the current page, if any. */
  active: DestinationId | undefined;
  /** On a Settings page: the profile icon is marked. */
  settings: boolean;
  showAccountSwitcher: boolean;
  className?: string;
}) {
  const links = useDestinationLinks(scope);
  const desktop = useIsDesktop();

  return (
    <header
      data-top-bar
      className={cn(
        'sticky top-(--safe-top) z-10 flex-wrap items-center gap-x-7 gap-y-2 border-b border-border bg-page py-3',
        SHELL_EDGE,
        className,
      )}
    >
      <Link
        to={`/${String(scope)}`}
        className="flex items-center gap-2.5 text-text no-underline hover:text-text"
      >
        <Logo />
        <span className="font-display text-[17px] font-semibold">{BRANDING.displayName}</span>
      </Link>
      <nav aria-label="Main" className="flex flex-auto flex-wrap gap-1">
        {DESTINATIONS.map((destination) => {
          const href = links.get(destination.id);
          if (href === undefined) return null;
          const isActive = destination.id === active;
          return (
            <Link
              key={destination.id}
              to={href}
              aria-current={isActive ? 'page' : undefined}
              className={cn(
                'rounded-lg px-3.5 py-2 no-underline',
                isActive
                  ? 'bg-accent-wash font-semibold text-accent-text hover:text-accent-text'
                  : 'font-medium text-text-2 hover:bg-hover hover:text-text',
              )}
            >
              {destination.label}
            </Link>
          );
        })}
      </nav>
      {/* Once in the document: in the page header on mobile instead. */}
      {desktop && (
        <div className="flex items-center gap-2.5">
          {showAccountSwitcher && <AccountSwitcher scope={scope} />}
          <ProfileLink active={settings} />
        </div>
      )}
    </header>
  );
}
