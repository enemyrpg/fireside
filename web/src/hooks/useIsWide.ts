import { useSyncExternalStore } from 'react';

/** The `wide:` breakpoint (`--breakpoint-wide` in tokens.css). */
export const WIDE_QUERY = '(min-width: 1101px)';

function subscribe(onChange: () => void): () => void {
  const query = window.matchMedia(WIDE_QUERY);
  query.addEventListener('change', onChange);
  return () => {
    query.removeEventListener('change', onChange);
  };
}

/**
 * Whether the `wide:` layout applies, for layouts whose DOM order (and so the
 * tab order) changes with the width, such as `StackedColumns`. CSS alone can
 * only move things on screen, not in the reading order.
 */
export function useIsWide(): boolean {
  return useSyncExternalStore(subscribe, () => window.matchMedia(WIDE_QUERY).matches);
}
