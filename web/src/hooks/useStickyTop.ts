import { useLayoutEffect, useState } from 'react';
import { stickyRoom, stickyTopWhenFits } from '@/lib/bank';

/** The top bar on PC, which is sticky itself (hidden on mobile: height 0). */
function topBar(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[data-top-bar]');
}

/**
 * The top bar's height and the safe-area inset it sticks below (tokens.css);
 * the browser resolves env() in the computed value. The inset is 0 outside an
 * installed app.
 */
function measureTopBar(header: HTMLElement | null): { headerHeight: number; safeTop: number } {
  const safeTop =
    Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--safe-top')) ||
    0;
  return { headerHeight: header?.offsetHeight ?? 0, safeTop };
}

/**
 * `top` for the selected session on Sessions, the one sticky column on the
 * site: under the top bar while it fits in the window; a taller column gets no
 * `top` and scrolls with the page, so its bottom can always be reached
 * (`stickyTopWhenFits`). Worked out again when the column, the top bar or the
 * window changes size. `undefined` until measured (and where `ResizeObserver`
 * is missing).
 */
export function useStickyTop(): {
  /** Give this to the column as its `ref`. */
  attach: (element: HTMLElement | null) => void;
  top: number | undefined;
} {
  const [element, setElement] = useState<HTMLElement | null>(null);
  const [top, setTop] = useState<number>();

  useLayoutEffect(() => {
    if (element === null || typeof ResizeObserver === 'undefined') return;
    const header = topBar();
    const measure = () => {
      const { headerHeight, safeTop } = measureTopBar(header);
      setTop(stickyTopWhenFits(headerHeight, window.innerHeight, element.offsetHeight, safeTop));
    };
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    if (header) observer.observe(header);
    window.addEventListener('resize', measure);
    measure();
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [element]);

  return { attach: setElement, top };
}

/**
 * The height of the window under the top bar, less 20 px above and below
 * (`stickyRoom`): the most a card that scrolls inside itself may take, so it
 * always fits on screen (the collection log's page list). Worked out again when
 * the top bar or the window changes size. `undefined` until measured.
 */
export function useViewportRoom(): number | undefined {
  const [room, setRoom] = useState<number>();
  useLayoutEffect(() => {
    const header = topBar();
    const measure = () => {
      const { headerHeight, safeTop } = measureTopBar(header);
      setRoom(stickyRoom(headerHeight, window.innerHeight, safeTop));
    };
    const observer =
      typeof ResizeObserver === 'undefined' || !header ? undefined : new ResizeObserver(measure);
    if (header) observer?.observe(header);
    window.addEventListener('resize', measure);
    measure();
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, []);
  return room;
}
