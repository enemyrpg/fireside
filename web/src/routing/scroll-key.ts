import type { Location } from 'react-router';

// Scroll keys for `ScrollRestoration`. React Router saves the scroll position
// under the current entry's key when a navigation starts, and on every
// navigation (also a push) scrolls to the position saved under the new entry's
// key, or to the top when there is none.
//
// - A new history entry with another path gets its own key: the top.
// - A new entry with the same path (only the query changed: period, filter,
//   sort, search, `?tab=`) shares the key of the entry it came from, so the
//   page stays where it is, also when the change pushed an entry.
// - Back and forward return to an entry seen before: its key, its position.
//
// `pathname` alone as the key would also bring back an old position when a
// link opens a page visited earlier, which should start at the top.

const keys = new Map<string, string>();
let previous: { pathname: string; key: string } | undefined;

export function scrollKey(location: Pick<Location, 'key' | 'pathname'>): string {
  let key = keys.get(location.key);
  if (key === undefined) {
    // The router asks for the current entry (to save) just before the new one.
    key = previous?.pathname === location.pathname ? previous.key : location.key;
    keys.set(location.key, key);
  }
  previous = { pathname: location.pathname, key };
  return key;
}

/** Forgets every key (tests start with a fresh history). */
export function resetScrollKeys(): void {
  keys.clear();
  previous = undefined;
}
