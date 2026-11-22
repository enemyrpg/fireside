import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BRANDING } from '@fireside/shared';
import { describe, expect, it } from 'vitest';
import { faviconHref, syncFavicon } from './favicon';
import { logoMarkSvg, logoSvg } from './logo';

const repoFile = (path: string) =>
  readFileSync(join(import.meta.dirname, '..', '..', '..', path), 'utf8');

describe('logo files', () => {
  // Regenerate them from logo.ts when the drawing changes (see the comment there).
  it.each([
    [`assets/logo/${BRANDING.shortName}.svg`, logoSvg()],
    [`assets/logo/${BRANDING.shortName}-mark.svg`, logoMarkSvg()],
    ['web/public/favicon.svg', logoSvg()],
  ])('%s matches logo.ts', (path, expected) => {
    expect(repoFile(path)).toBe(expected);
  });

  it('puts the accent on the square and the stroke colour on top', () => {
    const svg = logoSvg('#123456', '#abcdef');
    expect(svg).toContain('fill="#123456"');
    expect(svg).toContain('stroke="#abcdef"');
  });

  it("defaults to the Ember theme's --accent and --on-accent", () => {
    const svg = logoSvg();
    expect(svg).toContain('fill="#f0803c"');
    expect(svg).toContain('stroke="#1a1009"');
  });
});

describe('favicon', () => {
  it('is the logo in the given accent and stroke', () => {
    expect(decodeURIComponent(faviconHref('#936039', '#ffffff'))).toBe(
      `data:image/svg+xml,${logoSvg('#936039', '#ffffff')}`,
    );
  });

  it('uses the current --accent and --on-accent and reuses the existing icon link', () => {
    document.head.innerHTML = '<link rel="icon" href="/favicon.svg">';
    const root = document.documentElement.style;
    root.setProperty('--accent', '#936039');
    root.setProperty('--on-accent', '#ffffff');
    try {
      syncFavicon();
    } finally {
      root.removeProperty('--accent');
      root.removeProperty('--on-accent');
    }
    const links = document.head.querySelectorAll<HTMLLinkElement>('link[rel="icon"]');
    expect(links).toHaveLength(1);
    expect(links[0]?.href).toBe(faviconHref('#936039', '#ffffff'));
  });

  it('falls back to the default accent and adds a link if there is none', () => {
    document.head.innerHTML = '';
    syncFavicon();
    expect(document.head.querySelector<HTMLLinkElement>('link[rel="icon"]')?.href).toBe(
      faviconHref('#f0803c', '#1a1009'),
    );
  });
});
