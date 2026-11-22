import { useCallback, useEffect, useState } from 'react';

/** Whether the content of `element` is wider than it is, so it scrolls sideways. */
export function scrollsSideways(element: Pick<Element, 'scrollWidth' | 'clientWidth'>): boolean {
  return element.scrollWidth > element.clientWidth + 1;
}

/**
 * For a box with `overflow-x: auto` (a wide table, the activity calendar on a
 * phone): `scrollable` is true while its content is wider than the box. The
 * box then needs to be a tab stop, or a keyboard can't scroll it (WCAG 2.1.1).
 * It is not one when everything fits, so the page gets no tab stop that does
 * nothing.
 */
export function useScrollsSideways(): {
  ref: (element: HTMLElement | null) => void;
  scrollable: boolean;
} {
  const [element, setElement] = useState<HTMLElement | null>(null);
  const [scrollable, setScrollable] = useState(false);
  const ref = useCallback((next: HTMLElement | null) => {
    setElement(next);
  }, []);

  useEffect(() => {
    if (!element) return undefined;
    const measure = (): void => {
      setScrollable(scrollsSideways(element));
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    // The content can grow without the box changing size.
    for (const child of element.children) observer.observe(child);
    return () => {
      observer.disconnect();
    };
  }, [element]);

  return { ref, scrollable };
}

/** The attributes that make a sideways-scrolling box reachable by keyboard, with a name. */
export function scrollRegionProps(
  scrollable: boolean,
  name: string,
): { tabIndex?: 0; role?: 'group'; 'aria-label'?: string } {
  return scrollable
    ? { tabIndex: 0, role: 'group', 'aria-label': `${name}, scrolls sideways` }
    : {};
}
