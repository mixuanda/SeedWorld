import type { ThemeMode } from './global';

export const THEME_CACHE_KEY = 'seedworld.theme';

function getSystemTheme(): 'dark' | 'light' {
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export function resolveThemeMode(themeMode: ThemeMode): 'dark' | 'light' {
  if (themeMode === 'system') {
    return getSystemTheme();
  }
  return themeMode;
}

export function applyThemeMode(themeMode: ThemeMode): void {
  const root = document.documentElement;
  const resolved = resolveThemeMode(themeMode);
  root.setAttribute('data-theme-mode', themeMode);
  root.setAttribute('data-theme', resolved);

  try {
    localStorage.setItem(THEME_CACHE_KEY, themeMode);
  } catch {
    // Ignore storage write failures.
  }
}

export function readCachedThemeMode(): ThemeMode {
  try {
    const raw = localStorage.getItem(THEME_CACHE_KEY);
    if (raw === 'dark' || raw === 'light' || raw === 'system') {
      return raw;
    }
  } catch {
    // Ignore storage read failures.
  }
  return 'system';
}
