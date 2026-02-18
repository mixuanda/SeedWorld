/**
 * World-Seed Renderer Entry
 * Mounts the React application
 */

import React from 'react';
import { createRoot } from 'react-dom/client';
import AppRoot from './App';
import './index.css';
import i18n, { LANGUAGE_CACHE_KEY } from './i18n';
import { applyThemeMode, readCachedThemeMode } from './theme';

// Mount React app to root container
const container = document.getElementById('root');
if (!container) {
  throw new Error('Root container not found');
}

// Apply cached theme mode before first paint to reduce theme flicker.
applyThemeMode(readCachedThemeMode());

const root = createRoot(container);

async function bootstrap(): Promise<void> {
  try {
    const preferences = await window.api.preferences.get();
    applyThemeMode(preferences.themeMode);
    await i18n.changeLanguage(preferences.language);
    localStorage.setItem(LANGUAGE_CACHE_KEY, preferences.language);
  } catch (error) {
    console.warn('[renderer] Failed to load persisted preferences, using cached defaults', error);
  }

  root.render(React.createElement(AppRoot));
  console.log('🌱 World-Seed renderer loaded');
}

void bootstrap();
