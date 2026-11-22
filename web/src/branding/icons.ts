import { logoFullBleedSvg, logoSvg } from './logo.ts';

// App icons for the web app manifest and iOS. Our own logo only, never Jagex
// graphics. The PNGs are committed under web/public/ and rendered from logo.ts
// by `pnpm icons` (scripts/render-icons.ts); a test checks that they match a
// fresh render.
//
// This module is also read by vite.config.ts (pwa-plugin.ts) and the render
// script, so it must not touch browser globals at import time.

export interface AppIcon {
  /** Path under web/public/ (and the site root). */
  file: string;
  /** Width and height in pixels. */
  size: number;
  /** Manifest purpose; `apple` is the apple-touch-icon, not in the manifest. */
  purpose: 'any' | 'maskable' | 'apple';
  /** The SVG the PNG is rendered from. */
  svg: () => string;
}

/** Fraction of the size, from the centre, that a maskable icon's content must stay within. */
export const MASKABLE_SAFE_RADIUS = 0.4;

export const APP_ICONS = [
  { file: 'icons/icon-192.png', size: 192, purpose: 'any', svg: () => logoSvg() },
  { file: 'icons/icon-512.png', size: 512, purpose: 'any', svg: () => logoSvg() },
  {
    file: 'icons/icon-maskable-512.png',
    size: 512,
    purpose: 'maskable',
    svg: () => logoFullBleedSvg(),
  },
  // At the root, where iOS also looks when no link is given.
  { file: 'apple-touch-icon.png', size: 180, purpose: 'apple', svg: () => logoFullBleedSvg() },
] as const satisfies readonly AppIcon[];

export const APPLE_TOUCH_ICON: AppIcon = APP_ICONS[3];
