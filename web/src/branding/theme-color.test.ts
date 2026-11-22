import { afterEach, describe, expect, it } from 'vitest';
import { setTheme } from '@/theme/useTheme';
import { faviconHref } from './favicon';
import { syncThemeColor } from './theme-color';

const themeColors = () =>
  [...document.head.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')].map(
    (meta) => meta.content,
  );

afterEach(() => {
  document.head.innerHTML = '';
  document.documentElement.style.removeProperty('--page');
  document.documentElement.style.removeProperty('--accent');
  document.documentElement.style.removeProperty('--on-accent');
});

describe('theme-color', () => {
  it('uses the current --page and reuses the existing tag', () => {
    document.head.innerHTML = '<meta name="theme-color" content="#181927">';
    document.documentElement.style.setProperty('--page', '#d8ccb4');
    syncThemeColor();
    expect(themeColors()).toEqual(['#d8ccb4']);
  });

  it('falls back to the default page colour and adds a tag if there is none', () => {
    syncThemeColor();
    expect(themeColors()).toEqual(['#14110f']);
  });

  it('keeps the light colour while no stylesheet is loaded and the theme is light', () => {
    // What the theme-init script leaves before the CSS arrives.
    document.head.innerHTML = '<meta name="theme-color" content="#d8ccb4">';
    document.documentElement.dataset.theme = 'light';
    syncThemeColor();
    expect(themeColors()).toEqual(['#d8ccb4']);
  });

  it('falls back to the default colour for an unknown theme', () => {
    document.documentElement.dataset.theme = 'neon';
    syncThemeColor();
    expect(themeColors()).toEqual(['#14110f']);
  });

  it('follows a theme change, together with the favicon', () => {
    document.head.innerHTML =
      '<meta name="theme-color" content="#14110f"><link rel="icon" href="/favicon.svg">';
    // jsdom doesn't load themes.css, so stand in for the light theme's variables.
    document.documentElement.style.setProperty('--page', '#d8ccb4');
    document.documentElement.style.setProperty('--accent', '#936039');
    document.documentElement.style.setProperty('--on-accent', '#ffffff');
    setTheme('light');
    expect(document.documentElement.dataset.theme).toBe('light');
    expect(themeColors()).toEqual(['#d8ccb4']);
    expect(document.head.querySelector<HTMLLinkElement>('link[rel="icon"]')?.href).toBe(
      faviconHref('#936039', '#ffffff'),
    );
  });
});
