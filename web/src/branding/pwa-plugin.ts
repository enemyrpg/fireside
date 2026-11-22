// The source file, not '@fireside/shared': vite.config.ts loads this module
// with Node's own resolution, where the package points at shared/dist, which
// doesn't exist before shared is built (a fresh clone running `pnpm dev`).
import { BRANDING } from '../../../shared/src/branding.ts';
import type { Plugin } from 'vite';
import { devFile } from '../lib/dev-file.ts';
import { APPLE_TOUCH_ICON } from './icons.ts';
import { MANIFEST_FILE, webManifest } from './manifest.ts';

const MANIFEST_TYPE = 'application/manifest+json';

/**
 * Makes the dashboard installable: emits `manifest.webmanifest` from BRANDING,
 * serves it in dev, and adds the manifest link, the apple-touch-icon and the
 * iOS app title to <head>. Tags only, no inline script (CSP).
 * `<meta name="theme-color">` comes from the theme-init plugin, so the theme
 * script can set it before first paint.
 */
export function pwaPlugin(): Plugin {
  const source = `${JSON.stringify(webManifest(), null, 2)}\n`;
  return {
    name: 'pwa-manifest',
    configureServer(server) {
      server.middlewares.use(devFile(`/${MANIFEST_FILE}`, MANIFEST_TYPE, source));
    },
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: MANIFEST_FILE, source });
    },
    transformIndexHtml: () => [
      { tag: 'link', attrs: { rel: 'manifest', href: `/${MANIFEST_FILE}` }, injectTo: 'head' },
      {
        tag: 'link',
        attrs: {
          rel: 'apple-touch-icon',
          sizes: `${String(APPLE_TOUCH_ICON.size)}x${String(APPLE_TOUCH_ICON.size)}`,
          href: `/${APPLE_TOUCH_ICON.file}`,
        },
        injectTo: 'head',
      },
      {
        tag: 'meta',
        attrs: { name: 'apple-mobile-web-app-title', content: BRANDING.displayName },
        injectTo: 'head',
      },
    ],
  };
}
