import React from 'react'
import type { MatrixClient, Room } from 'matrix-js-sdk'

/**
 * MSC2545: Image Packs (Emoticons & Stickers).
 *
 * Room emote packs are stored as state events of type `im.ponies.room_emotes`.
 * The default room pack uses an empty state_key; additional packs use arbitrary
 * state_keys. A pack's `images` map shortcodes (without colons) to mxc refs.
 *
 * Usage types on a pack: "emoticon" (inline + reaction) and/or "sticker". We
 * surface emoticons only; stickers are already handled by the existing sticker
 * pack system.
 */

export const EMOTES_STATE_TYPE = 'im.ponies.room_emotes'

export interface RoomEmote {
  shortcode: string
  url: string
  info?: { w?: number; h?: number; mimetype?: string; size?: number; body?: string }
  pack?: string
}

export interface PackInfo {
  stateKey: string
  displayName?: string
  avatarUrl?: string
  usage?: string[]
}

/**
 * Returns all emoticons from all packs in the given room. Usage is considered
 * "emoticon" if absent (spec default) or if the array explicitly contains it.
 */
export function getRoomEmotes(room: Room | null): RoomEmote[] {
  if (!room) return []
  const events = room.currentState.getStateEvents(EMOTES_STATE_TYPE as any)
  const list = Array.isArray(events) ? events : events ? [events] : []
  const out: RoomEmote[] = []
  for (const ev of list) {
    const content = ev.getContent() as any
    const images = content?.images
    if (!images || typeof images !== 'object') continue
    const packName = ev.getStateKey() || 'default'
    const packUsage: string[] | undefined = content?.pack?.usage
    for (const [shortcode, image] of Object.entries(images)) {
      if (!shortcode || !image || typeof image !== 'object') continue
      const img = image as any
      const url: string | undefined = img.url
      if (!url || !url.startsWith('mxc://')) continue
      // Per-image usage overrides pack usage; if neither set, treat as emoticon.
      const usage: string[] | undefined = img.usage ?? packUsage
      if (usage && !usage.includes('emoticon')) continue
      out.push({ shortcode, url, info: img.info, pack: packName })
    }
  }
  return out
}

/** Convenience: build a shortcode -> emote map. Later packs override earlier. */
export function getRoomEmoteMap(room: Room | null): Record<string, RoomEmote> {
  const map: Record<string, RoomEmote> = {}
  for (const e of getRoomEmotes(room)) map[e.shortcode] = e
  return map
}

/**
 * Render `:shortcode:` references in a plain-text string as inline images when
 * they match a known emote. Non-matching `:text:` and all other text are
 * returned as plain strings.
 *
 * Callers that also render markdown should either run this after stripping
 * markdown, or accept that shortcodes inside code blocks / URLs will also be
 * replaced. For now we only use this for reaction keys (no markdown).
 */
const SHORTCODE_RE = /:([a-zA-Z0-9_+\-.]{1,64}):/g

export function renderEmoteString(
  text: string,
  emotes: Record<string, RoomEmote>,
  client: MatrixClient | null,
  sizePx = 18,
): React.ReactNode {
  if (!text || !client) return text
  if (!Object.keys(emotes).length) return text
  const parts: React.ReactNode[] = []
  let lastIndex = 0
  let match: RegExpExecArray | null
  SHORTCODE_RE.lastIndex = 0
  while ((match = SHORTCODE_RE.exec(text)) !== null) {
    const shortcode = match[1]
    const emote = emotes[shortcode]
    if (!emote) continue
    if (match.index > lastIndex) {
      parts.push(text.slice(lastIndex, match.index))
    }
    const httpUrl = (client as any).mxcUrlToHttp(emote.url, sizePx * 2, sizePx * 2, 'scale', false, true) as string | null
    if (httpUrl) {
      parts.push(
        React.createElement('img', {
          key: `e${match.index}`,
          src: httpUrl,
          alt: `:${shortcode}:`,
          title: `:${shortcode}:`,
          className: 'custom-emote',
          loading: 'lazy',
        }),
      )
    } else {
      parts.push(match[0])
    }
    lastIndex = match.index + match[0].length
  }
  if (lastIndex === 0) return text
  if (lastIndex < text.length) parts.push(text.slice(lastIndex))
  return parts
}

/** True if the reaction `key` is a custom-emoji shortcode present in emotes. */
export function isCustomEmoteKey(key: string, emotes: Record<string, RoomEmote>): RoomEmote | null {
  const m = key.match(/^:([a-zA-Z0-9_+\-.]{1,64}):$/)
  if (!m) return null
  return emotes[m[1]] ?? null
}

/**
 * Upload a file to the homeserver and return the mxc URL along with info. The
 * returned info mirrors the fields the MSC2545 spec recommends.
 */
export async function uploadEmote(client: MatrixClient, file: File): Promise<{ url: string; info: RoomEmote['info'] }> {
  const resp = await client.uploadContent(file, { type: file.type }) as any
  const url = resp.content_uri as string
  const info: RoomEmote['info'] = { mimetype: file.type, size: file.size }
  try {
    const dims = await probeImageSize(file)
    if (dims) { info.w = dims.w; info.h = dims.h }
  } catch { /* ignore */ }
  return { url, info }
}

/** Replace the default room emote pack (state_key="") with the given images. */
export async function setDefaultRoomEmotes(
  client: MatrixClient,
  roomId: string,
  images: Record<string, { url: string; info?: RoomEmote['info'] }>,
  packDisplayName?: string,
): Promise<void> {
  const content = {
    images,
    pack: {
      display_name: packDisplayName ?? 'Room emotes',
      usage: ['emoticon'],
    },
  }
  await client.sendStateEvent(roomId, EMOTES_STATE_TYPE as any, content as any, '')
}

function probeImageSize(file: File): Promise<{ w: number; h: number } | null> {
  return new Promise(resolve => {
    const url = URL.createObjectURL(file)
    const img = new Image()
    img.onload = () => { URL.revokeObjectURL(url); resolve({ w: img.naturalWidth, h: img.naturalHeight }) }
    img.onerror = () => { URL.revokeObjectURL(url); resolve(null) }
    img.src = url
  })
}
