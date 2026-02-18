import { createInstance } from 'i18next';
import { initReactI18next } from 'react-i18next';
import en from './locales/en.json';
import zhHant from './locales/zh-Hant.json';

export const LANGUAGE_CACHE_KEY = 'seedworld.language';

const fallbackLanguage = 'en';
const i18n = createInstance();

function getCachedLanguage(): 'en' | 'zh-Hant' {
  try {
    const raw = localStorage.getItem(LANGUAGE_CACHE_KEY);
    if (raw === 'zh-Hant') {
      return 'zh-Hant';
    }
  } catch {
    // Ignore cache read failures.
  }
  return 'en';
}

if (!i18n.isInitialized) {
  i18n
    .use(initReactI18next)
    .init({
      resources: {
        en: {
          translation: en,
        },
        'zh-Hant': {
          translation: zhHant,
        },
      },
      lng: getCachedLanguage(),
      fallbackLng: fallbackLanguage,
      interpolation: {
        escapeValue: false,
      },
      returnNull: false,
    })
    .catch((error) => {
      console.error('[i18n] Initialization failed', error);
    });
}

export default i18n;
