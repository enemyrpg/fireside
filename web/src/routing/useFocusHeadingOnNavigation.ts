import { useEffect, useRef, type RefObject } from 'react';
import { NavigationType, useLocation, useNavigationType } from 'react-router';
import { useIsRedirectRoute } from './current-page';

/**
 * Moves focus to the page heading after a link opened another page, so a
 * screen reader announces it. Not on the first load, not on Back/forward (the
 * browser's own place is kept) and not when only the query changed. A redirect
 * route (`/:acc/collections`, old paths) counts as the navigation that led to it: a
 * old URL opened directly is still the first load.
 */
export function useFocusHeadingOnNavigation(heading: RefObject<HTMLHeadingElement | null>): void {
  const { pathname } = useLocation();
  const type = useNavigationType();
  const redirect = useIsRedirectRoute();
  /** Path of the last page shown (not a redirect route); `null` before the first. */
  const lastPage = useRef<string | null>(null);
  /** What led to a redirect route that is still on its way to a page. */
  const viaRedirect = useRef<NavigationType | 'INITIAL' | null>(null);

  useEffect(() => {
    const first = lastPage.current === null;
    if (redirect) {
      viaRedirect.current ??= first ? 'INITIAL' : type;
      return;
    }
    const cause = viaRedirect.current ?? (first ? 'INITIAL' : type);
    viaRedirect.current = null;
    const changed = !first && lastPage.current !== pathname;
    lastPage.current = pathname;
    if (changed && cause !== NavigationType.Pop && cause !== 'INITIAL') {
      heading.current?.focus({ preventScroll: true });
    }
  }, [pathname, type, redirect, heading]);
}
