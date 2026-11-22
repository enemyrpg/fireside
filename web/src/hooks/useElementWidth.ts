import { useLayoutEffect, useState } from 'react';

/**
 * The rendered width of an element in px, kept up to date with a
 * `ResizeObserver`. `null` until measured, and where `ResizeObserver` is
 * missing (tests), so callers can leave out what needs the width.
 */
export function useElementWidth(): {
  /** Give this to the element as its `ref`. */
  attach: (element: HTMLElement | null) => void;
  width: number | null;
} {
  const [element, setElement] = useState<HTMLElement | null>(null);
  const [width, setWidth] = useState<number | null>(null);

  useLayoutEffect(() => {
    if (element === null || typeof ResizeObserver === 'undefined') return;
    const measure = () => {
      setWidth(element.getBoundingClientRect().width);
    };
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    measure();
    return () => {
      observer.disconnect();
    };
  }, [element]);

  return { attach: setElement, width };
}
