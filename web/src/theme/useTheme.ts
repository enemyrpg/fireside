import { useCallback, useSyncExternalStore } from 'react';
import { syncFavicon } from '@/branding/favicon';
import { syncThemeColor } from '@/branding/theme-color';
import { applyTheme, DEFAULT_THEME, isThemeId, storeTheme, type ThemeId } from './themes';

// The current theme lives on <html data-theme>, set by the inline script
// before React renders. This hook reads it from there and keeps it in sync.

const listeners = new Set<() => void>();

function currentTheme(): ThemeId {
  const value = document.documentElement.dataset.theme;
  return isThemeId(value) ? value : DEFAULT_THEME;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Changes the theme, stores it and updates every component that shows it. */
export function setTheme(id: ThemeId): void {
  applyTheme(id);
  storeTheme(id);
  syncFavicon();
  syncThemeColor();
  listeners.forEach((listener) => {
    listener();
  });
}

export function useTheme(): [ThemeId, (id: ThemeId) => void] {
  const theme = useSyncExternalStore(subscribe, currentTheme);
  return [
    theme,
    useCallback((id: ThemeId) => {
      setTheme(id);
    }, []),
  ];
}
