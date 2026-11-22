import { useEffect, useState } from 'react';

/** Skeletons only appear after this delay, so fast answers don't flash. */
export const SKELETON_DELAY_MS = 200;

/** `true` once `active` has been true for `delayMs` without a break. */
export function useDelayedFlag(active: boolean, delayMs = SKELETON_DELAY_MS): boolean {
  const [shown, setShown] = useState(false);

  useEffect(() => {
    if (!active) return;
    const timer = setTimeout(() => {
      setShown(true);
    }, delayMs);
    return () => {
      clearTimeout(timer);
      // Start over the next time `active` turns true.
      setShown(false);
    };
  }, [active, delayMs]);

  return active && shown;
}
