// The on-screen keyboard. On iOS Safari the keyboard doesn't resize the page:
// `100dvh` and `position: fixed; bottom: 0` stay where they were, under the
// keyboard. Only the visual viewport shrinks. Two variables on <html> follow
// it, and the sheets are sized from them:
//
//   --keyboard-inset  px covered at the bottom (0 without a keyboard)
//   --visual-height   height of what is actually visible

interface ViewportBox {
  height: number;
  offsetTop: number;
}

/** How much of the layout viewport's bottom is covered (by the keyboard). Never negative. */
export function keyboardInset(layoutHeight: number, visual: ViewportBox): number {
  return Math.max(0, Math.round(layoutHeight - visual.height - visual.offsetTop));
}

/** Keeps the two variables up to date. Does nothing where `visualViewport` is missing. */
export function watchVisualViewport(): void {
  const visual = window.visualViewport;
  if (!visual) return;
  const update = (): void => {
    const style = document.documentElement.style;
    style.setProperty('--keyboard-inset', `${String(keyboardInset(window.innerHeight, visual))}px`);
    style.setProperty('--visual-height', `${String(Math.round(visual.height))}px`);
  };
  visual.addEventListener('resize', update);
  visual.addEventListener('scroll', update);
  update();
}
