import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  applyTheme,
  DEFAULT_PAGE_COLOR,
  DEFAULT_THEME,
  readStoredTheme,
  storeTheme,
  THEME_STORAGE_KEY,
  themeInitScript,
  THEMES,
} from './themes';

const throwing = {
  getItem: () => {
    throw new Error('blocked');
  },
  setItem: () => {
    throw new Error('blocked');
  },
};

describe('theme storage', () => {
  it('defaults to ember', () => {
    expect(DEFAULT_THEME).toBe('ember');
    expect(readStoredTheme()).toBe('ember');
  });

  it('keeps a stored dark or light choice', () => {
    for (const id of ['dark', 'light'] as const) {
      localStorage.setItem(THEME_STORAGE_KEY, id);
      expect(readStoredTheme()).toBe(id);
    }
  });

  it('reads a stored theme and ignores unknown values', () => {
    storeTheme('light');
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('light');
    expect(readStoredTheme()).toBe('light');
    localStorage.setItem(THEME_STORAGE_KEY, 'neon');
    expect(readStoredTheme()).toBe('ember');
  });

  it('never throws when storage is blocked', () => {
    expect(readStoredTheme(throwing)).toBe('ember');
    expect(() => {
      storeTheme('light', throwing);
    }).not.toThrow();
  });

  it('applies the theme to <html>', () => {
    applyTheme('light');
    expect(document.documentElement.dataset.theme).toBe('light');
  });
});

describe('inline theme script', () => {
  // Runs the script the way the browser does: as an inline <script> element.
  const run = () => {
    const script = document.createElement('script');
    script.textContent = themeInitScript();
    document.head.append(script);
    script.remove();
    return document.documentElement.getAttribute('data-theme');
  };

  const themeColor = () =>
    document.head.querySelector('meta[name="theme-color"]')?.getAttribute('content');

  it('sets the stored theme before React renders', () => {
    localStorage.setItem(THEME_STORAGE_KEY, 'light');
    expect(run()).toBe('light');
    localStorage.setItem(THEME_STORAGE_KEY, 'dark');
    expect(run()).toBe('dark');
  });

  it('falls back to the default for missing or unknown values', () => {
    expect(run()).toBe('ember');
    for (const value of ['neon', '__proto__', 'toString']) {
      localStorage.setItem(THEME_STORAGE_KEY, value);
      expect(run()).toBe('ember');
    }
  });

  it("sets theme-color to the theme's page colour, so the title bar never flashes", () => {
    document.head.innerHTML = '<meta name="theme-color" content="#181927">';
    localStorage.setItem(THEME_STORAGE_KEY, 'light');
    run();
    expect(themeColor()).toBe('#d8ccb4');
    localStorage.setItem(THEME_STORAGE_KEY, 'dark');
    run();
    expect(themeColor()).toBe('#181927');
  });

  it('still sets the theme when the theme-color tag is missing', () => {
    document.head.innerHTML = '';
    localStorage.setItem(THEME_STORAGE_KEY, 'light');
    expect(run()).toBe('light');
    expect(themeColor()).toBeUndefined();
  });
});

describe('themes.css', () => {
  // A path, not `new URL()`: jsdom's URL class isn't accepted by node:fs.
  const css = readFileSync(join(import.meta.dirname, 'themes.css'), 'utf8');

  it('has a block with color-scheme for every theme in the registry', () => {
    for (const theme of THEMES) {
      expect(css).toContain(`[data-theme='${theme.id}']`);
    }
    expect(css.match(/color-scheme:/g)?.length).toBe(THEMES.length);
  });

  it('has the page colour of every theme in the registry', () => {
    for (const theme of THEMES) {
      const block = css.split(`[data-theme='${theme.id}']`)[1]?.split('}')[0] ?? '';
      expect(block).toContain(`--page: ${theme.page};`);
      expect(block).toContain(`color-scheme: ${theme.scheme};`);
    }
    expect(DEFAULT_PAGE_COLOR).toBe(THEMES.find((theme) => theme.id === DEFAULT_THEME)?.page);
  });

  it('defines the same variables in every theme', () => {
    const blocks = css.split(/\[data-theme='[^']+'\]/).slice(1);
    const names = blocks.map((block) =>
      [...block.matchAll(/(--[\w-]+):/g)].map((match) => match[1]).sort(),
    );
    for (const list of names) expect(list).toEqual(names[0]);
    expect(names[0]).toEqual(
      expect.arrayContaining([
        '--accent',
        '--afk',
        '--page',
        '--card',
        '--border-strong',
        '--info',
        '--info-text',
        '--info-wash',
      ]),
    );
  });
});
