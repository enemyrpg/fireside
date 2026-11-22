import { cleanup } from '@testing-library/react';
import { afterEach, vi } from 'vitest';
import { resetServerStatus } from '@/api/server-status';
import { resetScrollKeys } from '@/routing/scroll-key';

// jsdom lacks these browser APIs, which Radix and Sonner use.
if (typeof window.matchMedia !== 'function') {
  Object.defineProperty(window, 'matchMedia', {
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    }),
  });
}
if (!('ResizeObserver' in window)) {
  Object.defineProperty(window, 'ResizeObserver', {
    value: class {
      observe = () => undefined;
      unobserve = () => undefined;
      disconnect = () => undefined;
    },
    // A test can put its own in, to say when a size changed.
    writable: true,
    configurable: true,
  });
}

// jsdom doesn't scroll: a window that only remembers where it was scrolled to,
// for `ScrollRestoration` and the tests of it (`window.scrollTo(0, 400)`).
let scrollY = 0;
Object.defineProperty(window, 'scrollY', { get: () => scrollY, configurable: true });
Object.defineProperty(window, 'pageYOffset', { get: () => scrollY, configurable: true });
Object.defineProperty(window, 'scrollTo', {
  value: (xOrOptions?: number | ScrollToOptions, y?: number) => {
    scrollY = typeof xOrOptions === 'object' ? (xOrOptions.top ?? scrollY) : (y ?? scrollY);
  },
  configurable: true,
  writable: true,
});

// Radix Select uses pointer capture and scrolls the chosen option into view.
for (const name of ['hasPointerCapture', 'releasePointerCapture', 'scrollIntoView'] as const) {
  if (!(name in Element.prototype)) {
    Object.defineProperty(Element.prototype, name, { value: () => false });
  }
}

afterEach(() => {
  cleanup();
  localStorage.clear();
  document.documentElement.removeAttribute('data-theme');
  resetServerStatus();
  resetScrollKeys();
  sessionStorage.clear();
  window.scrollTo(0, 0);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
