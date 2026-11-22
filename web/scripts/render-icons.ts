// Writes the app icons (web/public/icons/, web/public/apple-touch-icon.png)
// from the logo drawing in src/branding/logo.ts. Run with `pnpm icons` after
// changing the drawing; src/branding/icons.test.ts fails until you do.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { APP_ICONS } from '../src/branding/icons.ts';
import { renderIconPng } from '../src/branding/render-icon.ts';

const publicDir = join(import.meta.dirname, '..', 'public');

for (const icon of APP_ICONS) {
  const path = join(publicDir, icon.file);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, renderIconPng(icon));
  console.log(`wrote public/${icon.file} (${String(icon.size)} px)`);
}
