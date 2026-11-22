import { useLayoutEffect, useRef } from 'react';

/**
 * For a dialog opened from state rather than a Radix trigger: Radix then has
 * nothing to return focus to. Remembers what had focus when `open` turned
 * true (the button that opened the dialog) and gives a handler for
 * `onCloseAutoFocus` that goes back there, so keyboard users keep their place.
 */
export function useReturnFocus(open: boolean): (event: Event) => void {
  const returnFocusTo = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    if (open && document.activeElement instanceof HTMLElement) {
      returnFocusTo.current = document.activeElement;
    }
  }, [open]);
  return (event) => {
    const target = returnFocusTo.current;
    returnFocusTo.current = null;
    if (target?.isConnected) {
      event.preventDefault();
      target.focus();
    }
  };
}
