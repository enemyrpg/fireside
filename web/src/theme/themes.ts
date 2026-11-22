// Theme registry. A theme is a CSS block in themes.css plus one line here. This
// file is also read by vite.config.ts to build the script file that sets the
// theme before React renders (theme-init-plugin.ts), so it must not touch
// browser globals at import time.

export interface ThemeInfo {
  id: string;
  label: string;
  note: string;
  /**
   * The theme's `--page` colour, copied here for `<meta name="theme-color">`
   * before the CSS loads (theme-init script) and for the web app manifest.
   * A test checks that it matches themes.css.
   */
  page: string;
  /** The theme's `color-scheme` (light or dark), for libraries that only know those two. Tested against themes.css. */
  scheme: 'dark' | 'light';
}

export const THEMES = [
  { id: 'ember', label: 'Ember', note: 'Default', page: '#14110f', scheme: 'dark' },
  { id: 'dark', label: 'Dark', note: 'Indigo', page: '#181927', scheme: 'dark' },
  { id: 'light', label: 'Light', note: 'Parchment', page: '#d8ccb4', scheme: 'light' },
] as const satisfies readonly ThemeInfo[];

export type ThemeId = (typeof THEMES)[number]['id'];

export const DEFAULT_THEME: ThemeId = 'ember';

/** `--page` of the default theme: the manifest colours and the static theme-color tag. */
export const DEFAULT_PAGE_COLOR: string =
  THEMES.find((theme) => theme.id === DEFAULT_THEME)?.page ?? THEMES[0].page;

/** `localStorage` key for the chosen theme. */
export const THEME_STORAGE_KEY = 'theme';

const THEME_IDS: readonly string[] = THEMES.map((theme) => theme.id);

export function isThemeId(value: unknown): value is ThemeId {
  return typeof value === 'string' && THEME_IDS.includes(value);
}

/** Minimal storage interface, so tests can pass a fake or a throwing one. */
export type ThemeStorage = Pick<Storage, 'getItem' | 'setItem'>;

function defaultStorage(): ThemeStorage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    // Accessing localStorage throws when site data is blocked.
    return undefined;
  }
}

/** The stored theme, or the default if nothing valid is stored or storage fails. */
export function readStoredTheme(storage = defaultStorage()): ThemeId {
  try {
    const value = storage?.getItem(THEME_STORAGE_KEY);
    return isThemeId(value) ? value : DEFAULT_THEME;
  } catch {
    return DEFAULT_THEME;
  }
}

/** Stores the theme. Failing storage is ignored: the theme still applies for this visit. */
export function storeTheme(id: ThemeId, storage = defaultStorage()): void {
  try {
    storage?.setItem(THEME_STORAGE_KEY, id);
  } catch {
    // Private mode or blocked site data.
  }
}

export function applyTheme(id: ThemeId, root: HTMLElement = document.documentElement): void {
  root.dataset.theme = id;
}

/**
 * Source of `theme-init.js`, loaded at the top of index.html. It runs before
 * the bundle, so the page never shows the wrong theme first. Same key and ids
 * as above. It also sets `<meta name="theme-color">` (injected just before
 * the script) to the theme's page colour, so an installed app's title bar
 * never starts out in the wrong theme.
 */
export function themeInitScript(): string {
  const pages = JSON.stringify(Object.fromEntries(THEMES.map((theme) => [theme.id, theme.page])));
  const key = JSON.stringify(THEME_STORAGE_KEY);
  const fallback = JSON.stringify(DEFAULT_THEME);
  return (
    `(function(){var p=${pages},t;try{t=localStorage.getItem(${key})}catch(e){}` +
    `if(!Object.prototype.hasOwnProperty.call(p,t))t=${fallback};` +
    `document.documentElement.setAttribute("data-theme",t);` +
    `var m=document.querySelector('meta[name="theme-color"]');if(m)m.setAttribute("content",p[t])})()`
  );
}
