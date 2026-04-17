import { useSyncExternalStore } from 'react'
import en from '../locales/en'
import de from '../locales/de'
import fr from '../locales/fr'
import it from '../locales/it'
import es from '../locales/es'

export type Locale = 'en' | 'de' | 'fr' | 'it' | 'es'

export const LOCALES: Array<{ id: Locale; nativeLabel: string; englishLabel: string }> = [
  { id: 'en', nativeLabel: 'English',  englishLabel: 'English' },
  { id: 'de', nativeLabel: 'Deutsch',  englishLabel: 'German'  },
  { id: 'fr', nativeLabel: 'Français', englishLabel: 'French'  },
  { id: 'it', nativeLabel: 'Italiano', englishLabel: 'Italian' },
  { id: 'es', nativeLabel: 'Español',  englishLabel: 'Spanish' },
]

type Dictionary = Record<string, string>

const DICTIONARIES: Record<Locale, Dictionary> = { en, de, fr, it, es }

const STORAGE_KEY = 'vc_locale'

function detectInitialLocale(): Locale {
  const stored = typeof localStorage !== 'undefined' ? localStorage.getItem(STORAGE_KEY) : null
  if (stored && stored in DICTIONARIES) return stored as Locale
  const nav = typeof navigator !== 'undefined' ? navigator.language.slice(0, 2).toLowerCase() : 'en'
  if (nav in DICTIONARIES) return nav as Locale
  return 'en'
}

let currentLocale: Locale = detectInitialLocale()

const listeners = new Set<() => void>()

export function getLocale(): Locale {
  return currentLocale
}

export function setLocale(locale: Locale): void {
  if (!(locale in DICTIONARIES)) return
  if (currentLocale === locale) return
  currentLocale = locale
  try { localStorage.setItem(STORAGE_KEY, locale) } catch {}
  try { document.documentElement.setAttribute('lang', locale) } catch {}
  listeners.forEach(l => l())
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/**
 * Translate a key. Falls back to English, then to the raw key if both are
 * missing. Vars in the string use {name} placeholders.
 */
export function t(key: string, vars?: Record<string, string | number>): string {
  const dict = DICTIONARIES[currentLocale]
  const raw = dict[key] ?? DICTIONARIES.en[key] ?? key
  if (!vars) return raw
  return raw.replace(/\{(\w+)\}/g, (_, name) => {
    const v = vars[name]
    return v === undefined ? `{${name}}` : String(v)
  })
}

/**
 * React hook: re-renders when the locale changes. Returns a `t` function
 * bound to the current locale.
 */
export function useTranslation(): { t: typeof t; locale: Locale } {
  const locale = useSyncExternalStore(subscribe, getLocale, getLocale)
  return { t, locale }
}

export function initLocale(): void {
  try { document.documentElement.setAttribute('lang', currentLocale) } catch {}
}
