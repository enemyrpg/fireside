import { createHash } from 'node:crypto';
import type { Plugin } from 'vite';
import { devFile } from '../lib/dev-file.ts';
import { DEFAULT_PAGE_COLOR, themeInitScript } from './themes.ts';

/**
 * Where the theme script is served: under `assets/` with a hash of its
 * content, like the other build files, so the server sends it with the
 * one-year immutable cache and a page load never waits for it to be checked.
 */
export function themeInitFileName(source: string): string {
  const hash = createHash('sha256').update(source).digest('hex').slice(0, 10);
  return `assets/theme-init-${hash}.js`;
}

/**
 * Sets the stored theme on <html> before anything renders, so themes never
 * flash. A file, not an inline script: the CSP allows scripts from this
 * origin only (server/src/security-headers.ts). A classic script at the top of
 * <head>, so it blocks rendering until the theme is set.
 *
 * `<meta name="theme-color">` comes just before it, in the default theme's
 * page colour; the script switches it to the stored theme, and `syncThemeColor`
 * keeps it in step when the theme changes.
 */
export function themeInitPlugin(): Plugin {
  const source = themeInitScript();
  const fileName = themeInitFileName(source);
  return {
    name: 'theme-init-script',
    configureServer(server) {
      server.middlewares.use(devFile(`/${fileName}`, 'text/javascript; charset=utf-8', source));
    },
    generateBundle() {
      this.emitFile({ type: 'asset', fileName, source });
    },
    transformIndexHtml: () => [
      {
        tag: 'meta',
        attrs: { name: 'theme-color', content: DEFAULT_PAGE_COLOR },
        injectTo: 'head-prepend',
      },
      { tag: 'script', attrs: { src: `/${fileName}` }, injectTo: 'head-prepend' },
    ],
  };
}
