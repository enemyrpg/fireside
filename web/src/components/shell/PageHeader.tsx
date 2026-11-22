import type { AccountScope } from '@fireside/shared';
import { useIsDesktop } from '@/hooks/useIsDesktop';
import type { Ref } from 'react';
import { cn } from '@/lib/utils';
import { navPageId, type Destination, type PageDef } from '@/pages/registry';
import { AccountSwitcher } from './AccountSwitcher';
import { Logo } from './Logo';
import { ProfileLink } from './ProfileLink';
import { SubTabs } from './SubTabs';

/**
 * The top of every page. PC: the title (the destination, or the page's own
 * title outside the five) with the sub-tabs next to it, and the page's own
 * controls on the right. Mobile, in rows: title (the logo on Home), account
 * switcher and profile icon; the sub-tabs; the controls. A row with nothing in
 * it takes no space. Home has no visible title on PC.
 */
export function PageHeader({
  page,
  destination,
  scope,
  showAccountSwitcher,
  settings,
  controlsRef,
  headingRef,
}: {
  page: PageDef | undefined;
  destination: Destination | undefined;
  scope: AccountScope;
  showAccountSwitcher: boolean;
  settings: boolean;
  /** The slot pages fill with `PageControls`. */
  controlsRef: (element: HTMLElement | null) => void;
  /** Focused after a navigation to another page (`useFocusHeadingOnNavigation`). */
  headingRef?: Ref<HTMLHeadingElement> | undefined;
}) {
  const home = destination?.id === 'home';
  const desktop = useIsDesktop();
  // A page of a destination is headed by the destination ("Progress"); a
  // detail page (Session) and Settings by their own title.
  const title =
    page === undefined || page.destination !== undefined ? (destination?.label ?? '') : page.title;

  if (!desktop && page?.bareOnMobile === true) {
    return (
      <>
        <h1 ref={headingRef} tabIndex={-1} className="sr-only outline-none">
          {title}
        </h1>
        <div ref={controlsRef} className="hidden" />
      </>
    );
  }

  return (
    <div
      className={cn(
        'mb-5 flex flex-col gap-4 desk:flex-row desk:flex-wrap desk:items-center desk:justify-between desk:gap-x-8 desk:gap-y-3.5',
        // Nothing visible on Home on PC (no title, sub-tabs or controls).
        home ? 'desk:mb-0' : 'desk:mb-7',
      )}
    >
      <div className="flex flex-col gap-4 desk:flex-row desk:flex-wrap desk:items-center desk:gap-x-6 desk:gap-y-3.5">
        <div className="flex min-h-11 items-center justify-between gap-2.5 desk:min-h-0">
          {home && <Logo className="size-[34px] desk:hidden" />}
          <h1
            ref={headingRef}
            // Focusable from script only, without a ring: a target for screen readers.
            tabIndex={-1}
            className={
              home
                ? 'sr-only outline-none'
                : 'm-0 min-w-0 truncate outline-none font-display text-2xl font-semibold tracking-[-0.01em] desk:text-[30px]'
            }
          >
            {title}
          </h1>
          {/* Once in the document: in the top bar on PC instead. */}
          {!desktop && (
            <div className="flex flex-none items-center gap-2">
              {showAccountSwitcher && <AccountSwitcher scope={scope} />}
              <ProfileLink active={settings} />
            </div>
          )}
        </div>
        {destination && (
          <SubTabs destination={destination} active={navPageId(page)} scope={scope} />
        )}
      </div>
      <div
        ref={controlsRef}
        className="flex items-center gap-2 empty:hidden max-desk:w-full max-desk:flex-wrap"
      />
    </div>
  );
}
