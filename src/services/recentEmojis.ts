// Most-recently-used reaction emojis, surfaced as quick-react buttons in the
// message actions bar. Stored through settingsSync's setSetting so the list
// follows the account across devices and same-tab listeners update live.

import { useEffect, useState } from 'react'
import { SETTINGS_CHANGED_EVENT, setSetting } from './settingsSync'

const KEY = 'vc_recent_emojis'
const MAX_STORED = 16

/** Shown until the user has reacted enough to fill the quick slots. */
const DEFAULTS = ['👍', '❤️', '😂']

function readStored(): string[] {
  try {
    const arr = JSON.parse(localStorage.getItem(KEY) ?? '[]')
    if (Array.isArray(arr)) return arr.filter((x): x is string => typeof x === 'string')
  } catch { /* ignore */ }
  return []
}

export function getRecentEmojis(limit = 3): string[] {
  const stored = readStored()
  return [...stored, ...DEFAULTS.filter(d => !stored.includes(d))].slice(0, limit)
}

/** Move an emoji to the front of the recency list (deduplicated, capped). */
export function recordRecentEmoji(emoji: string) {
  const rest = readStored().filter(e => e !== emoji)
  setSetting(KEY, JSON.stringify([emoji, ...rest].slice(0, MAX_STORED)))
}

/** Reactive read: re-renders when the list changes (locally or via sync). */
export function useRecentEmojis(limit = 3): string[] {
  const [recents, setRecents] = useState(() => getRecentEmojis(limit))
  useEffect(() => {
    const onChange = (e: Event) => {
      if ((e as CustomEvent).detail?.key === KEY) setRecents(getRecentEmojis(limit))
    }
    window.addEventListener(SETTINGS_CHANGED_EVENT, onChange)
    return () => window.removeEventListener(SETTINGS_CHANGED_EVENT, onChange)
  }, [limit])
  return recents
}
