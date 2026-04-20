import React, { useEffect, useState } from 'react'

/**
 * Tiny Twemoji renderer. Matches the naming convention Twemoji uses for its SVG
 * assets so we can point `<img>` tags at the jsDelivr CDN without bundling the
 * library. Covers plain pictographs, modifier pairs (skin tone), keycaps,
 * flags, and ZWJ sequences — enough for common chat use.
 */

const CDN_BASE = 'https://cdn.jsdelivr.net/gh/twitter/twemoji@14.0.2/assets/svg'

// Extended_Pictographic plus optional modifiers / FE0F / keycap / ZWJ sequences.
const EMOJI_RE = /\p{Extended_Pictographic}(?:\uFE0F?\u20E3|\p{Emoji_Modifier}|\uFE0F|\u200D\p{Extended_Pictographic}(?:\p{Emoji_Modifier}|\uFE0F)?)*/gu

// Regional-indicator flags (🇨🇭, etc.) consist of two RI characters — match them
// together as a single unit.
const FLAG_RE = /[\u{1F1E6}-\u{1F1FF}][\u{1F1E6}-\u{1F1FF}]/gu

function toCodePoint(s: string, sep = '-'): string {
  const r: string[] = []
  let p = 0
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (p) {
      r.push((0x10000 + ((p - 0xD800) << 10) + (c - 0xDC00)).toString(16))
      p = 0
    } else if (0xD800 <= c && c <= 0xDBFF) {
      p = c
    } else {
      r.push(c.toString(16))
    }
  }
  return r.join(sep)
}

function emojiToCodepoint(raw: string): string {
  // Twemoji strips the VS-16 (U+FE0F) unless the sequence includes a ZWJ.
  return toCodePoint(raw.indexOf('\u200D') < 0 ? raw.replace(/\uFE0F/g, '') : raw)
}

function emojiImg(raw: string, key: string | number): React.ReactNode {
  const cp = emojiToCodepoint(raw)
  if (!cp) return raw
  return React.createElement('img', {
    key,
    className: 'twemoji',
    src: `${CDN_BASE}/${cp}.svg`,
    alt: raw,
    draggable: false,
    loading: 'lazy',
  })
}

/** Split a string into nodes, replacing emoji runs with Twemoji <img> tags. */
export function twemojifyString(text: string): React.ReactNode {
  if (!text) return text
  const out: React.ReactNode[] = []
  let lastIndex = 0
  let keyCounter = 0

  // Build a combined array of all emoji matches (flags + regular), sorted by index.
  interface Match { start: number; end: number; raw: string }
  const matches: Match[] = []
  let m: RegExpExecArray | null

  const flagRe = new RegExp(FLAG_RE.source, FLAG_RE.flags)
  while ((m = flagRe.exec(text)) !== null) {
    matches.push({ start: m.index, end: m.index + m[0].length, raw: m[0] })
  }
  const emojiRe = new RegExp(EMOJI_RE.source, EMOJI_RE.flags)
  while ((m = emojiRe.exec(text)) !== null) {
    const start = m.index
    const end = start + m[0].length
    // Skip if this range is already covered by a flag match.
    if (matches.some(f => f.start < end && start < f.end)) continue
    matches.push({ start, end, raw: m[0] })
  }
  matches.sort((a, b) => a.start - b.start)

  for (const match of matches) {
    if (match.start > lastIndex) out.push(text.slice(lastIndex, match.start))
    out.push(emojiImg(match.raw, `tw-${keyCounter++}`))
    lastIndex = match.end
  }
  if (lastIndex < text.length) out.push(text.slice(lastIndex))
  return out.length === 0 ? text : out
}

/** Walk a children tree and apply Twemoji replacement to any string fragments. */
export function twemojifyChildren(children: React.ReactNode): React.ReactNode {
  return React.Children.map(children, (child) => {
    if (typeof child === 'string') return twemojifyString(child)
    return child
  })
}

/**
 * Hook for reading the "use Twemoji" setting reactively. Listens for the
 * `vc:settings-changed` custom event so toggling it in the settings modal
 * updates all subscribed components without a reload.
 */
export function useTwemojiEnabled(): boolean {
  const [enabled, setEnabled] = useState(
    () => localStorage.getItem('vc_use_twemoji') === 'true',
  )
  useEffect(() => {
    function onChange() {
      setEnabled(localStorage.getItem('vc_use_twemoji') === 'true')
    }
    window.addEventListener('vc:settings-changed', onChange)
    return () => window.removeEventListener('vc:settings-changed', onChange)
  }, [])
  return enabled
}
