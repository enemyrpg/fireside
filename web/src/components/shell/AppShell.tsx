import type { AccountScope } from '@fireside/shared';
import { useState, type ReactNode, type Ref } from 'react';
import { useAccounts, useHealth } from '@/api/hooks';
import { useServerStatus } from '@/api/server-status';
import { useCarryShellFocus, useIsDesktop } from '@/hooks/useIsDesktop';
import { Card } from '@/components/Card';
import { CardSkeleton, ErrorState } from '@/components/states';
import { DESTINATIONS, destinationOf, type DestinationId, type PageDef } from '@/pages/registry';
import { BottomTabBar } from './BottomTabBar';
import { Footer } from './Footer';
import { PageControlsContext } from './page-controls-context';
import { PageHeader } from './PageHeader';
import { ServerDownBanner } from './ServerDownBanner';
import { TopBar } from './TopBar';
import { cn } from '@/lib/utils';

export interface AppShellProps {
  /** The registry page of the current route (none on the 404 page). */
  page: PageDef | undefined;
  /** A destination's own path while it waits to redirect (`/:acc/collections`). */
  destinationRoute?: DestinationId | undefined;
  /** The page heading, which gets focus after a navigation to another page. */
  headingRef?: Ref<HTMLHeadingElement>;
  /** Account in the URL, or the last chosen one on pages without an account. */
  scope: AccountScope;
  children: ReactNode;
}

/**
 * Top bar (PC), page header, content (max 1376 px), footer and the bottom tab
 * bar (mobile). Pages render only after `health` has loaded, since every date
 * on a page needs the server's time zone.
 *
 * In an installed app the page starts below the status bar or notch
 * (`--safe-top`), and a strip in the page colour covers that area while the
 * page scrolls under it.
 */
export function AppShell({ page, destinationRoute, headingRef, scope, children }: AppShellProps) {
  const [controls, setControls] = useState<HTMLElement | null>(null);
  const health = useHealth();
  const { down } = useServerStatus();
  useCarryShellFocus(useIsDesktop());
  const destination =
    destinationOf(page) ?? DESTINATIONS.find((entry) => entry.id === destinationRoute);
  // Settings hides the account switcher; the 404 page has none either. Nor has a new
  // instance: with no accounts there is nothing to pick. While the list loads it stays, so
  // it never flashes away and back.
  const noAccounts = useAccounts().data?.accounts.length === 0;
  const showAccountSwitcher =
    !noAccounts &&
    (destination !== undefined || (page !== undefined && page.hideAccountSwitcher !== true));
  const settings = page?.id === 'settings' || page?.parent === 'settings';

  return (
    <div className="flex min-h-screen flex-col pt-(--safe-top)">
      <div aria-hidden="true" className="fixed inset-x-0 top-0 z-20 h-(--safe-top) bg-page" />
      <TopBar
        scope={scope}
        active={destination?.id}
        settings={settings}
        showAccountSwitcher={showAccountSwitcher}
        className="hidden desk:flex"
      />
      <ServerDownBanner />
      <main
        className={cn(
          'safe-x mx-auto w-full max-w-[1376px] flex-1 pt-3.5 pb-6 desk:pt-8 desk:pr-[max(32px,var(--safe-right))] desk:pb-10 desk:pl-[max(32px,var(--safe-left))]',
          // While the page waits for `health`, the footer stays below the fold, so it doesn't
          // jump down off the screen when the page renders (docs/design.md, "Loading").
          // Not after it failed: the error is all there is, so nothing will move.
          health.isPending && 'min-h-svh',
        )}
      >
        <PageHeader
          page={page}
          destination={destination}
          scope={scope}
          showAccountSwitcher={showAccountSwitcher}
          settings={settings}
          controlsRef={setControls}
          headingRef={headingRef}
        />
        <PageControlsContext value={controls}>
          {health.data !== undefined ? (
            children
          ) : (
            <Card>
              {/* While the server is down, the banner explains and health is retried. */}
              {health.isError && !down ? (
                <ErrorState onRetry={() => void health.refetch()} />
              ) : (
                <CardSkeleton />
              )}
            </Card>
          )}
        </PageControlsContext>
      </main>
      {/* Extra space at the bottom on mobile so the tab bar never covers the footer. */}
      <Footer className="pb-[calc(90px+var(--safe-bottom))] desk:pb-[calc(1rem+var(--safe-bottom))]" />
      <BottomTabBar scope={scope} active={destination?.id} className="desk:hidden" />
    </div>
  );
}
