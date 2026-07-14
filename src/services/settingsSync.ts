// Sync user preferences across devices via a private `vc.settings` account-data
// event. localStorage stays the source of truth every consumer already reads;
// this service mirrors the synced subset of it to the homeserver and applies
// remote changes back into localStorage (plus the live DOM/locale side effects).
//
// Loop safety: pushes are compare-based. We remember the last state we synced
// with the server (`lastSyncedJson`) and only PUT account data when the local
// snapshot actually differs, so our own sync echoes and re-applied remote
// values never trigger another write.

import { getThemeMode } from './themes'
import { setLocale, Locale } from './i18n'

export const SETTINGS_EVENT = 'vc.settings'

/** Same-tab change signal; the native `storage` event only fires in other tabs. */
export const SETTINGS_CHANGED_EVENT = 'vc:settings-changed'

/**
 * localStorage keys that follow the account. Deliberately excluded:
 * session keys (mx_*), per-device layout (vc_layout, vc_sidenav,
 * vc_sidebar_open), presence (vc_presence, vc_status_msg — presence lives on
 * the server already), and keys with their own account-data events
 * (vc_space_order, vc_channel_groups, vc_channel_order).
 */
export const SYNCED_SETTINGS_KEYS = [
  'vc_theme',
  'vc_glass',
  'vc_font_size',
  'vc_locale',
  'vc_use_twemoji',
  'vc_send_typing',
  'vc_send_read_receipts',
  'vc_url_previews',
  'vc_gif_hover_play',
  'vc_gif_favorites',
  'vc_show_member_join',
  'vc_show_member_leave',
  'vc_show_profile_change',
  'vc_show_room_change',
  'vc_show_deleted_messages',
  'vc_encrypt_rooms_default',
  'vc_autoformat_json',
  'vc_pinned_rooms',
  'vc_recent_emojis',
] as const

let lastSyncedJson: string | null = null

/** Stable snapshot: synced keys only, in fixed order, so string comparison works. */
function normalize(settings: Record<string, string>): string {
  const out: Record<string, string> = {}
  for (const key of SYNCED_SETTINGS_KEYS) {
    if (settings[key] !== undefined) out[key] = settings[key]
  }
  return JSON.stringify(out)
}

export function notifySettingsChanged(key: string) {
  try {
    window.dispatchEvent(new CustomEvent(SETTINGS_CHANGED_EVENT, { detail: { key } }))
  } catch { /* ignore */ }
}

/** Write a setting locally and signal listeners (same-tab reactivity + sync push). */
export function setSetting(key: string, value: string) {
  try { localStorage.setItem(key, value) } catch { /* ignore quota */ }
  notifySettingsChanged(key)
}

export function collectLocalSettings(): Record<string, string> {
  const out: Record<string, string> = {}
  for (const key of SYNCED_SETTINGS_KEYS) {
    const val = localStorage.getItem(key)
    if (val !== null) out[key] = val
  }
  return out
}

/**
 * Validate account-data content. Unknown or non-string entries are dropped
 * rather than rejecting the whole event, so future keys stay compatible.
 */
export function parseSettingsContent(content: unknown): Record<string, string> | null {
  const settings = (content as { settings?: unknown } | undefined)?.settings
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) return null
  const result: Record<string, string> = {}
  for (const [key, val] of Object.entries(settings as Record<string, unknown>)) {
    if (typeof val === 'string') result[key] = val
  }
  return result
}

/** True when the local snapshot differs from what the server last had. */
export function settingsNeedPush(local: Record<string, string>): boolean {
  if (lastSyncedJson === null) return Object.keys(local).length > 0
  return normalize(local) !== lastSyncedJson
}

/** Record that `settings` is now what the server holds. */
export function markSettingsSynced(settings: Record<string, string>) {
  lastSyncedJson = normalize(settings)
}

/** Re-apply live side effects for keys whose consumers don't poll localStorage. */
function applySideEffects(key: string, value: string) {
  const root = document.documentElement
  switch (key) {
    case 'vc_theme':
      root.setAttribute('data-theme', value)
      root.setAttribute('data-theme-mode', getThemeMode(value))
      break
    case 'vc_glass':
      root.setAttribute('data-glass', value)
      break
    case 'vc_font_size':
      root.style.setProperty('--app-font-size', `${value}px`)
      break
    case 'vc_locale':
      setLocale(value as Locale) // validates internally; no-op on unknown locales
      break
  }
}

/**
 * Apply settings coming from the server: write differing values into
 * localStorage, run live side effects, and notify same-tab listeners.
 * Only whitelisted keys are touched. Returns the keys that changed.
 */
export function applyRemoteSettings(remote: Record<string, string>): string[] {
  const changed: string[] = []
  for (const key of SYNCED_SETTINGS_KEYS) {
    const val = remote[key]
    if (val === undefined) continue // additive: never delete local values
    if (localStorage.getItem(key) === val) continue
    try { localStorage.setItem(key, val) } catch { /* ignore quota */ }
    applySideEffects(key, val)
    changed.push(key)
  }
  markSettingsSynced(remote)
  for (const key of changed) notifySettingsChanged(key)
  return changed
}
