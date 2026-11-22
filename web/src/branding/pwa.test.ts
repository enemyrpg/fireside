import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BRANDING } from '@fireside/shared';
import type { HtmlTagDescriptor } from 'vite';
import { describe, expect, it } from 'vitest';
import { DEFAULT_PAGE_COLOR, THEMES } from '@/theme/themes';
import { APP_ICONS, APPLE_TOUCH_ICON } from './icons';
import { MANIFEST_FILE, webManifest } from './manifest';
import { pwaPlugin } from './pwa-plugin';

describe('web app manifest', () => {
  const manifest = webManifest();

  it('names the app from BRANDING and opens standalone at the root', () => {
    expect(manifest).toMatchObject({
      id: '/',
      name: BRANDING.displayName,
      short_name: BRANDING.displayName,
      start_url: '/',
      scope: '/',
      display: 'standalone',
    });
    expect(manifest).not.toHaveProperty('prefer_related_applications');
    // Longer short names are cut off under the home screen icon.
    expect(manifest.short_name.length).toBeLessThanOrEqual(12);
  });

  it("uses the default (Ember) theme's page colour", () => {
    expect(DEFAULT_PAGE_COLOR).toBe(THEMES.find((theme) => theme.id === 'ember')?.page);
    expect(DEFAULT_PAGE_COLOR).toBe('#14110f');
    expect(manifest.background_color).toBe(DEFAULT_PAGE_COLOR);
    expect(manifest.theme_color).toBe(DEFAULT_PAGE_COLOR);
  });

  it('lists 192 and 512 icons and a 512 maskable one, not the apple-touch-icon', () => {
    expect(manifest.icons).toEqual([
      { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      {
        src: '/icons/icon-maskable-512.png',
        sizes: '512x512',
        type: 'image/png',
        purpose: 'maskable',
      },
    ]);
    expect(APPLE_TOUCH_ICON).toMatchObject({ file: 'apple-touch-icon.png', size: 180 });
    expect(APP_ICONS).toHaveLength(4);
  });
});

describe('pwaPlugin', () => {
  it('emits the manifest as JSON in the build', () => {
    const emitted: { type: string; fileName: string; source: string }[] = [];
    const generateBundle = pwaPlugin().generateBundle as (this: {
      emitFile: (file: (typeof emitted)[number]) => void;
    }) => void;
    generateBundle.call({ emitFile: (file) => emitted.push(file) });
    expect(emitted).toHaveLength(1);
    expect(emitted[0]?.fileName).toBe(MANIFEST_FILE);
    expect(JSON.parse(emitted[0]?.source ?? '')).toEqual(webManifest());
  });

  it('adds the manifest link, apple-touch-icon and app title, never a script', () => {
    const transform = pwaPlugin().transformIndexHtml as () => HtmlTagDescriptor[];
    const tags = transform();
    expect(tags.map((tag) => tag.attrs)).toEqual([
      { rel: 'manifest', href: '/manifest.webmanifest' },
      { rel: 'apple-touch-icon', sizes: '180x180', href: '/apple-touch-icon.png' },
      { name: 'apple-mobile-web-app-title', content: BRANDING.displayName },
    ]);
    for (const tag of tags) {
      expect(tag.tag).not.toBe('script');
      expect(tag.children).toBeUndefined();
    }
  });
});

describe('index.html', () => {
  const html = readFileSync(join(import.meta.dirname, '..', '..', 'index.html'), 'utf8');

  it('lets the page reach under the notch, so the safe-area insets apply', () => {
    expect(html).toContain('viewport-fit=cover');
  });
});
