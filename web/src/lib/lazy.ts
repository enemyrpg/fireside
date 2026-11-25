import { lazy, type ComponentType, type LazyExoticComponent } from 'react';

/**
 * A part of the dashboard that is loaded on demand (a page, the QR code, the
 * calendar) could not be loaded. Usually the tab is older than the last
 * release: the new build replaced the hashed files the tab asks for
 * (docs/design.md, "Loading").
 */
export class ChunkLoadError extends Error {
  override name = 'ChunkLoadError';
}

/**
 * A module that is loaded once, on first use. `load()` can be called early
 * (e.g. when a form opens) so the code is there before it is needed; the same
 * promise is used by the component.
 */
export interface LazyModule<P extends object> {
  Component: LazyExoticComponent<ComponentType<P>>;
  load: () => Promise<{ default: ComponentType<P> }>;
}

/**
 * `React.lazy` whose failed import becomes a `ChunkLoadError`, which the
 * route's error page shows as "A new version is available". React keeps the
 * failed promise, so the component is never imported twice in one page load:
 * only a reload (by the user, never automatic) tries again.
 */
export function lazyModule<P extends object>(
  importer: () => Promise<{ default: ComponentType<P> }>,
): LazyModule<P> {
  let promise: Promise<{ default: ComponentType<P> }> | undefined;
  const load = () => {
    promise ??= importer().catch((error: unknown) => {
      throw new ChunkLoadError('Could not load part of the dashboard.', { cause: error });
    });
    return promise;
  };
  return { Component: lazy(load), load };
}

/** `lazyModule` for a named export: `lazyNamed(() => import('./X'), 'X')`. */
export function lazyNamed<K extends string, P extends object>(
  importer: () => Promise<Record<K, ComponentType<P>>>,
  name: K,
): LazyModule<P> {
  return lazyModule(() => importer().then((module) => ({ default: module[name] })));
}

/** Script URLs of a page's own entry scripts (`/assets/index-….js`). */
function entryScripts(root: ParentNode): string[] {
  return [...root.querySelectorAll('script[type="module"][src]')]
    .map((script) => script.getAttribute('src') ?? '')
    .filter((src) => src.startsWith('/assets/'))
    .sort();
}

/**
 * Whether the server now serves another build than the one this tab runs:
 * compares the entry scripts of a fresh `index.html` with this page's.
 * `undefined` if the server can't be asked (e.g. offline).
 */
export async function isNewVersionServed(): Promise<boolean | undefined> {
  try {
    const response = await fetch('/', {
      cache: 'no-store',
      headers: { accept: 'text/html' },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return undefined;
    const html = new DOMParser().parseFromString(await response.text(), 'text/html');
    const served = entryScripts(html);
    if (served.length === 0) return undefined;
    return served.join('\n') !== entryScripts(document).join('\n');
  } catch {
    return undefined;
  }
}
