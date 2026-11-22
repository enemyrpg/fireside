import { useEffect, useLayoutEffect, useSyncExternalStore } from 'react';

/** The `desk:` breakpoint (`--breakpoint-desk` in tokens.css): the PC layout. */
export const DESK_QUERY = '(min-width: 861px)';

/** Marks a control that moves between the top bar and the page header. */
export const SHELL_CONTROL_ATTR = 'data-shell-control';

/** The `aria-label` of the moving control that had focus when the layout changed. */
let focusToCarry: string | null = null;

/**
 * A moving control that lost focus because CSS hid it (the top bar goes
 * `display: none` below the breakpoint). The browser can do that before the
 * media query's change event, so the listener would find nothing focused.
 */
let hiddenWhileFocused: string | null = null;

function shellLabel(element: Element | null): string | null {
  return element?.hasAttribute(SHELL_CONTROL_ATTR) === true
    ? element.getAttribute('aria-label')
    : null;
}

function subscribe(onChange: () => void): () => void {
  const query = window.matchMedia(DESK_QUERY);
  const listener = () => {
    // Before React moves the control: remember it if it has (or just had) focus.
    // Every component using this hook has its own listener, and React may
    // already have moved the control when a later one runs, so only ever set
    // it here; `useCarryShellFocus` clears it.
    const label = shellLabel(document.activeElement) ?? hiddenWhileFocused;
    if (label !== null) focusToCarry = label;
    onChange();
  };
  query.addEventListener('change', listener);
  return () => {
    query.removeEventListener('change', listener);
  };
}

/**
 * Whether the PC layout applies. For controls that must exist once, not once
 * per layout hidden with CSS: the account switcher and the profile icon sit
 * in the top bar on PC and in the page header on mobile. The media query and
 * the CSS breakpoint change in the same frame, before it is painted, so nothing
 * shows in the wrong place.
 */
export function useIsDesktop(): boolean {
  return useSyncExternalStore(subscribe, () => window.matchMedia(DESK_QUERY).matches);
}

/**
 * Gives focus back to the moving control that had it when the window crossed
 * the breakpoint (it is a new element in the other place). Used once, in the shell.
 */
export function useCarryShellFocus(desktop: boolean): void {
  useEffect(() => {
    const onFocusOut = (event: FocusEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      // Hidden, not left: no new focus, and the control has no box any more.
      hiddenWhileFocused =
        event.relatedTarget === null && target !== null && target.getClientRects().length === 0
          ? shellLabel(target)
          : null;
    };
    const onFocusIn = () => {
      hiddenWhileFocused = null;
    };
    document.addEventListener('focusout', onFocusOut, true);
    document.addEventListener('focusin', onFocusIn, true);
    return () => {
      document.removeEventListener('focusout', onFocusOut, true);
      document.removeEventListener('focusin', onFocusIn, true);
    };
  }, []);

  useLayoutEffect(() => {
    const label = focusToCarry;
    focusToCarry = null;
    hiddenWhileFocused = null;
    if (label === null) return;
    const target = [...document.querySelectorAll<HTMLElement>(`[${SHELL_CONTROL_ATTR}]`)].find(
      (element) => element.getAttribute('aria-label') === label,
    );
    target?.focus();
  }, [desktop]);
}
