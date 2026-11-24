import type { AccountScope } from '@fireside/shared';
import { BRANDING } from '@fireside/shared';
import { Link } from 'react-router';
import { useIsDesktop } from '@/hooks/useIsDesktop';
import { useIsWide } from '@/hooks/useIsWide';
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
 *
 * At 1100 px and narrower (not `wide:`) the bar is compact, so it fits on one
 * row on a phone in landscape, notch inset included: the product name is only
 * for screen readers (the logo stays the Home link) and the account switcher
 * shows the name without the account type. See "Navigation" in docs/design.md.
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
  const compact = !useIsWide();

  return (
    <header
      data-top-bar
      className={cn(
        'sticky top-(--safe-top) z-10 flex-nowrap items-center gap-x-7 border-b border-border bg-page py-3',
        SHELL_EDGE,
        className,
      )}
    >
      <Link
        to={`/${String(scope)}`}
        className="flex flex-none items-center gap-2.5 text-text no-underline hover:text-text"
      >
        <Logo />
        <span className={cn('font-display text-[17px] font-semibold', compact && 'sr-only')}>
          {BRANDING.displayName}
        </span>
      </Link>
      {/* Never wraps: if the bar is too narrow, the nav shrinks and scrolls rather than
          pushing the account switcher onto a second row. The scroll box would clip the
          focus ring (2 px outside a link, 2 px wide), so 4 px of padding, taken back with
          a negative margin so nothing moves. */}
      <nav
        aria-label="Main"
        className="-m-1 flex min-w-0 flex-auto flex-nowrap gap-1 overflow-x-auto p-1"
      >
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
                'flex-none rounded-lg px-3.5 py-2 no-underline',
                isActive
                  ? 'bg-accent-wash font-semibold text-accent-text hover:text-accent-text'
                  : 'font-medium text-text-2 hover:bg-hover hover:text-text',
              )}
            >
              {/* The bold copy reserves the selected width, so choosing a page never moves the bar. */}
              <span className="inline-grid">
                <span className="col-start-1 row-start-1">{destination.label}</span>
                <span
                  aria-hidden="true"
                  className="invisible col-start-1 row-start-1 font-semibold"
                >
                  {destination.label}
                </span>
              </span>
            </Link>
          );
        })}
      </nav>
      {/* Once in the document: in the page header on mobile instead. */}
      {desktop && (
        <div className="flex flex-none items-center gap-2.5">
          {showAccountSwitcher && <AccountSwitcher scope={scope} compact={compact} />}
          <ProfileLink active={settings} />
        </div>
      )}
    </header>
  );
}
