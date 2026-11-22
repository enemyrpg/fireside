// The source file, not '@fireside/shared': vite.config.ts loads this module
// with Node's own resolution, where the package points at shared/dist, which
// doesn't exist before shared is built (a fresh clone running `pnpm dev`).
import { BRANDING } from '../../../shared/src/branding.ts';
import { DEFAULT_PAGE_COLOR } from '../theme/themes.ts';
import { APP_ICONS } from './icons.ts';

// The web app manifest. Built from BRANDING at build time by pwa-plugin.ts and
// served by the server as a public static file (`/manifest.webmanifest`,
// application/manifest+json).

export const MANIFEST_FILE = 'manifest.webmanifest';

export interface ManifestIcon {
  src: string;
  sizes: string;
  type: 'image/png';
  purpose: 'any' | 'maskable';
}

export interface WebManifest {
  id: string;
  name: string;
  short_name: string;
  start_url: string;
  scope: string;
  display: 'standalone';
  lang: string;
  background_color: string;
  theme_color: string;
  icons: ManifestIcon[];
}

/**
 * Both colours are the default (Ember) theme's `--page`: the Android splash
 * screen then matches the first paint, and the title bar blends with the top
 * bar. The theme-color tag follows the chosen theme once the page runs
 * (theme-init script, syncThemeColor).
 */
export function webManifest(): WebManifest {
  return {
    id: '/',
    name: BRANDING.displayName,
    short_name: BRANDING.displayName,
    start_url: '/',
    scope: '/',
    display: 'standalone',
    lang: 'en',
    background_color: DEFAULT_PAGE_COLOR,
    theme_color: DEFAULT_PAGE_COLOR,
    icons: APP_ICONS.flatMap((icon) =>
      icon.purpose === 'apple'
        ? []
        : [
            {
              src: `/${icon.file}`,
              sizes: `${String(icon.size)}x${String(icon.size)}`,
              type: 'image/png' as const,
              purpose: icon.purpose,
            },
          ],
    ),
  };
}
