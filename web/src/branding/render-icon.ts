import { Resvg } from '@resvg/resvg-js';
import type { AppIcon } from './icons.ts';

// Renders an app icon to PNG. Used by `pnpm icons` and by the test that checks
// the committed PNGs. @resvg/resvg-js is pinned to an exact version
// (web/package.json), so the output only changes when the drawing does.
// Node only: never imported by the dashboard itself.

function renderer(icon: AppIcon): Resvg {
  return new Resvg(icon.svg(), {
    fitTo: { mode: 'width', value: icon.size },
    // The logo has no text; never depend on the machine's fonts.
    font: { loadSystemFonts: false },
  });
}

/** The icon as PNG bytes. */
export function renderIconPng(icon: AppIcon): Buffer {
  return renderer(icon).render().asPng();
}

/** The icon as RGBA pixels, row by row. */
export function renderIconPixels(icon: AppIcon): { width: number; height: number; pixels: Buffer } {
  const image = renderer(icon).render();
  return { width: image.width, height: image.height, pixels: image.pixels };
}
