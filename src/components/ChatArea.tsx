import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { MatrixEvent, EventType, MsgType } from 'matrix-js-sdk'
import ReactMarkdown from 'react-markdown'
import { useMatrix } from '../context/MatrixContext'
import MessageInput from './MessageInput'
import MxcAvatar from './MxcAvatar'
import { ProfilePopup, ProfileInfo } from './ProfilePopup'
import { fetchMediaBlobUrl } from '../services/media'
import { useImageViewer } from './ImageLightbox'
import { isVoiceChannel } from '../services/roomKind'
import { getRoomEmoteMap, renderEmoteString, isCustomEmoteKey, type RoomEmote } from '../services/emotes'
import ForwardModal from './ForwardModal'

// Local context so emote-aware components don't need prop-drilling.
const EmoteMapContext = React.createContext<Record<string, RoomEmote>>({})
function useEmoteMap() { return React.useContext(EmoteMapContext) }

// ---- Spoiler support ----

/** Regex to match ||spoiler text|| (Discord/Matrix convention). Non-greedy, no nesting. */
const SPOILER_RE = /\|\|(.+?)\|\|/g

function Spoiler({ reason, children }: { reason?: string; children: React.ReactNode }) {
  const [revealed, setRevealed] = useState(false)
  return (
    <span
      className={`spoiler${revealed ? ' spoiler--revealed' : ''}`}
      onClick={() => setRevealed(r => !r)}
      title={reason ? `Spoiler: ${reason}` : 'Spoiler (click to reveal)'}
    >
      <span className="spoiler-content">{children}</span>
    </span>
  )
}

/**
 * Parse a plain-text body for ||spoiler|| segments and return React nodes,
 * rendering non-spoiler parts through ReactMarkdown.
 */
function renderBodyWithSpoilers(text: string): React.ReactNode {
  const parts: React.ReactNode[] = []
  let lastIndex = 0
  let match: RegExpExecArray | null
  const re = new RegExp(SPOILER_RE.source, SPOILER_RE.flags)
  while ((match = re.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push(<ReactMarkdown key={`t${lastIndex}`}>{text.slice(lastIndex, match.index)}</ReactMarkdown>)
    }
    parts.push(<Spoiler key={`s${match.index}`}>{match[1]}</Spoiler>)
    lastIndex = re.lastIndex
  }
  if (lastIndex < text.length) {
    parts.push(<ReactMarkdown key={`t${lastIndex}`}>{text.slice(lastIndex)}</ReactMarkdown>)
  }
  return parts.length > 0 ? parts : <ReactMarkdown>{text}</ReactMarkdown>
}

/**
 * Parse Matrix-spec formatted_body HTML for spoiler spans:
 * `<span data-mx-spoiler="optional reason">hidden</span>`
 * Returns React nodes if spoilers are found, otherwise null (caller falls back to plain body).
 */
function renderFormattedSpoilers(html: string): React.ReactNode | null {
  if (!html.includes('data-mx-spoiler')) return null
  const parser = new DOMParser()
  const doc = parser.parseFromString(`<div>${html}</div>`, 'text/html')
  const root = doc.body.firstElementChild
  if (!root) return null

  function walk(node: Node): React.ReactNode {
    if (node.nodeType === Node.TEXT_NODE) {
      return node.textContent
    }
    if (node.nodeType === Node.ELEMENT_NODE) {
      const el = node as HTMLElement
      if (el.hasAttribute('data-mx-spoiler')) {
        const reason = el.getAttribute('data-mx-spoiler') || undefined
        return <Spoiler reason={reason}>{el.textContent}</Spoiler>
      }
      // Recursively render children for non-spoiler elements
      const children = Array.from(el.childNodes).map((child, i) => (
        <React.Fragment key={i}>{walk(child)}</React.Fragment>
      ))
      return <>{children}</>
    }
    return null
  }

  return <>{Array.from(root.childNodes).map((child, i) => (
    <React.Fragment key={i}>{walk(child)}</React.Fragment>
  ))}</>
}

// ---- Pinned Messages Modal ----

function PinnedMessagesModal({ roomId, onClose }: { roomId: string; onClose: () => void }) {
  const { client } = useMatrix()
  const [items, setItems] = useState<Array<{ id: string; sender: string; body: string; ts: number } | null>>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!client) return
    const room = client.getRoom(roomId)
    if (!room) { setLoading(false); return }
    const pinned = (room.currentState.getStateEvents('m.room.pinned_events', '')?.getContent()?.pinned ?? []) as string[]
    if (pinned.length === 0) { setLoading(false); return }
    Promise.all(pinned.map(async (eventId) => {
      const local = room.findEventById(eventId)
      if (local && !local.isRedacted()) {
        return {
          id: eventId,
          sender: local.getSender()?.replace(/^@/, '').split(':')[0] ?? 'Unknown',
          body: local.getContent().body ?? '',
          ts: local.getTs(),
        }
      }
      try {
        const raw = await (client as any).fetchRoomEvent(roomId, eventId)
        return {
          id: eventId,
          sender: (raw.sender ?? '').replace(/^@/, '').split(':')[0] || 'Unknown',
          body: raw.content?.body ?? '',
          ts: raw.origin_server_ts ?? 0,
        }
      } catch {
        return null
      }
    })).then(results => {
      setItems(results)
      setLoading(false)
    })
  }, [client, roomId])

  const valid = items.filter(Boolean) as { id: string; sender: string; body: string; ts: number }[]

  return (
    <div className="modal-overlay" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="modal-card pinned-modal">
        <h2>Pinned Messages</h2>
        {loading ? (
          <div style={{ display: 'flex', justifyContent: 'center', padding: '24px 0' }}><div className="spinner" /></div>
        ) : valid.length === 0 ? (
          <p style={{ color: 'var(--text-muted)', fontSize: 13, padding: '8px 0' }}>No pinned messages in this room.</p>
        ) : (
          <div className="pinned-list">
            {valid.map(e => (
              <div key={e.id} className="pinned-item">
                <div className="pinned-item-header">
                  <span className="pinned-item-sender">{e.sender}</span>
                  <span className="pinned-item-time">
                    {e.ts ? new Date(e.ts).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : ''}
                  </span>
                </div>
                <div className="pinned-item-body">{e.body}</div>
              </div>
            ))}
          </div>
        )}
        <div className="modal-actions">
          <button className="btn-secondary" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  )
}

// ---- Search Modal ----

function SearchModal({ roomId, onClose }: { roomId: string | null; onClose: () => void }) {
  const { client, setActiveRoom } = useMatrix()
  const [query, setQuery] = useState('')
  const [scope, setScope] = useState<'room' | 'global'>(roomId ? 'room' : 'global')
  const [results, setResults] = useState<any[]>([])
  const [searching, setSearching] = useState(false)
  const [searched, setSearched] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleSearch() {
    if (!query.trim() || !client) return
    setSearching(true)
    setError(null)
    setSearched(false)
    try {
      const filter: any = {}
      if (scope === 'room' && roomId) filter.rooms = [roomId]
      const resp = await (client as any).search({
        body: {
          search_categories: {
            room_events: {
              search_term: query.trim(),
              filter,
              order_by: 'recent',
              event_context: { before_limit: 0, after_limit: 0, include_profile: false },
            },
          },
        },
      })
      setResults(resp.search_categories?.room_events?.results ?? [])
      setSearched(true)
    } catch (e: any) {
      setError(e?.message ?? 'Search failed')
    } finally {
      setSearching(false)
    }
  }

  async function jumpToResult(ev: any) {
    const targetRoomId = ev.room_id as string | undefined
    if (!targetRoomId) return
    try {
      await setActiveRoom(targetRoomId)
    } catch (err) {
      console.error('Failed to switch room:', err)
    }
    onClose()
  }

  return (
    <div className="modal-overlay" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="modal-card search-modal">
        <h2>Search Messages</h2>
        <div className="search-scope-tabs">
          <button
            className={`search-scope-tab${scope === 'room' ? ' active' : ''}`}
            onClick={() => setScope('room')}
            disabled={!roomId}
            type="button"
          >
            This room
          </button>
          <button
            className={`search-scope-tab${scope === 'global' ? ' active' : ''}`}
            onClick={() => setScope('global')}
            type="button"
          >
            All rooms
          </button>
        </div>
        <div className="search-input-row">
          <input
            type="text"
            className="search-modal-input"
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleSearch()}
            placeholder={scope === 'room' ? 'Search in this room…' : 'Search in all your rooms…'}
            autoFocus
          />
          <button
            className="btn-primary"
            style={{ display: 'inline-block', width: 'auto', marginTop: 0 }}
            onClick={handleSearch}
            disabled={searching || !query.trim()}
          >
            {searching ? '…' : 'Search'}
          </button>
        </div>
        {error && <p style={{ color: '#fca5a5', fontSize: 13, margin: '4px 0' }}>{error}</p>}
        <div className="search-results">
          {searched && results.length === 0 && (
            <p style={{ color: 'var(--text-muted)', fontSize: 13, padding: '8px 0' }}>No results found.</p>
          )}
          {results.map((r: any, i: number) => {
            const ev = r.result
            const sender = (ev.sender ?? '').replace(/^@/, '').split(':')[0] || 'Unknown'
            const body = ev.content?.body ?? ''
            const ts = ev.origin_server_ts
              ? new Date(ev.origin_server_ts).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
              : ''
            const resultRoomId = ev.room_id as string | undefined
            const resultRoomName = resultRoomId ? (client?.getRoom(resultRoomId)?.name ?? resultRoomId) : null
            return (
              <button
                key={i}
                className="search-result-item search-result-item--clickable"
                onClick={() => jumpToResult(ev)}
                type="button"
              >
                <div className="search-result-header">
                  <span className="search-result-sender">{sender}</span>
                  {scope === 'global' && resultRoomName && (
                    <span className="search-result-room">#{resultRoomName}</span>
                  )}
                  <span className="search-result-time">{ts}</span>
                </div>
                <div className="search-result-body">{body}</div>
              </button>
            )
          })}
        </div>
        <div className="modal-actions">
          <button className="btn-secondary" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  )
}

function formatTime(ts: number): string {
  const d = new Date(ts)
  const now = new Date()
  const isToday =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate()
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  if (isToday) return `Today at ${time}`
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ` at ${time}`
}

function formatShortTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

function formatDateLabel(ts: number): string {
  const d = new Date(ts)
  const now = new Date()
  if (d.toDateString() === now.toDateString()) return 'Today'
  const yesterday = new Date(now)
  yesterday.setDate(now.getDate() - 1)
  if (d.toDateString() === yesterday.toDateString()) return 'Yesterday'
  return d.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' })
}

interface MessageGroup {
  sender: string
  senderName: string
  avatarMxc: string | null
  events: MatrixEvent[]
}

function groupMessages(events: MatrixEvent[], client: any, room: any): MessageGroup[] {
  const groups: MessageGroup[] = []
  let lastSender = ''
  let lastTs = 0

  for (const event of events) {
    const sender = event.getSender() ?? ''
    const ts = event.getTs()
    const gap = ts - lastTs > 5 * 60 * 1000

    const member = room?.getMember(sender)
    const user = client?.getUser(sender)
    const displayName = member?.name || user?.displayName || sender.replace(/^@/, '').split(':')[0] || sender
    const avatarMxc = member?.getMxcAvatarUrl() ?? user?.avatarUrl ?? null

    if (sender !== lastSender || gap) {
      groups.push({ sender, senderName: displayName, avatarMxc, events: [event] })
    } else {
      groups[groups.length - 1].events.push(event)
    }
    lastSender = sender
    lastTs = ts
  }
  return groups
}

// ---- Image component (authenticated fetch → blob URL) ----

// ---- Encrypted attachment decryption ----
// Decrypts Matrix encrypted attachments per MSC/spec: AES-256-CTR over the
// raw bytes at file.url, keyed by the JWK-wrapped symmetric key, verified
// against the sha256 of the ciphertext.
interface EncryptedFileInfo {
  url: string
  iv: string
  hashes?: { sha256?: string }
  key: { alg: string; k: string; kty: string; key_ops: string[]; ext: boolean }
}

function base64UrlToBytes(str: string): Uint8Array {
  const pad = str.length % 4 === 0 ? 0 : 4 - (str.length % 4)
  const normalized = str.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat(pad)
  const bin = atob(normalized)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

function base64ToBytes(str: string): Uint8Array {
  const pad = str.length % 4 === 0 ? 0 : 4 - (str.length % 4)
  const bin = atob(str + '='.repeat(pad))
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

function bytesToBase64Unpadded(bytes: Uint8Array): string {
  let s = ''
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i])
  return btoa(s).replace(/=+$/, '')
}

async function fetchAndDecryptAttachment(file: EncryptedFileInfo, client: any): Promise<Blob> {
  const token = localStorage.getItem('mx_access_token')
  const authUrl = token
    ? (client.mxcUrlToHttp(file.url, undefined, undefined, undefined, false, undefined, true) ?? null)
    : (client.mxcUrlToHttp(file.url) ?? null)
  const legacyUrl = client.mxcUrlToHttp(file.url) ?? null
  const tryUrls: Array<[string, boolean]> = []
  if (authUrl) tryUrls.push([authUrl, !!token])
  if (legacyUrl && legacyUrl !== authUrl) tryUrls.push([legacyUrl, false])

  let cipherBuf: ArrayBuffer | null = null
  for (const [url, useAuth] of tryUrls) {
    try {
      const r = await fetch(url, useAuth ? { headers: { Authorization: `Bearer ${token}` } } : undefined)
      if (r.ok) { cipherBuf = await r.arrayBuffer(); break }
      if (r.status !== 404 && r.status !== 405 && r.status !== 400) continue
    } catch { /* try next */ }
  }
  if (!cipherBuf) throw new Error('Failed to download encrypted attachment')

  // Verify SHA-256 over ciphertext when the sender included a hash.
  const expectedHash = file.hashes?.sha256
  if (expectedHash) {
    const digest = await crypto.subtle.digest('SHA-256', cipherBuf)
    const actual = bytesToBase64Unpadded(new Uint8Array(digest))
    const normExpected = expectedHash.replace(/=+$/, '').replace(/-/g, '+').replace(/_/g, '/')
    if (actual !== normExpected) throw new Error('Attachment hash mismatch — ciphertext tampered?')
  }

  // AES-CTR with a 64-bit counter (per Matrix spec the full IV has a 64-bit
  // prefix; WebCrypto accepts the full 16-byte IV and derives the counter).
  const keyBytes = base64UrlToBytes(file.key.k)
  const iv = base64ToBytes(file.iv)
  const keyBuffer = keyBytes.buffer.slice(keyBytes.byteOffset, keyBytes.byteOffset + keyBytes.byteLength) as ArrayBuffer
  const ivBuffer = iv.buffer.slice(iv.byteOffset, iv.byteOffset + iv.byteLength) as ArrayBuffer
  const cryptoKey = await crypto.subtle.importKey('raw', keyBuffer, { name: 'AES-CTR' }, false, ['decrypt'])
  const plain = await crypto.subtle.decrypt({ name: 'AES-CTR', counter: ivBuffer, length: 64 }, cryptoKey, cipherBuf)
  return new Blob([plain])
}

function MessageImage({ mxcUrl, alt, client, mimetype, forceDownload, clickable = true, encryptedFile }: { mxcUrl: string; alt: string; client: any; mimetype?: string; forceDownload?: boolean; clickable?: boolean; encryptedFile?: EncryptedFileInfo }) {
  const [src, setSrc] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)
  const { open: openLightbox } = useImageViewer()

  useEffect(() => {
    if (!mxcUrl || !client) { setFailed(true); return }
    let cancelled = false

    // Encrypted attachment: download ciphertext, decrypt, present as blob URL.
    if (encryptedFile) {
      fetchAndDecryptAttachment(encryptedFile, client)
        .then(blob => {
          if (cancelled) return
          const typed = mimetype ? new Blob([blob], { type: mimetype }) : blob
          setSrc(URL.createObjectURL(typed))
        })
        .catch(() => { if (!cancelled) setFailed(true) })
      return () => { cancelled = true }
    }

    const token = localStorage.getItem('mx_access_token')
    // Animated images must use the download endpoint (no resize params) —
    // the thumbnail endpoint strips animation and returns a static frame.
    const isAnimated =
      forceDownload ||
      mimetype === 'image/gif' ||
      mimetype === 'image/webp' ||
      mimetype === 'image/apng' ||
      (!mimetype && alt.toLowerCase().endsWith('.gif'))

    // Build primary URL (authenticated media, Matrix 1.11+) and legacy fallback
    let primaryUrl: string | null
    let legacyUrl: string | null
    if (isAnimated) {
      primaryUrl = token
        ? (client.mxcUrlToHttp(mxcUrl, undefined, undefined, undefined, false, undefined, true) ?? null)
        : (client.mxcUrlToHttp(mxcUrl) ?? null)
      legacyUrl = client.mxcUrlToHttp(mxcUrl) ?? null
    } else {
      primaryUrl = token
        ? (client.mxcUrlToHttp(mxcUrl, 400, 300, 'scale', false, undefined, true) ?? null)
        : (client.mxcUrlToHttp(mxcUrl, 400, 300, 'scale') ?? null)
      legacyUrl = client.mxcUrlToHttp(mxcUrl, 400, 300, 'scale') ?? null
    }
    if (!primaryUrl) { setFailed(true); return }

    async function tryFetch() {
      // Try primary URL (authenticated media)
      try {
        const r = await fetch(primaryUrl!, token ? { headers: { Authorization: `Bearer ${token}` } } : undefined)
        if (r.ok) {
          const blob = await r.blob()
          if (!cancelled) setSrc(URL.createObjectURL(blob))
          return
        }
        // If server returns 404/405 it likely doesn't support authenticated media — fall through
        if (r.status !== 404 && r.status !== 405 && r.status !== 400) {
          if (!cancelled) setFailed(true)
          return
        }
      } catch {
        // Network error on primary — try legacy
      }

      // Fall back to legacy unauthenticated media URL
      if (!legacyUrl || legacyUrl === primaryUrl) { if (!cancelled) setFailed(true); return }
      try {
        const r2 = await fetch(legacyUrl!)
        if (r2.ok) {
          const blob = await r2.blob()
          if (!cancelled) setSrc(URL.createObjectURL(blob))
        } else {
          if (!cancelled) setFailed(true)
        }
      } catch {
        if (!cancelled) setFailed(true)
      }
    }

    tryFetch()
    return () => { cancelled = true }
  }, [mxcUrl, client, mimetype, forceDownload, alt, encryptedFile])

  if (failed) return <div className="message-body">[image]</div>
  if (!src) return <div className="message-body message-img-loading" />
  if (!clickable) {
    return <div className="message-body"><img src={src} alt={alt} /></div>
  }
  return (
    <div className="message-body">
      <img
        src={src}
        alt={alt}
        className="message-img-clickable"
        onClick={() => openLightbox({ mxcUrl, alt, placeholderSrc: src })}
      />
    </div>
  )
}

// ---- Emote-aware markdown rendering ----

/**
 * Walk the children produced by ReactMarkdown and replace `:shortcode:` tokens
 * inside string nodes with <img> tags for any custom emote registered in the
 * current room. Element children (e.g. <strong>, <em>) are preserved; the
 * substitution runs recursively so emotes inside bold/italic work too.
 */
function substituteEmotes(
  children: React.ReactNode,
  emoteMap: Record<string, RoomEmote>,
  client: any,
): React.ReactNode {
  if (Object.keys(emoteMap).length === 0) return children
  return React.Children.map(children, (child) => {
    if (typeof child === 'string') {
      return renderEmoteString(child, emoteMap, client)
    }
    return child
  })
}

/** Build ReactMarkdown `components` overrides that substitute emotes in text-bearing elements. */
function emoteMarkdownComponents(emoteMap: Record<string, RoomEmote>, client: any) {
  if (Object.keys(emoteMap).length === 0) return undefined
  const sub = (children: React.ReactNode) => substituteEmotes(children, emoteMap, client)
  return {
    p: ({ children }: any) => <p>{sub(children)}</p>,
    strong: ({ children }: any) => <strong>{sub(children)}</strong>,
    em: ({ children }: any) => <em>{sub(children)}</em>,
    del: ({ children }: any) => <del>{sub(children)}</del>,
    li: ({ children }: any) => <li>{sub(children)}</li>,
    blockquote: ({ children }: any) => <blockquote>{sub(children)}</blockquote>,
  } as Record<string, any>
}

// ---- Link preview ----

const URL_RE_ALL = /https?:\/\/[^\s<>"{}|\\^`\[\]]+/g
const IMAGE_EXT_RE = /\.(jpg|jpeg|png|gif|webp|avif|bmp|svg)(\?|#|$)/i

const MAX_PREVIEWS_PER_MESSAGE = 3

/** Extract up to N preview-eligible URLs from message text — skipping URLs inside fenced/inline code. */
function extractPreviewUrls(body: string, max = MAX_PREVIEWS_PER_MESSAGE): string[] {
  const stripped = body
    .replace(/```[\s\S]*?```/g, '')
    .replace(/`[^`\n]*`/g, '')
  const matches = stripped.match(URL_RE_ALL) ?? []
  const out: string[] = []
  const seen = new Set<string>()
  for (const raw of matches) {
    const u = raw.replace(/[.,;:!?)\]]+$/, '')
    if (!u || seen.has(u)) continue
    seen.add(u)
    out.push(u)
    if (out.length >= max) break
  }
  return out
}

function dismissKey(eventId: string, url: string): string {
  return `vc_preview_dismissed:${eventId}|${url}`
}

// The homeserver's URL preview returns OpenGraph metadata verbatim, so og:url
// may contain a javascript:/data: URL that would execute on click. Only accept
// http(s) and fall back to the already-validated source URL otherwise.
function safeHttpUrl(raw: string | undefined, fallback: string): string {
  if (!raw) return fallback
  try {
    const u = new URL(raw, fallback)
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.toString() : fallback
  } catch {
    return fallback
  }
}

function LinkPreview({ url, client, ts, eventId }: { url: string; client: any; ts: number; eventId: string }) {
  const isDirectImage = IMAGE_EXT_RE.test(url)
  const [preview, setPreview] = useState<any>(null)
  const [loading, setLoading] = useState(!isDirectImage)
  const [dismissed, setDismissed] = useState<boolean>(() => {
    try { return localStorage.getItem(dismissKey(eventId, url)) === '1' } catch { return false }
  })

  useEffect(() => {
    if (isDirectImage) return
    if (!client) { setLoading(false); return }
    if (localStorage.getItem('vc_url_previews') === 'false') { setLoading(false); return }
    let cancelled = false
    client.getUrlPreview(url, ts).then((data: any) => {
      if (cancelled) return
      setPreview(data ?? null)
      setLoading(false)
    }).catch(() => {
      if (!cancelled) setLoading(false)
    })
    return () => { cancelled = true }
  }, [url, client, ts, isDirectImage])

  if (dismissed) return null

  function handleDismiss(e: React.MouseEvent) {
    e.preventDefault()
    e.stopPropagation()
    try { localStorage.setItem(dismissKey(eventId, url), '1') } catch { /* ignore */ }
    setDismissed(true)
  }

  // Direct image: render the image card without OG metadata.
  if (isDirectImage) {
    return (
      <a
        className="link-preview link-preview--image"
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        onClick={e => e.stopPropagation()}
      >
        <img className="link-preview-img" src={url} alt="" loading="lazy" />
        <button className="link-preview-dismiss" onClick={handleDismiss} title="Dismiss preview" type="button" aria-label="Dismiss preview">×</button>
      </a>
    )
  }

  if (loading) {
    return (
      <div className="link-preview link-preview--skeleton" aria-hidden="true">
        <div className="link-preview-img link-preview-skeleton-img" />
        <div className="link-preview-text">
          <div className="link-preview-skeleton-line link-preview-skeleton-line--short" />
          <div className="link-preview-skeleton-line" />
          <div className="link-preview-skeleton-line link-preview-skeleton-line--medium" />
        </div>
      </div>
    )
  }

  if (!preview) return null

  const title = preview['og:title'] as string | undefined
  const description = preview['og:description'] as string | undefined
  const imageUrl = preview['og:image'] as string | undefined
  const siteName = preview['og:site_name'] as string | undefined
  const linkUrl = safeHttpUrl(preview['og:url'] as string | undefined, url)

  if (!title && !description && !imageUrl) return null

  return (
    <a
      className="link-preview"
      href={linkUrl}
      target="_blank"
      rel="noopener noreferrer"
      onClick={e => e.stopPropagation()}
    >
      {imageUrl && (
        imageUrl.startsWith('mxc://')
          ? <div className="link-preview-img"><MessageImage mxcUrl={imageUrl} alt={title || ''} client={client} clickable={false} /></div>
          : <img className="link-preview-img" src={imageUrl} alt={title || ''} loading="lazy" />
      )}
      <div className="link-preview-text">
        {siteName && <div className="link-preview-site">{siteName}</div>}
        {title && <div className="link-preview-title">{title}</div>}
        {description && <div className="link-preview-desc">{description}</div>}
      </div>
      <button className="link-preview-dismiss" onClick={handleDismiss} title="Dismiss preview" type="button" aria-label="Dismiss preview">×</button>
    </a>
  )
}

// ---- System event row ----

function SystemEventRow({ event }: { event: MatrixEvent }) {
  const content = event.getContent()
  const prevContent = event.getPrevContent() as Record<string, unknown>
  const sender = event.getSender() ?? ''
  const senderShort = sender.replace(/^@/, '').split(':')[0]
  const stateKey = event.getStateKey() ?? ''
  const targetShort = stateKey.replace(/^@/, '').split(':')[0]
  const type = event.getType()

  let text = ''

  if (type === 'm.room.member') {
    const membership = content.membership as string
    const prevMembership = prevContent?.membership as string | undefined
    if (membership === 'join' && prevMembership !== 'join') {
      text = `${targetShort} joined the room`
    } else if (membership === 'join' && prevMembership === 'join') {
      const nameChanged = content.displayname !== prevContent?.displayname
      const avatarChanged = content.avatar_url !== prevContent?.avatar_url
      if (nameChanged) {
        const oldName = (prevContent?.displayname as string) || targetShort
        const newName = (content.displayname as string) || targetShort
        text = `${oldName} changed their display name to ${newName}`
      } else if (avatarChanged) {
        text = `${targetShort} changed their profile picture`
      } else {
        return null
      }
    } else if (membership === 'leave') {
      if (sender === stateKey) {
        text = `${targetShort} left the room`
      } else {
        const reason = content.reason as string | undefined
        text = `${targetShort} was kicked by ${senderShort}${reason ? `: ${reason}` : ''}`
      }
    } else if (membership === 'ban') {
      const reason = content.reason as string | undefined
      text = `${targetShort} was banned by ${senderShort}${reason ? `: ${reason}` : ''}`
    } else if (membership === 'invite') {
      text = `${senderShort} invited ${targetShort}`
    } else {
      return null
    }
  } else if (type === 'm.room.name') {
    const name = content.name as string | undefined
    text = name ? `${senderShort} changed the room name to "${name}"` : `${senderShort} removed the room name`
  } else if (type === 'm.room.topic') {
    const topic = content.topic as string | undefined
    text = topic ? `${senderShort} changed the topic to "${topic}"` : `${senderShort} removed the topic`
  } else if (type === 'm.room.avatar') {
    text = `${senderShort} changed the room icon`
  } else {
    return null
  }

  if (!text) return null

  return (
    <div className="system-event-row">
      <span className="system-event-icon">ℹ</span>
      <span className="system-event-text">{text}</span>
      <span className="system-event-time">{formatShortTime(event.getTs())}</span>
    </div>
  )
}

// ---- Location message (MSC3488) ----

function parseGeoUri(uri: string | undefined): { lat: number; lon: number; accuracy?: number } | null {
  if (!uri) return null
  // geo:<lat>,<lon>[,<alt>][;u=<accuracy>][;...]
  const match = uri.match(/^geo:(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)(?:,-?\d+(?:\.\d+)?)?(?:;([^?]*))?/i)
  if (!match) return null
  const lat = parseFloat(match[1])
  const lon = parseFloat(match[2])
  if (Number.isNaN(lat) || Number.isNaN(lon)) return null
  const params = match[3] ?? ''
  const u = params.split(';').map(p => p.trim()).find(p => p.startsWith('u='))
  const accuracy = u ? parseFloat(u.slice(2)) : undefined
  return { lat, lon, accuracy: Number.isFinite(accuracy) ? accuracy : undefined }
}

function LocationMessage({ uri, description, fallback }: { uri?: string; description?: string; fallback?: string }) {
  const parsed = parseGeoUri(uri)
  if (!parsed) {
    return <div className="message-body">{fallback ?? 'Location'}</div>
  }
  const { lat, lon, accuracy } = parsed
  const osmUrl = `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lon}#map=16/${lat}/${lon}`
  return (
    <a className="location-card" href={osmUrl} target="_blank" rel="noopener noreferrer">
      <div className="location-card-pin" aria-hidden="true">📍</div>
      <div className="location-card-body">
        {description && <div className="location-card-desc">{description}</div>}
        <div className="location-card-coords">
          {lat.toFixed(5)}, {lon.toFixed(5)}
          {accuracy !== undefined && <span className="location-card-accuracy"> · ±{Math.round(accuracy)} m</span>}
        </div>
        <div className="location-card-open">Open in OpenStreetMap →</div>
      </div>
    </a>
  )
}

// ---- Video message ----

function VideoMessage({ mxcUrl, client, mimetype, width, height, duration, fileName }: {
  mxcUrl?: string
  client: any
  mimetype?: string
  width?: number
  height?: number
  duration?: number
  fileName: string
}) {
  const [src, setSrc] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    if (!mxcUrl) { setFailed(true); return }
    let cancelled = false
    fetchMediaBlobUrl(mxcUrl, client).then(blobUrl => {
      if (cancelled) return
      if (blobUrl) setSrc(blobUrl)
      else setFailed(true)
    })
    return () => { cancelled = true }
  }, [mxcUrl, client, mimetype])

  // Cap the rendered width; compute height from aspect ratio if we know it.
  const displayW = width ? Math.min(400, width) : 400
  const displayH = width && height ? Math.round((displayW / width) * height) : undefined
  const durSec = duration ? Math.round(duration / 1000) : null
  const durLabel = durSec != null ? `${Math.floor(durSec / 60)}:${(durSec % 60).toString().padStart(2, '0')}` : null

  if (failed) return <div className="message-body">[video: {fileName}]</div>
  if (!src) return <div className="message-body video-message video-loading" style={{ width: displayW, height: displayH ?? 225 }}><div className="spinner" /></div>
  return (
    <div className="message-body video-message">
      <video
        controls
        preload="metadata"
        src={src}
        style={{ maxWidth: displayW, maxHeight: 480, width: '100%', height: 'auto' }}
      />
      {durLabel && <span className="video-duration">{durLabel}</span>}
    </div>
  )
}

// ---- Audio / voice message ----

function AudioMessage({ mxcUrl, client, mimetype, isVoice, duration, waveform, fileName }: {
  mxcUrl?: string
  client: any
  mimetype?: string
  isVoice: boolean
  duration?: number
  waveform?: number[]
  fileName: string
}) {
  const [src, setSrc] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    if (!mxcUrl) { setFailed(true); return }
    let cancelled = false
    fetchMediaBlobUrl(mxcUrl, client).then(blobUrl => {
      if (cancelled) return
      if (blobUrl) setSrc(blobUrl)
      else setFailed(true)
    })
    return () => { cancelled = true }
  }, [mxcUrl, client, mimetype])

  const durSec = duration ? Math.round(duration / 1000) : null
  const durLabel = durSec != null ? `${Math.floor(durSec / 60)}:${(durSec % 60).toString().padStart(2, '0')}` : null

  if (failed) return <div className="message-body">[audio: {fileName}]</div>
  if (!src) return <div className="message-body audio-message audio-loading"><span className="spinner" /></div>
  return (
    <div className="message-body audio-message">
      {isVoice && waveform && waveform.length > 0 && (
        <div className="audio-waveform" aria-hidden="true">
          {waveform.slice(0, 64).map((v, i) => (
            <span key={i} style={{ height: `${Math.max(4, Math.min(100, (v / 1024) * 100))}%` }} />
          ))}
        </div>
      )}
      <audio controls src={src} preload="metadata" />
      {durLabel && <span className="audio-duration">{durLabel}</span>}
    </div>
  )
}

// ---- Poll message ----

function pollText(text: any): string {
  if (typeof text === 'string') return text
  if (Array.isArray(text)) {
    const first = text.find(t => t?.body != null)
    return first?.body ?? ''
  }
  return text?.body ?? ''
}

const POLL_START_TYPES = new Set(['m.poll.start', 'org.matrix.msc3381.poll.start'])
const POLL_RESPONSE_TYPES = new Set(['m.poll.response', 'org.matrix.msc3381.poll.response'])
const POLL_END_TYPES = new Set(['m.poll.end', 'org.matrix.msc3381.poll.end'])

function PollMessage({ event, client }: { event: MatrixEvent; client: any }) {
  const { state, sendPollResponse, endPoll } = useMatrix()
  const content = event.getContent() as any
  // Extract the poll.start payload — support stable and unstable keys
  const payload = content['m.poll.start'] ?? content['org.matrix.msc3381.poll.start']
  const pollId = event.getId() ?? ''
  const myUserId = state.userId

  const question = pollText(payload?.question?.['m.text'])
    || payload?.question?.['org.matrix.msc1767.text']
    || payload?.question?.body
    || 'Untitled poll'
  const answers: { id: string; text: string }[] = (payload?.answers ?? []).map((a: any) => ({
    id: a.id,
    text: pollText(a['m.text']) || a['org.matrix.msc1767.text'] || a.body || '',
  }))
  const kind: string = payload?.kind ?? 'm.poll.disclosed'
  // Match both stable (m.poll.disclosed) and unstable (org.matrix.msc3381.poll.disclosed).
  // The simple `includes('disclosed')` works because "undisclosed" contains "disclosed",
  // so we also check for the undisclosed marker explicitly.
  const disclosed = !kind.includes('undisclosed')
  const maxSelections: number = payload?.max_selections ?? 1

  // Scan the room timeline for responses and end events targeting this poll.
  const room = client?.getRoom(event.getRoomId())
  const allEvents: MatrixEvent[] = room?.getLiveTimeline()?.getEvents() ?? []
  const endEvent = allEvents.find(e => {
    if (!POLL_END_TYPES.has(e.getType())) return false
    const rel = e.getContent()['m.relates_to']
    if (rel?.event_id !== pollId) return false
    const sender = e.getSender()
    if (!sender) return false
    // Honour the MSC: only the poll creator or a room redactor may end the poll.
    return sender === event.getSender() || !!room?.currentState.maySendEvent('m.room.redaction', sender)
  }) ?? null

  // Latest response per user (by origin_server_ts).
  const responseByUser = new Map<string, { answers: string[]; ts: number }>()
  for (const e of allEvents) {
    if (!POLL_RESPONSE_TYPES.has(e.getType())) continue
    const rel = e.getContent()['m.relates_to']
    if (rel?.event_id !== pollId) continue
    if (endEvent && e.getTs() > endEvent.getTs()) continue
    const sender = e.getSender()
    if (!sender) continue
    const resp = e.getContent()['m.poll.response'] ?? e.getContent()['org.matrix.msc3381.poll.response']
    const answerIds = (resp?.answers ?? []).filter((id: string) => answers.some(a => a.id === id)).slice(0, maxSelections)
    const prev = responseByUser.get(sender)
    if (!prev || e.getTs() > prev.ts) responseByUser.set(sender, { answers: answerIds, ts: e.getTs() })
  }

  const tallies = new Map<string, number>()
  for (const a of answers) tallies.set(a.id, 0)
  for (const r of responseByUser.values()) {
    for (const id of r.answers) tallies.set(id, (tallies.get(id) ?? 0) + 1)
  }
  const totalVotes = Array.from(tallies.values()).reduce((a, b) => a + b, 0)
  const isEnded = !!endEvent
  const myVotes = myUserId ? responseByUser.get(myUserId)?.answers ?? [] : []
  const showResults = disclosed || isEnded
  const canEnd = event.getSender() === myUserId

  function castVote(answerId: string) {
    if (isEnded) return
    let next: string[]
    if (maxSelections <= 1) {
      next = [answerId]
    } else {
      if (myVotes.includes(answerId)) next = myVotes.filter(id => id !== answerId)
      else if (myVotes.length >= maxSelections) return
      else next = [...myVotes, answerId]
    }
    sendPollResponse(pollId, next).catch(console.error)
  }

  return (
    <div className="message-body poll-card">
      <div className="poll-question">{question}</div>
      {isEnded && <div className="poll-ended-label">Final results</div>}
      <div className="poll-answers">
        {answers.map(a => {
          const votes = tallies.get(a.id) ?? 0
          const pct = totalVotes > 0 ? Math.round((votes / totalVotes) * 100) : 0
          const selected = myVotes.includes(a.id)
          return (
            <button
              key={a.id}
              className={`poll-answer${selected ? ' selected' : ''}${isEnded ? ' ended' : ''}`}
              onClick={() => castVote(a.id)}
              disabled={isEnded}
              type="button"
            >
              {showResults && <span className="poll-answer-bar" style={{ width: `${pct}%` }} />}
              <span className="poll-answer-text">
                <span className="poll-answer-check">{selected ? '●' : '○'}</span>
                {a.text}
              </span>
              {showResults && <span className="poll-answer-count">{votes} · {pct}%</span>}
            </button>
          )
        })}
      </div>
      <div className="poll-footer">
        <span className="poll-total">{totalVotes} vote{totalVotes === 1 ? '' : 's'}</span>
        {!isEnded && canEnd && (
          <button className="poll-end-btn" onClick={() => endPoll(pollId).catch(console.error)} type="button">End poll</button>
        )}
      </div>
    </div>
  )
}

// ---- E2EE lock badge ----

function EncryptionBadge({ event }: { event: MatrixEvent }) {
  if (!event.isEncrypted()) return null
  const failed = event.isDecryptionFailure()
  return (
    <span
      className={`e2ee-lock${failed ? ' e2ee-lock--failed' : ''}`}
      title={failed ? 'Decryption failed' : 'End-to-end encrypted'}
      aria-label={failed ? 'Decryption failed' : 'End-to-end encrypted'}
    >
      <svg viewBox="0 0 24 24" width="11" height="11" fill="currentColor" aria-hidden="true">
        {failed
          ? <path d="M18 8h-1V6A5 5 0 0 0 7.1 4.1L8.5 5.5A3 3 0 0 1 15 6v2H6a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V10a2 2 0 0 0-2-2zm0 12H6V10h12v10zm-6-3a2 2 0 1 0 0-4 2 2 0 0 0 0 4z" />
          : <path d="M18 8h-1V6A5 5 0 0 0 7 6v2H6a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V10a2 2 0 0 0-2-2zm-6 9a2 2 0 1 1 0-4 2 2 0 0 1 0 4zm3.1-9H8.9V6a3.1 3.1 0 0 1 6.2 0v2z" />
        }
      </svg>
    </span>
  )
}

// ---- Message content (with optional reply quote) ----

function MessageContent({ event, client }: { event: MatrixEvent; client: any }) {
  const { state } = useMatrix()
  const emoteMap = useEmoteMap()

  if (event.isRedacted()) {
    return <div className="message-body message-deleted">[message deleted]</div>
  }

  const replacement = event.replacingEvent() as MatrixEvent | null
  const effectiveContent = replacement?.getContent()?.['m.new_content'] ?? event.getContent()
  const isEdited = replacement != null
  const content = effectiveContent
  const msgtype = content.msgtype

  // Reply quote
  const replyToId: string | undefined = event.getContent()['m.relates_to']?.['m.in_reply_to']?.event_id
  const repliedEvent = replyToId
    ? state.messages.find(m => m.getId() === replyToId) ?? null
    : null

  const replyQuote = repliedEvent ? (
    <div className="reply-quote">
      <span className="reply-quote-sender">
        {repliedEvent.getSender()?.replace(/^@/, '').split(':')[0]}
      </span>
      <span className="reply-quote-text">
        {(repliedEvent.getContent().body ?? '').replace(/^(>[^\n]*\n)+\n/, '')}
      </span>
    </div>
  ) : null

  // Sticker events (m.sticker) — always use download endpoint to preserve animation
  const isSticker = event.getType() === 'm.sticker'
  if (isSticker || msgtype === MsgType.Image || msgtype === 'm.image') {
    const encryptedFile = content.file as EncryptedFileInfo | undefined
    const rawUrl = (content.url ?? encryptedFile?.url) as string | undefined
    if (!rawUrl?.startsWith('mxc://') || !client) {
      return <>{replyQuote}<div className="message-body">[image]</div></>
    }
    return (
      <>
        {replyQuote}
        <MessageImage
          mxcUrl={rawUrl}
          alt={content.body || 'image'}
          client={client}
          mimetype={content.info?.mimetype}
          forceDownload={isSticker}
          encryptedFile={encryptedFile}
        />
      </>
    )
  }

  // Poll (stable + MSC3381 unstable event type)
  if (event.getType() === 'm.poll.start' || event.getType() === 'org.matrix.msc3381.poll.start') {
    return <>{replyQuote}<PollMessage event={event} client={client} /></>
  }

  // Video
  if (msgtype === MsgType.Video || msgtype === 'm.video') {
    const rawUrl = (content.url ?? content.file?.url) as string | undefined
    return <>{replyQuote}<VideoMessage mxcUrl={rawUrl} client={client} mimetype={content.info?.mimetype} width={content.info?.w} height={content.info?.h} duration={content.info?.duration} fileName={content.body || 'video'} /></>
  }

  // Location (MSC3488 static location)
  if (msgtype === 'm.location') {
    const msc = content['org.matrix.msc3488.location']
    const uri: string | undefined = msc?.uri ?? content.geo_uri
    const description: string | undefined = msc?.description
    return <>{replyQuote}<LocationMessage uri={uri} description={description} fallback={content.body} /></>
  }

  // Audio / voice message
  if (msgtype === MsgType.Audio || msgtype === 'm.audio') {
    const rawUrl = (content.url ?? content.file?.url) as string | undefined
    const isVoice = content['org.matrix.msc3245.voice'] !== undefined || content['m.voice'] !== undefined
    const duration = content['org.matrix.msc1767.audio']?.duration ?? content.info?.duration
    const waveform = content['org.matrix.msc1767.audio']?.waveform as number[] | undefined
    return <>{replyQuote}<AudioMessage mxcUrl={rawUrl} client={client} mimetype={content.info?.mimetype} isVoice={isVoice} duration={duration} waveform={waveform} fileName={content.body || 'audio'} /></>
  }

  // Strip the Matrix reply fallback lines ("> text\n\n") from the rendered body
  let bodyText: string = content.body ?? ''
  if (replyToId) {
    // Remove the "> quoted lines\n\n" prefix that Matrix adds to reply bodies
    bodyText = bodyText.replace(/^(>[^\n]*\n)*\n/, '')
  }

  const previewUrls = extractPreviewUrls(bodyText)

  // Check formatted_body for Matrix-spec spoiler spans first, then fall back to ||spoiler|| in plain body
  const formattedBody: string | undefined = content.formatted_body
  const format: string | undefined = content.format
  const hasSpoilerSyntax = SPOILER_RE.test(bodyText)
  const formattedSpoilers = (format === 'org.matrix.custom.html' && formattedBody)
    ? renderFormattedSpoilers(formattedBody)
    : null

  const mdComponents = emoteMarkdownComponents(emoteMap, client)

  return (
    <>
      {replyQuote}
      <div className="message-body markdown-body">
        {formattedSpoilers ?? (hasSpoilerSyntax ? renderBodyWithSpoilers(bodyText) : <ReactMarkdown components={mdComponents}>{bodyText}</ReactMarkdown>)}
        {isEdited && <span className="message-edited-label">(edited)</span>}
      </div>
      {previewUrls.map(u => (
        <LinkPreview key={u} url={u} client={client} ts={event.getTs()} eventId={event.getId() ?? ''} />
      ))}
    </>
  )
}

// ---- Reaction picker ----

const QUICK_EMOJIS = ['👍', '❤️', '😂', '😮', '😢', '🎉', '🔥', '👀']

const ALL_EMOJIS: { emoji: string; keywords: string }[] = [
  { emoji: '😀', keywords: 'grinning face happy smile' },
  { emoji: '😁', keywords: 'beaming grin smile happy teeth' },
  { emoji: '😂', keywords: 'laugh cry tears joy funny' },
  { emoji: '🤣', keywords: 'rofl rolling laugh floor' },
  { emoji: '😃', keywords: 'smile happy grin open mouth' },
  { emoji: '😄', keywords: 'smile happy grin eyes' },
  { emoji: '😅', keywords: 'sweat smile nervous relief' },
  { emoji: '😆', keywords: 'laugh grin squinting smile' },
  { emoji: '😉', keywords: 'wink sly fun' },
  { emoji: '😊', keywords: 'smile happy blush pleased' },
  { emoji: '😋', keywords: 'yum delicious tongue taste' },
  { emoji: '😎', keywords: 'cool sunglasses smug' },
  { emoji: '😍', keywords: 'heart eyes love adore' },
  { emoji: '🥰', keywords: 'smiling hearts love affection' },
  { emoji: '😘', keywords: 'kiss blow love' },
  { emoji: '🤩', keywords: 'star struck amazing wow' },
  { emoji: '😏', keywords: 'smirk smug sly' },
  { emoji: '😒', keywords: 'unamused unimpressed boring' },
  { emoji: '😞', keywords: 'sad disappointed down' },
  { emoji: '😔', keywords: 'pensive sad thoughtful' },
  { emoji: '😟', keywords: 'worried concerned sad' },
  { emoji: '😕', keywords: 'confused unsure' },
  { emoji: '🙁', keywords: 'slightly frowning sad' },
  { emoji: '☹️', keywords: 'frowning sad unhappy' },
  { emoji: '😣', keywords: 'persevere anguish struggling' },
  { emoji: '😖', keywords: 'confounded frustrated' },
  { emoji: '😫', keywords: 'tired weary exhausted' },
  { emoji: '😩', keywords: 'weary tired frustrated' },
  { emoji: '🥺', keywords: 'pleading puppy eyes begging' },
  { emoji: '😢', keywords: 'crying sad tear' },
  { emoji: '😭', keywords: 'loudly crying sob tears' },
  { emoji: '😤', keywords: 'steam huffing triumph angry' },
  { emoji: '😠', keywords: 'angry mad upset' },
  { emoji: '😡', keywords: 'pouting angry red mad' },
  { emoji: '🤬', keywords: 'swearing symbols angry cursing' },
  { emoji: '🤯', keywords: 'exploding head mind blown' },
  { emoji: '😳', keywords: 'flushed embarrassed shocked' },
  { emoji: '🥵', keywords: 'hot sweating overheated' },
  { emoji: '🥶', keywords: 'cold frozen freezing' },
  { emoji: '😱', keywords: 'screaming fear shock horror' },
  { emoji: '😨', keywords: 'fearful scared anxious' },
  { emoji: '😰', keywords: 'anxious sweat nervous' },
  { emoji: '😥', keywords: 'relieved sad sweat' },
  { emoji: '😓', keywords: 'downcast sweat disappointed' },
  { emoji: '🤗', keywords: 'hugging hug warm' },
  { emoji: '🤔', keywords: 'thinking ponder hmm' },
  { emoji: '🤭', keywords: 'hand over mouth quiet shh' },
  { emoji: '🤫', keywords: 'shushing quiet secret' },
  { emoji: '🤥', keywords: 'lying pinocchio' },
  { emoji: '😶', keywords: 'no mouth silent speechless' },
  { emoji: '😑', keywords: 'expressionless blank' },
  { emoji: '😬', keywords: 'grimacing cringe awkward' },
  { emoji: '🙄', keywords: 'eye roll whatever eyes' },
  { emoji: '😯', keywords: 'hushed surprised silent' },
  { emoji: '😦', keywords: 'frowning open mouth shocked' },
  { emoji: '😧', keywords: 'anguished shocked upset' },
  { emoji: '😮', keywords: 'open mouth surprised wow' },
  { emoji: '😲', keywords: 'astonished shocked wow surprised' },
  { emoji: '🥱', keywords: 'yawning bored tired' },
  { emoji: '😴', keywords: 'sleeping asleep zzz tired' },
  { emoji: '🤤', keywords: 'drooling hungry craving' },
  { emoji: '😪', keywords: 'sleepy tired droopy' },
  { emoji: '😵', keywords: 'dizzy spinning confused' },
  { emoji: '🤐', keywords: 'zipper mouth quiet secret' },
  { emoji: '🥴', keywords: 'woozy tipsy confused dazed' },
  { emoji: '🤢', keywords: 'nauseated sick green gross' },
  { emoji: '🤮', keywords: 'vomiting sick gross' },
  { emoji: '🤧', keywords: 'sneezing tissue sick cold' },
  { emoji: '🥳', keywords: 'partying celebration hat' },
  { emoji: '🥸', keywords: 'disguised glasses incognito' },
  { emoji: '😷', keywords: 'mask sick medical' },
  { emoji: '🤒', keywords: 'thermometer sick ill' },
  { emoji: '🤕', keywords: 'bandage hurt injury' },
  { emoji: '🤑', keywords: 'money dollar rich greedy' },
  { emoji: '😈', keywords: 'smiling devil evil horns' },
  { emoji: '👿', keywords: 'angry devil evil' },
  { emoji: '💀', keywords: 'skull dead death' },
  { emoji: '☠️', keywords: 'skull crossbones danger poison' },
  { emoji: '💩', keywords: 'poop shit pile smiling' },
  { emoji: '🤡', keywords: 'clown joker' },
  { emoji: '👹', keywords: 'ogre demon monster' },
  { emoji: '👺', keywords: 'goblin demon red mask' },
  { emoji: '👻', keywords: 'ghost spooky boo halloween' },
  { emoji: '👽', keywords: 'alien ufo extraterrestrial' },
  { emoji: '👾', keywords: 'alien monster space invader game' },
  { emoji: '🤖', keywords: 'robot machine ai' },
  { emoji: '🎃', keywords: 'jack o lantern pumpkin halloween' },
  { emoji: '👋', keywords: 'wave hello bye hand' },
  { emoji: '🤚', keywords: 'raised back hand stop' },
  { emoji: '🖐️', keywords: 'hand fingers spread five' },
  { emoji: '✋', keywords: 'raised hand stop high five' },
  { emoji: '🖖', keywords: 'vulcan salute spock star trek' },
  { emoji: '👌', keywords: 'ok pinched perfect' },
  { emoji: '🤌', keywords: 'pinched fingers italian chef kiss' },
  { emoji: '✌️', keywords: 'peace victory two fingers' },
  { emoji: '🤞', keywords: 'fingers crossed luck' },
  { emoji: '🤟', keywords: 'love you sign hand' },
  { emoji: '🤘', keywords: 'horns rock sign metal' },
  { emoji: '🤙', keywords: 'call me shaka hang loose' },
  { emoji: '👈', keywords: 'backhand index pointing left' },
  { emoji: '👉', keywords: 'backhand index pointing right' },
  { emoji: '👆', keywords: 'backhand index pointing up' },
  { emoji: '🖕', keywords: 'middle finger rude offensive' },
  { emoji: '👇', keywords: 'backhand index pointing down' },
  { emoji: '☝️', keywords: 'index pointing up one' },
  { emoji: '👍', keywords: 'thumbs up like approve good' },
  { emoji: '👎', keywords: 'thumbs down dislike disapprove bad' },
  { emoji: '✊', keywords: 'raised fist fight bump' },
  { emoji: '👊', keywords: 'oncoming fist punch hit' },
  { emoji: '🤛', keywords: 'left facing fist bump' },
  { emoji: '🤜', keywords: 'right facing fist bump' },
  { emoji: '👏', keywords: 'clapping hands applause bravo' },
  { emoji: '🙌', keywords: 'raising hands celebration yay' },
  { emoji: '👐', keywords: 'open hands hug' },
  { emoji: '🤲', keywords: 'palms up open' },
  { emoji: '🙏', keywords: 'folded hands pray please namaste' },
  { emoji: '✍️', keywords: 'writing hand pen note' },
  { emoji: '💅', keywords: 'nail polish manicure sassy' },
  { emoji: '🤳', keywords: 'selfie phone camera' },
  { emoji: '💪', keywords: 'flexed bicep muscle strong' },
  { emoji: '🦵', keywords: 'leg kick' },
  { emoji: '🦶', keywords: 'foot kick' },
  { emoji: '👂', keywords: 'ear hear listen' },
  { emoji: '🦻', keywords: 'ear hearing aid' },
  { emoji: '👃', keywords: 'nose smell' },
  { emoji: '🧠', keywords: 'brain smart think' },
  { emoji: '👀', keywords: 'eyes look see stare watching' },
  { emoji: '👁️', keywords: 'eye see look' },
  { emoji: '👅', keywords: 'tongue taste' },
  { emoji: '👄', keywords: 'mouth lips kiss' },
  { emoji: '❤️', keywords: 'heart love red' },
  { emoji: '🧡', keywords: 'orange heart love' },
  { emoji: '💛', keywords: 'yellow heart love' },
  { emoji: '💚', keywords: 'green heart love' },
  { emoji: '💙', keywords: 'blue heart love' },
  { emoji: '💜', keywords: 'purple heart love' },
  { emoji: '🖤', keywords: 'black heart love dark' },
  { emoji: '🤍', keywords: 'white heart love' },
  { emoji: '🤎', keywords: 'brown heart love' },
  { emoji: '💔', keywords: 'broken heart sad love' },
  { emoji: '❣️', keywords: 'heart exclamation love' },
  { emoji: '💕', keywords: 'two hearts love' },
  { emoji: '💞', keywords: 'revolving hearts love' },
  { emoji: '💓', keywords: 'beating heart love pulse' },
  { emoji: '💗', keywords: 'growing heart love pink' },
  { emoji: '💖', keywords: 'sparkling heart love' },
  { emoji: '💘', keywords: 'heart with arrow love cupid' },
  { emoji: '💝', keywords: 'heart with ribbon love gift' },
  { emoji: '💟', keywords: 'heart decoration love' },
  { emoji: '☮️', keywords: 'peace sign' },
  { emoji: '✝️', keywords: 'cross christian religion' },
  { emoji: '☯️', keywords: 'yin yang balance' },
  { emoji: '✡️', keywords: 'star of david jewish' },
  { emoji: '🕉️', keywords: 'om hindu religion' },
  { emoji: '☦️', keywords: 'orthodox cross christian' },
  { emoji: '🔥', keywords: 'fire flame hot burn lit' },
  { emoji: '💥', keywords: 'collision explosion boom' },
  { emoji: '✨', keywords: 'sparkles stars magic' },
  { emoji: '🌟', keywords: 'glowing star shine bright' },
  { emoji: '⭐', keywords: 'star shine gold' },
  { emoji: '💫', keywords: 'dizzy star spin' },
  { emoji: '🎉', keywords: 'party popper celebrate confetti' },
  { emoji: '🎊', keywords: 'confetti ball celebrate party' },
  { emoji: '🎈', keywords: 'balloon party celebrate' },
  { emoji: '🎀', keywords: 'ribbon bow gift' },
  { emoji: '🎁', keywords: 'wrapped gift present' },
  { emoji: '🏆', keywords: 'trophy winner gold first' },
  { emoji: '🥇', keywords: 'gold medal first place winner' },
  { emoji: '🥈', keywords: 'silver medal second place' },
  { emoji: '🥉', keywords: 'bronze medal third place' },
  { emoji: '⚽', keywords: 'soccer football sport' },
  { emoji: '🏀', keywords: 'basketball sport' },
  { emoji: '🏈', keywords: 'american football sport' },
  { emoji: '⚾', keywords: 'baseball sport' },
  { emoji: '🥎', keywords: 'softball sport' },
  { emoji: '🎾', keywords: 'tennis sport ball' },
  { emoji: '🏐', keywords: 'volleyball sport' },
  { emoji: '🎱', keywords: 'billiards pool 8 ball' },
  { emoji: '🏓', keywords: 'ping pong table tennis' },
  { emoji: '🏸', keywords: 'badminton sport shuttlecock' },
  { emoji: '🥊', keywords: 'boxing glove fight' },
  { emoji: '🎮', keywords: 'video game controller play' },
  { emoji: '🕹️', keywords: 'joystick game arcade' },
  { emoji: '🎲', keywords: 'die dice game chance' },
  { emoji: '♟️', keywords: 'chess pawn strategy' },
  { emoji: '🎯', keywords: 'bullseye target dart' },
  { emoji: '🎳', keywords: 'bowling ball pins strike' },
  { emoji: '🎰', keywords: 'slot machine casino jackpot' },
  { emoji: '🍕', keywords: 'pizza food italian slice' },
  { emoji: '🍔', keywords: 'hamburger burger food' },
  { emoji: '🍟', keywords: 'french fries food fast' },
  { emoji: '🌭', keywords: 'hot dog food sausage' },
  { emoji: '🍿', keywords: 'popcorn snack movie' },
  { emoji: '🍦', keywords: 'soft ice cream dessert sweet' },
  { emoji: '🍰', keywords: 'shortcake cake dessert sweet' },
  { emoji: '🎂', keywords: 'birthday cake celebrate' },
  { emoji: '🍩', keywords: 'doughnut donut food sweet' },
  { emoji: '🍪', keywords: 'cookie food biscuit sweet' },
  { emoji: '☕', keywords: 'hot coffee beverage drink' },
  { emoji: '🍵', keywords: 'teacup tea hot drink' },
  { emoji: '🧃', keywords: 'juice beverage drink box' },
  { emoji: '🥤', keywords: 'cup straw beverage drink' },
  { emoji: '🍺', keywords: 'beer mug drink alcohol cheers' },
  { emoji: '🍻', keywords: 'clinking beer mugs cheers toast' },
  { emoji: '🥂', keywords: 'clinking glasses champagne toast' },
  { emoji: '🍾', keywords: 'bottle champagne celebrate cork' },
  { emoji: '🚀', keywords: 'rocket launch space ship fast' },
  { emoji: '🛸', keywords: 'flying saucer ufo alien space' },
  { emoji: '🌈', keywords: 'rainbow color hope' },
  { emoji: '☀️', keywords: 'sun sunny bright warm' },
  { emoji: '🌙', keywords: 'crescent moon night' },
  { emoji: '⭐', keywords: 'star shine bright' },
  { emoji: '🌊', keywords: 'wave water ocean sea surf' },
  { emoji: '🌸', keywords: 'cherry blossom flower pink spring' },
  { emoji: '🌻', keywords: 'sunflower yellow flower bright' },
  { emoji: '🍀', keywords: 'four leaf clover luck lucky' },
  { emoji: '🌴', keywords: 'palm tree tropical beach' },
  { emoji: '🐶', keywords: 'dog puppy pet cute' },
  { emoji: '🐱', keywords: 'cat kitten pet cute' },
  { emoji: '🐭', keywords: 'mouse rodent animal' },
  { emoji: '🐹', keywords: 'hamster pet cute' },
  { emoji: '🐰', keywords: 'rabbit bunny cute' },
  { emoji: '🦊', keywords: 'fox animal cute red' },
  { emoji: '🐻', keywords: 'bear animal cute' },
  { emoji: '🐼', keywords: 'panda bear cute black white' },
  { emoji: '🐻‍❄️', keywords: 'polar bear white ice' },
  { emoji: '🐨', keywords: 'koala bear australia cute' },
  { emoji: '🐯', keywords: 'tiger stripe orange cat' },
  { emoji: '🦁', keywords: 'lion king roar brave' },
  { emoji: '🐮', keywords: 'cow moo animal farm' },
  { emoji: '🐷', keywords: 'pig pink oink farm' },
  { emoji: '🐸', keywords: 'frog green jump pond' },
  { emoji: '🐵', keywords: 'monkey see no evil ape' },
  { emoji: '🙈', keywords: 'see no evil monkey cover eyes' },
  { emoji: '🙉', keywords: 'hear no evil monkey cover ears' },
  { emoji: '🙊', keywords: 'speak no evil monkey cover mouth' },
  { emoji: '🐔', keywords: 'chicken hen bird farm' },
  { emoji: '🐧', keywords: 'penguin bird cold' },
  { emoji: '🐦', keywords: 'bird animal tweet' },
  { emoji: '🦄', keywords: 'unicorn magical rainbow horn horse' },
  { emoji: '🦋', keywords: 'butterfly insect colorful' },
  { emoji: '🐛', keywords: 'bug caterpillar insect' },
  { emoji: '🐝', keywords: 'honeybee bee insect busy' },
  { emoji: '🐞', keywords: 'ladybug beetle red insect' },
  { emoji: '🦀', keywords: 'crab seafood ocean' },
  { emoji: '🦞', keywords: 'lobster seafood red' },
  { emoji: '🐠', keywords: 'tropical fish colorful ocean' },
  { emoji: '🐡', keywords: 'blowfish puffer ocean' },
  { emoji: '🐙', keywords: 'octopus sea tentacles' },
  { emoji: '🦑', keywords: 'squid sea tentacles' },
  { emoji: '💎', keywords: 'gem diamond jewel crystal' },
  { emoji: '💰', keywords: 'money bag rich cash' },
  { emoji: '💸', keywords: 'money flying cash spend' },
  { emoji: '💳', keywords: 'credit card payment' },
  { emoji: '🔑', keywords: 'key lock unlock access' },
  { emoji: '🔒', keywords: 'locked padlock secure' },
  { emoji: '🔓', keywords: 'unlocked padlock open' },
  { emoji: '🔔', keywords: 'bell notification alert' },
  { emoji: '🔕', keywords: 'bell slash mute silent' },
  { emoji: '📢', keywords: 'loudspeaker megaphone announce' },
  { emoji: '📣', keywords: 'megaphone cheer announce' },
  { emoji: '🎵', keywords: 'musical note music sound' },
  { emoji: '🎶', keywords: 'musical notes music song' },
  { emoji: '🎤', keywords: 'microphone mic sing perform' },
  { emoji: '🎧', keywords: 'headphone audio music listen' },
  { emoji: '🎼', keywords: 'musical score sheet music' },
  { emoji: '🎹', keywords: 'musical keyboard piano' },
  { emoji: '🥁', keywords: 'drum percussion music' },
  { emoji: '🎷', keywords: 'saxophone jazz music wind' },
  { emoji: '🎺', keywords: 'trumpet jazz music wind' },
  { emoji: '🎸', keywords: 'guitar rock music string' },
  { emoji: '🎻', keywords: 'violin music string classical' },
  { emoji: '📱', keywords: 'mobile phone cell smartphone' },
  { emoji: '💻', keywords: 'laptop computer work' },
  { emoji: '🖥️', keywords: 'desktop computer screen monitor' },
  { emoji: '⌨️', keywords: 'keyboard type computer' },
  { emoji: '🖱️', keywords: 'computer mouse click' },
  { emoji: '🖨️', keywords: 'printer print paper' },
  { emoji: '📷', keywords: 'camera photo picture' },
  { emoji: '📸', keywords: 'camera flash photo selfie' },
  { emoji: '📹', keywords: 'video camera record film' },
  { emoji: '🎥', keywords: 'movie camera film record' },
  { emoji: '📺', keywords: 'television tv screen watch' },
  { emoji: '📻', keywords: 'radio music broadcast' },
  { emoji: '⏰', keywords: 'alarm clock time wake' },
  { emoji: '⌚', keywords: 'watch time wrist' },
  { emoji: '📡', keywords: 'satellite antenna signal broadcast' },
  { emoji: '🔭', keywords: 'telescope space stars look' },
  { emoji: '🔬', keywords: 'microscope science research' },
  { emoji: '💡', keywords: 'light bulb idea bright' },
  { emoji: '🔦', keywords: 'flashlight torch light' },
  { emoji: '🕯️', keywords: 'candle light flame' },
  { emoji: '🧲', keywords: 'magnet attract pull' },
  { emoji: '🔧', keywords: 'wrench tool fix repair' },
  { emoji: '🔨', keywords: 'hammer tool build' },
  { emoji: '⚙️', keywords: 'gear settings cog' },
  { emoji: '🛠️', keywords: 'hammer wrench tools fix' },
  { emoji: '⚗️', keywords: 'alembic chemistry science' },
  { emoji: '🧪', keywords: 'test tube chemistry science' },
  { emoji: '🧬', keywords: 'dna genetics science helix' },
  { emoji: '💊', keywords: 'pill medicine drug' },
  { emoji: '💉', keywords: 'syringe injection medicine vaccine' },
  { emoji: '🩺', keywords: 'stethoscope doctor medical' },
  { emoji: '🚗', keywords: 'car automobile drive red' },
  { emoji: '🚕', keywords: 'taxi cab yellow car' },
  { emoji: '🚙', keywords: 'suv car automobile' },
  { emoji: '🚌', keywords: 'bus public transport' },
  { emoji: '🚎', keywords: 'trolleybus public transport' },
  { emoji: '🏎️', keywords: 'racing car fast sport' },
  { emoji: '🚓', keywords: 'police car cop law' },
  { emoji: '🚑', keywords: 'ambulance hospital emergency' },
  { emoji: '🚒', keywords: 'fire engine truck' },
  { emoji: '✈️', keywords: 'airplane plane fly travel' },
  { emoji: '🚢', keywords: 'ship boat cruise ocean' },
  { emoji: '🚂', keywords: 'locomotive train steam' },
  { emoji: '🚲', keywords: 'bicycle bike cycle' },
  { emoji: '🛵', keywords: 'motor scooter moped' },
  { emoji: '🏠', keywords: 'house home building' },
  { emoji: '🏡', keywords: 'house garden home' },
  { emoji: '🏢', keywords: 'office building work city' },
  { emoji: '🏥', keywords: 'hospital medical health' },
  { emoji: '🏦', keywords: 'bank money building' },
  { emoji: '🏨', keywords: 'hotel building stay' },
  { emoji: '🏪', keywords: 'convenience store shop' },
  { emoji: '🏫', keywords: 'school building education' },
  { emoji: '⛪', keywords: 'church religion worship' },
  { emoji: '🗼', keywords: 'tokyo tower japan' },
  { emoji: '🗽', keywords: 'statue of liberty usa freedom' },
  { emoji: '🏰', keywords: 'european castle medieval' },
  { emoji: '🌍', keywords: 'globe earth europe africa world' },
  { emoji: '🌎', keywords: 'globe earth americas world' },
  { emoji: '🌏', keywords: 'globe earth asia world' },
  { emoji: '🗺️', keywords: 'world map geography' },
  { emoji: '🧭', keywords: 'compass navigate direction' },
  { emoji: '🌋', keywords: 'volcano eruption lava hot' },
  { emoji: '🗻', keywords: 'mount fuji japan mountain snow' },
  { emoji: '🏔️', keywords: 'mountain snow peak' },
  { emoji: '⛰️', keywords: 'mountain nature hike' },
  { emoji: '🏕️', keywords: 'camping tent outdoors' },
  { emoji: '🏖️', keywords: 'beach umbrella sand sun' },
  { emoji: '🏜️', keywords: 'desert sand hot dry' },
  { emoji: '🏝️', keywords: 'desert island tropical' },
  { emoji: '🎠', keywords: 'carousel merry go round fun' },
  { emoji: '🎡', keywords: 'ferris wheel amusement park' },
  { emoji: '🎢', keywords: 'roller coaster fun ride' },
  { emoji: '🎭', keywords: 'performing arts theater masks' },
  { emoji: '🖼️', keywords: 'framed picture art painting' },
  { emoji: '🎨', keywords: 'artist palette paint art' },
  { emoji: '🎪', keywords: 'circus tent performance' },
  { emoji: '🎬', keywords: 'clapper board movie film' },
  { emoji: '🎤', keywords: 'microphone sing perform' },
  { emoji: '📚', keywords: 'books library read study' },
  { emoji: '📖', keywords: 'open book read study' },
  { emoji: '📝', keywords: 'memo write note pencil' },
  { emoji: '✏️', keywords: 'pencil write draw' },
  { emoji: '🖊️', keywords: 'pen write sign' },
  { emoji: '📌', keywords: 'pushpin pin location' },
  { emoji: '📍', keywords: 'round pushpin location' },
  { emoji: '📎', keywords: 'paperclip attach clip' },
  { emoji: '✂️', keywords: 'scissors cut craft' },
  { emoji: '🗑️', keywords: 'wastebasket trash delete' },
  { emoji: '📦', keywords: 'package box shipping' },
  { emoji: '📬', keywords: 'open mailbox mail letter' },
  { emoji: '📮', keywords: 'postbox mail letter send' },
  { emoji: '📰', keywords: 'newspaper news read' },
  { emoji: '🗞️', keywords: 'rolled up newspaper news' },
  { emoji: '📊', keywords: 'bar chart graph stats' },
  { emoji: '📈', keywords: 'chart increasing growth up' },
  { emoji: '📉', keywords: 'chart decreasing down fall' },
  { emoji: '🔍', keywords: 'magnifying glass search zoom' },
  { emoji: '🔎', keywords: 'magnifying glass right search' },
  { emoji: '💬', keywords: 'speech bubble chat talk message' },
  { emoji: '💭', keywords: 'thought balloon thinking' },
  { emoji: '🗯️', keywords: 'anger symbol speech bubble mad' },
  { emoji: '💤', keywords: 'zzz sleep tired boring' },
  { emoji: '💢', keywords: 'anger symbol mad cross' },
  { emoji: '♻️', keywords: 'recycle eco green environment' },
  { emoji: '✅', keywords: 'check mark button green done' },
  { emoji: '❌', keywords: 'cross mark red no wrong' },
  { emoji: '❓', keywords: 'question mark red what' },
  { emoji: '❗', keywords: 'exclamation mark red important' },
  { emoji: '⚠️', keywords: 'warning caution alert' },
  { emoji: '🔞', keywords: 'no one under eighteen adult' },
  { emoji: '🚫', keywords: 'prohibited no forbidden ban' },
  { emoji: '🆗', keywords: 'ok button okay green' },
  { emoji: '🆕', keywords: 'new button fresh recent' },
  { emoji: '🆙', keywords: 'up button update' },
  { emoji: '🆒', keywords: 'cool button awesome' },
  { emoji: '🆓', keywords: 'free button gratis' },
  { emoji: '🆘', keywords: 'sos help emergency' },
  { emoji: '🔴', keywords: 'red circle dot' },
  { emoji: '🟠', keywords: 'orange circle dot' },
  { emoji: '🟡', keywords: 'yellow circle dot' },
  { emoji: '🟢', keywords: 'green circle dot' },
  { emoji: '🔵', keywords: 'blue circle dot' },
  { emoji: '🟣', keywords: 'purple circle dot' },
  { emoji: '⚫', keywords: 'black circle dot dark' },
  { emoji: '⚪', keywords: 'white circle dot light' },
  { emoji: '🟤', keywords: 'brown circle dot' },
  { emoji: '🔶', keywords: 'orange diamond large' },
  { emoji: '🔷', keywords: 'blue diamond large' },
  { emoji: '🔸', keywords: 'orange diamond small' },
  { emoji: '🔹', keywords: 'blue diamond small' },
  { emoji: '🔺', keywords: 'red triangle up' },
  { emoji: '🔻', keywords: 'red triangle down' },
  { emoji: '💠', keywords: 'diamond blue dot' },
  { emoji: '🔘', keywords: 'radio button grey circle' },
  { emoji: '🔲', keywords: 'black square button' },
  { emoji: '🔳', keywords: 'white square button' },
]

function ReactionPicker({ onPick, onClose }: { onPick: (emoji: string) => void; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  const [search, setSearch] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const emoteMap = useEmoteMap()
  const { client } = useMatrix()

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [onClose])

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  const query = search.trim().toLowerCase()
  // When the search is empty, show the full emoji catalog (grid scrolls).
  // When there's a query, filter by keyword match or exact-emoji paste.
  const filtered = query
    ? ALL_EMOJIS.filter(e => e.keywords.toLowerCase().includes(query) || e.emoji === search.trim())
    : ALL_EMOJIS

  const customEmotes = Object.entries(emoteMap)
  const filteredCustom = query
    ? customEmotes.filter(([code]) => code.toLowerCase().includes(query))
    : customEmotes

  const showQuickRow = !query

  return (
    <div className="reaction-picker reaction-picker-expanded" ref={ref}>
      <div className="reaction-picker-search">
        <input
          ref={inputRef}
          className="reaction-picker-input"
          type="text"
          placeholder="Search emoji…"
          value={search}
          onChange={e => setSearch(e.target.value)}
          onKeyDown={e => { if (e.key === 'Escape') onClose() }}
        />
      </div>

      {filteredCustom.length > 0 && (
        <>
          <div className="reaction-picker-section-label">Room emotes</div>
          <div className="reaction-picker-grid reaction-picker-custom-grid">
            {filteredCustom.map(([shortcode, emote]) => {
              const httpUrl = (client as any)?.mxcUrlToHttp(emote.url, 48, 48, 'scale', false, true)
              return (
                <button
                  key={`c-${shortcode}`}
                  className="reaction-picker-emoji reaction-picker-emoji--custom"
                  onClick={() => { onPick(`:${shortcode}:`); onClose() }}
                  title={`:${shortcode}:`}
                  type="button"
                >
                  {httpUrl
                    ? <img src={httpUrl} alt={shortcode} loading="lazy" />
                    : `:${shortcode}:`}
                </button>
              )
            })}
          </div>
        </>
      )}

      {showQuickRow && (
        <>
          <div className="reaction-picker-section-label">Frequently used</div>
          <div className="reaction-picker-grid reaction-picker-quick-grid">
            {QUICK_EMOJIS.map(e => (
              <button
                key={`q-${e}`}
                className="reaction-picker-emoji"
                onClick={() => { onPick(e); onClose() }}
                title={e}
              >
                {e}
              </button>
            ))}
          </div>
          <div className="reaction-picker-section-label">All emoji</div>
        </>
      )}

      <div className="reaction-picker-grid reaction-picker-grid--scroll">
        {filtered.length === 0 ? (
          <span className="reaction-picker-empty">No results</span>
        ) : (
          filtered.map(item => (
            <button
              key={item.emoji}
              className="reaction-picker-emoji"
              onClick={() => { onPick(item.emoji); onClose() }}
              title={item.keywords.split(' ')[0]}
            >
              {item.emoji}
            </button>
          ))
        )}
      </div>
    </div>
  )
}

// ---- Reaction pills (below message) ----

function ReactionBar({
  eventId,
  onReact,
}: {
  eventId: string
  onReact: (emoji: string) => void
}) {
  const { state, client } = useMatrix()
  const emoteMap = useEmoteMap()
  const groups = state.reactions[eventId] ?? []
  if (groups.length === 0) return null

  return (
    <div className="reaction-bar">
      {groups.map(g => {
        const emote = isCustomEmoteKey(g.key, emoteMap)
        const imgUrl = emote ? (client as any)?.mxcUrlToHttp(emote.url, 32, 32, 'scale', false, true) : null
        return (
          <button
            key={g.key}
            className={`reaction-pill ${g.myReacted ? 'my-reaction' : ''}`}
            onClick={() => onReact(g.key)}
            title={`${g.key} · ${g.count} reaction${g.count !== 1 ? 's' : ''}`}
          >
            {imgUrl
              ? <img className="reaction-pill-img" src={imgUrl} alt={g.key} loading="lazy" />
              : g.key}
            <span className="reaction-count">{g.count}</span>
          </button>
        )
      })}
    </div>
  )
}

// ---- Message context menu ----

interface MsgCtxMenuData {
  x: number
  y: number
  event: MatrixEvent
  isMine: boolean
  canRedact: boolean
  isPinned: boolean
}

function MessageContextMenu({
  data,
  canPin,
  onClose,
  onReply,
  onOpenThread,
  onCopyText,
  onCopyLink,
  onPin,
  onUnpin,
  onEdit,
  onDelete,
  onReact,
  onForward,
}: {
  data: MsgCtxMenuData
  canPin: boolean
  onClose: () => void
  onReply: () => void
  onOpenThread: () => void
  onCopyText: () => void
  onCopyLink: () => void
  onPin: () => void
  onUnpin: () => void
  onEdit: () => void
  onDelete: () => void
  onReact: (emoji: string) => void
  onForward: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [showEmojis, setShowEmojis] = useState(false)

  const menuW = 200
  const menuH = 300
  const ax = Math.min(data.x, window.innerWidth - menuW - 8)
  const ay = Math.min(data.y, window.innerHeight - menuH - 8)

  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') onClose() }
    function onDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    document.addEventListener('keydown', onKey)
    document.addEventListener('mousedown', onDown)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('mousedown', onDown)
    }
  }, [onClose])

  const body = data.event.isRedacted()
    ? ''
    : ((data.event.replacingEvent()?.getContent()?.['m.new_content'] ?? data.event.getContent()).body ?? '')

  return (
    <div ref={ref} className="msg-ctx-menu" style={{ top: ay, left: ax }}>
      <button className="msg-ctx-item" onClick={() => { onReply(); onClose() }}>
        <CtxReplyIcon /> Reply
      </button>
      <button className="msg-ctx-item" onClick={() => { onOpenThread(); onClose() }}>
        <CtxThreadIcon /> Reply in thread
      </button>
      {body && (
        <button className="msg-ctx-item" onClick={() => { onCopyText(); onClose() }}>
          <CtxCopyIcon /> Copy text
        </button>
      )}
      <button className="msg-ctx-item" onClick={() => { onCopyLink(); onClose() }}>
        <CtxLinkIcon /> Copy link
      </button>
      {!data.event.isRedacted() && (
        <button className="msg-ctx-item" onClick={() => { onForward(); onClose() }}>
          <CtxForwardIcon /> Forward
        </button>
      )}
      <button
        className={`msg-ctx-item${showEmojis ? ' active' : ''}`}
        onClick={() => setShowEmojis(v => !v)}
      >
        <CtxSmileIcon /> Add reaction
      </button>
      {showEmojis && (
        <div className="msg-ctx-emojis">
          {QUICK_EMOJIS.map(e => (
            <button key={e} className="msg-ctx-emoji-btn" onClick={() => { onReact(e); onClose() }}>
              {e}
            </button>
          ))}
        </div>
      )}
      {canPin && (
        <button className="msg-ctx-item" onClick={() => { data.isPinned ? onUnpin() : onPin(); onClose() }}>
          <CtxPinIcon /> {data.isPinned ? 'Unpin' : 'Pin message'}
        </button>
      )}
      {(data.isMine || data.canRedact) && <div className="msg-ctx-sep" />}
      {data.isMine && !data.event.isRedacted() && (
        <button className="msg-ctx-item" onClick={() => { onEdit(); onClose() }}>
          <CtxEditIcon /> Edit message
        </button>
      )}
      {(data.isMine || data.canRedact) && (
        <button className="msg-ctx-item msg-ctx-item--danger" onClick={() => {
          if (confirm('Delete this message?')) { onDelete(); onClose() }
        }}>
          <CtxTrashIcon /> Delete message
        </button>
      )}
    </div>
  )
}

// ---- Message action bar (top-right hover overlay) ----

function MessageActions({
  event,
  onReact,
  onReply,
  onOpenThread,
  isMine,
  canRedact,
  onEdit,
  onDelete,
  roomId,
  isPinned,
  canPin,
  onPin,
  onUnpin,
  onForward,
}: {
  event: MatrixEvent
  onReact: (emoji: string) => void
  onReply: () => void
  onOpenThread: () => void
  isMine: boolean
  canRedact: boolean
  onEdit: () => void
  onDelete: () => void
  roomId: string
  isPinned: boolean
  canPin: boolean
  onPin: () => void
  onUnpin: () => void
  onForward: () => void
}) {
  const [pickerOpen, setPickerOpen] = useState(false)
  const [moreOpen, setMoreOpen] = useState(false)
  const [linkCopied, setLinkCopied] = useState(false)
  const moreRef = useRef<HTMLDivElement>(null)

  const copyBody = event.isRedacted()
    ? ''
    : (event.replacingEvent()?.getContent()?.['m.new_content'] ?? event.getContent()).body ?? ''
  const canForward = !event.isRedacted()
  const canEdit = isMine && !event.isRedacted()
  const canDelete = (isMine || canRedact) && !event.isRedacted()

  function handleCopyLink() {
    const eventId = event.getId() ?? ''
    navigator.clipboard.writeText(`https://matrix.to/#/${roomId}/${eventId}`)
    setLinkCopied(true)
    setTimeout(() => setLinkCopied(false), 1500)
  }

  // Close the overflow menu on outside click / Escape.
  useEffect(() => {
    if (!moreOpen) return
    function onDown(e: MouseEvent) {
      if (moreRef.current && !moreRef.current.contains(e.target as Node)) setMoreOpen(false)
    }
    function onKey(e: globalThis.KeyboardEvent) {
      if (e.key === 'Escape') setMoreOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [moreOpen])

  function runAndClose(fn: () => void) {
    return () => { setMoreOpen(false); fn() }
  }

  return (
    <div className="message-actions">
      {/* Primary actions: react, reply, edit (if own). The rest collapse into "…". */}
      <button
        className="message-action-btn"
        onClick={() => setPickerOpen(v => !v)}
        title="Add reaction"
      >
        <ActBtnReactIcon />
      </button>
      <button className="message-action-btn" onClick={onReply} title="Reply">
        <ActBtnReplyIcon />
      </button>
      {canEdit && (
        <button className="message-action-btn" onClick={onEdit} title="Edit">
          <ActBtnEditIcon />
        </button>
      )}

      <div className="message-action-more" ref={moreRef}>
        <button
          className={`message-action-btn${moreOpen ? ' active' : ''}`}
          onClick={() => setMoreOpen(v => !v)}
          title="More actions"
          aria-haspopup="menu"
          aria-expanded={moreOpen}
        >
          <ActBtnMoreIcon />
        </button>
        {moreOpen && (
          <div className="message-action-menu" role="menu">
            <button className="message-action-item" onClick={runAndClose(onOpenThread)} role="menuitem">
              <CtxThreadIcon /> Reply in thread
            </button>
            {canForward && (
              <button className="message-action-item" onClick={runAndClose(onForward)} role="menuitem">
                <CtxForwardIcon /> Forward
              </button>
            )}
            {copyBody && (
              <button
                className="message-action-item"
                onClick={runAndClose(() => navigator.clipboard.writeText(copyBody))}
                role="menuitem"
              >
                <CtxCopyIcon /> Copy text
              </button>
            )}
            <button
              className="message-action-item"
              onClick={runAndClose(handleCopyLink)}
              role="menuitem"
            >
              <CtxLinkIcon /> {linkCopied ? 'Copied!' : 'Copy link'}
            </button>
            {canPin && (
              <button
                className="message-action-item"
                onClick={runAndClose(() => (isPinned ? onUnpin() : onPin()))}
                role="menuitem"
              >
                <CtxPinIcon /> {isPinned ? 'Unpin message' : 'Pin message'}
              </button>
            )}
            {canDelete && <div className="message-action-sep" />}
            {canDelete && (
              <button
                className="message-action-item message-action-item--danger"
                onClick={runAndClose(() => { if (confirm('Delete this message?')) onDelete() })}
                role="menuitem"
              >
                <CtxTrashIcon /> Delete message
              </button>
            )}
          </div>
        )}
      </div>

      {pickerOpen && (
        <ReactionPicker
          onPick={onReact}
          onClose={() => setPickerOpen(false)}
        />
      )}
    </div>
  )
}

// ---- Thread Panel ----

function ThreadPanel({ rootEvent, onClose }: { rootEvent: MatrixEvent; onClose: () => void }) {
  const { state, client, sendThreadMessage } = useMatrix()
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const bottomRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const rootId = rootEvent.getId() ?? ''
  const activeRoom = state.activeRoomId ? client?.getRoom(state.activeRoomId) ?? null : null

  function getDisplayName(userId: string): string {
    const member = activeRoom?.getMember(userId)
    const user = client?.getUser(userId)
    return member?.name || user?.displayName || userId.replace(/^@/, '').split(':')[0]
  }

  // Thread messages: have rel_type 'm.thread' pointing to rootId, or are replies to rootId
  const threadMessages = state.messages.filter(ev => {
    if (ev.getId() === rootId) return false
    const rel = ev.getContent()['m.relates_to']
    if (rel?.rel_type === 'm.thread' && rel.event_id === rootId) return true
    if (!rel?.rel_type && rel?.['m.in_reply_to']?.event_id === rootId) return true
    return false
  })

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [threadMessages.length])

  useEffect(() => {
    if (!sending) textareaRef.current?.focus()
  }, [sending])

  async function handleSend() {
    if (!text.trim() || sending) return
    setSending(true)
    try {
      await sendThreadMessage(text.trim(), rootId)
      setText('')
    } catch (err) {
      console.error('Thread send failed:', err)
    } finally {
      setSending(false)
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend() }
    if (e.key === 'Escape') onClose()
  }

  const rootSenderName = getDisplayName(rootEvent.getSender() ?? '')
  const rootBody = rootEvent.isRedacted()
    ? '[deleted]'
    : (rootEvent.replacingEvent()?.getContent()?.['m.new_content']?.body ?? rootEvent.getContent().body ?? '')

  return (
    <div className="thread-panel">
      <div className="thread-panel-header">
        <span className="thread-panel-title">Thread</span>
        <button className="thread-panel-close" onClick={onClose} title="Close thread">✕</button>
      </div>

      <div className="thread-panel-messages">
        {/* Root message */}
        <div className="thread-root-msg">
          <div className="thread-msg-meta">
            <MxcAvatar
              mxcUrl={activeRoom?.getMember(rootEvent.getSender() ?? '')?.getMxcAvatarUrl() ?? null}
              size={28}
              name={rootSenderName}
            />
            <span className="thread-msg-sender">{rootSenderName}</span>
            <span className="thread-msg-time">{formatShortTime(rootEvent.getTs())}</span>
          </div>
          <div className="thread-msg-body">{rootBody}</div>
        </div>

        <div className="thread-divider">
          <span>{threadMessages.length} {threadMessages.length === 1 ? 'reply' : 'replies'}</span>
        </div>

        {threadMessages.length === 0 ? (
          <div className="thread-empty">No replies yet. Be the first to reply!</div>
        ) : (
          threadMessages.map(ev => {
            const sender = ev.getSender() ?? ''
            const senderName = getDisplayName(sender)
            const avatarMxc = activeRoom?.getMember(sender)?.getMxcAvatarUrl() ?? null
            const body = ev.isRedacted()
              ? '[deleted]'
              : (ev.replacingEvent()?.getContent()?.['m.new_content']?.body ?? ev.getContent().body ?? '')
            return (
              <div key={ev.getId()} className="thread-msg">
                <div className="thread-msg-meta">
                  <MxcAvatar mxcUrl={avatarMxc} size={28} name={senderName} />
                  <span className="thread-msg-sender">{senderName}</span>
                  <span className="thread-msg-time">{formatShortTime(ev.getTs())}</span>
                </div>
                <div className="thread-msg-body">{body}</div>
              </div>
            )
          })
        )}
        <div ref={bottomRef} />
      </div>

      <div className="thread-panel-input">
        <textarea
          ref={textareaRef}
          className="message-input"
          rows={1}
          placeholder="Reply in thread…"
          value={text}
          onChange={e => setText(e.target.value)}
          onKeyDown={handleKeyDown}
          disabled={!state.activeRoomId || sending}
        />
        <button
          className="input-btn"
          onClick={handleSend}
          disabled={!text.trim() || !state.activeRoomId || sending}
          type="button"
          title="Send reply"
        >
          ➤
        </button>
      </div>
    </div>
  )
}

// ---- Main ChatArea ----

export default function ChatArea({
  sidebarOpen = true,
  onToggleSidebar,
  onToggleMembers,
}: {
  sidebarOpen?: boolean
  onToggleSidebar?: () => void
  onToggleMembers?: () => void
}) {
  const { state, client, sendReaction, setReplyTo, loadMoreMessages, redactMessage, sendReadReceipt, clearReadMarker, pinMessage, unpinMessage, sendThreadMessage, placeVoiceCall, placeVideoCall, activeCall, sendFile } = useMatrix()
  const [dragOver, setDragOver] = useState(false)
  // The browser fires dragenter/dragleave for every child element during the drag —
  // a single boolean flicker-flips. Counting enter/leave depth keeps the overlay steady.
  const dragDepthRef = useRef(0)
  const bottomRef = useRef<HTMLDivElement>(null)
  // messageListRef holds the element for use in async/rAF callbacks.
  // listEl (state) triggers effects when the element mounts or unmounts,
  // so the scroll listener is always attached to the current DOM node.
  const messageListRef = useRef<HTMLDivElement | null>(null)
  const [listEl, setListEl] = useState<HTMLDivElement | null>(null)
  const messageListCallback = useCallback((el: HTMLDivElement | null) => {
    messageListRef.current = el
    setListEl(el)
  }, [])
  const [profile, setProfile] = useState<ProfileInfo | null>(null)
  const [isLoadingOlder, setIsLoadingOlder] = useState(false)
  const [editingEvent, setEditingEvent] = useState<MatrixEvent | null>(null)
  const [showSearch, setShowSearch] = useState(false)
  const [showPinned, setShowPinned] = useState(false)
  const [msgCtxMenu, setMsgCtxMenu] = useState<MsgCtxMenuData | null>(null)
  const [forwardEvent, setForwardEvent] = useState<MatrixEvent | null>(null)
  const [threadRootEvent, setThreadRootEvent] = useState<MatrixEvent | null>(null)

  // Scroll behaviour refs (all stable, no re-render needed)
  const isLoadingOlderRef = useRef(false)
  const atBottomRef = useRef(true)
  const [atBottom, setAtBottom] = useState(true)
  const prevRoomIdRef = useRef<string | null>(null)
  const savedScrollDataRef = useRef<{ scrollHeight: number; scrollTop: number } | null>(null)

  const activeRoom = state.activeRoomId
    ? client?.getRoom(state.activeRoomId) ?? null
    : null

  const emoteMap = React.useMemo(() => getRoomEmoteMap(activeRoom), [activeRoom, state.messages.length])

  const roomName = activeRoom?.name ?? 'Unknown'
  const topic = activeRoom?.currentState
    .getStateEvents('m.room.topic', '')
    ?.getContent()?.topic ?? ''

  const ignoredSet = React.useMemo(() => new Set(state.ignoredUserIds), [state.ignoredUserIds])
  const visibleMessages = React.useMemo(() => (
    ignoredSet.size > 0
      ? state.messages.filter(m => !ignoredSet.has(m.getSender() ?? ''))
      : state.messages
  ), [state.messages, ignoredSet])
  const groups = React.useMemo(
    () => groupMessages(visibleMessages, client, activeRoom),
    [visibleMessages, client, activeRoom]
  )

  // Read system events directly from the room timeline
  const SYS_TYPES = ['m.room.member', 'm.room.name', 'm.room.topic', 'm.room.avatar']
  const showMemberJoin = localStorage.getItem('vc_show_member_join') !== 'false'
  const showMemberLeave = localStorage.getItem('vc_show_member_leave') !== 'false'
  const showProfileChange = localStorage.getItem('vc_show_profile_change') !== 'false'
  const showRoomChange = localStorage.getItem('vc_show_room_change') !== 'false'

  const rawSysEvents = activeRoom
    ? activeRoom.getLiveTimeline().getEvents().filter(e => SYS_TYPES.includes(e.getType()))
    : []

  const filteredSysEvents = rawSysEvents.filter(e => {
    const t = e.getType()
    if (t === 'm.room.name' || t === 'm.room.topic' || t === 'm.room.avatar') return showRoomChange
    if (t === 'm.room.member') {
      const m = e.getContent().membership as string
      const prev = (e.getPrevContent() as Record<string, unknown>)?.membership as string | undefined
      if (m === 'join' && prev !== 'join') return showMemberJoin
      if (m === 'join' && prev === 'join') return showProfileChange
      if (m === 'leave' || m === 'ban') return showMemberLeave
      if (m === 'invite') return showMemberJoin
    }
    return false
  })

  // Build a merged, sorted timeline
  type TimelineItem = { kind: 'group'; group: MessageGroup } | { kind: 'system'; event: MatrixEvent }
  const sortedSys = [...filteredSysEvents].sort((a, b) => a.getTs() - b.getTs())
  const timelineItems: TimelineItem[] = []
  let si = 0
  for (const group of groups) {
    const gts = group.events[0].getTs()
    while (si < sortedSys.length && sortedSys[si].getTs() < gts) {
      timelineItems.push({ kind: 'system', event: sortedSys[si] }); si++
    }
    timelineItems.push({ kind: 'group', group })
  }
  while (si < sortedSys.length) { timelineItems.push({ kind: 'system', event: sortedSys[si] }); si++ }

  // Keep a ref to the latest loadMoreMessages so the scroll listener (added once) always
  // calls the current version without needing to be re-attached.
  const loadMoreRef = useRef(loadMoreMessages)
  loadMoreRef.current = loadMoreMessages

  async function handleLoadOlderMessages() {
    const el = messageListRef.current
    if (!el || isLoadingOlderRef.current) return
    isLoadingOlderRef.current = true
    setIsLoadingOlder(true)
    savedScrollDataRef.current = { scrollHeight: el.scrollHeight, scrollTop: el.scrollTop }
    try {
      await loadMoreRef.current()
    } finally {
      isLoadingOlderRef.current = false
      setIsLoadingOlder(false)
    }
  }

  // Scroll listener — re-attached whenever the message list element mounts/unmounts
  useEffect(() => {
    if (!listEl) return
    function onScroll() {
      if (isLoadingOlderRef.current) return
      const nowAtBottom = listEl.scrollHeight - listEl.scrollTop - listEl.clientHeight < 80
      if (nowAtBottom !== atBottomRef.current) {
        setAtBottom(nowAtBottom)
        if (nowAtBottom) sendReceiptRef.current()
      }
      atBottomRef.current = nowAtBottom
      if (listEl.scrollTop < 600) handleLoadOlderMessages()
    }
    listEl.addEventListener('scroll', onScroll, { passive: true })
    return () => listEl.removeEventListener('scroll', onScroll)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [listEl])

  // Restore scroll position after older messages are inserted.
  // useLayoutEffect runs before the browser paints, so the correction happens
  // in the same frame as the new messages — no visible jump.
  useLayoutEffect(() => {
    if (!isLoadingOlder && savedScrollDataRef.current) {
      const el = messageListRef.current
      const saved = savedScrollDataRef.current
      if (el && saved) {
        el.scrollTop = el.scrollHeight - saved.scrollHeight + saved.scrollTop
        savedScrollDataRef.current = null
      }
    }
  }, [isLoadingOlder])

  // Send read receipt for the last message when at bottom
  const sendReceiptForLastMessage = useCallback(() => {
    if (!state.readMarkerEventId && state.messages.length === 0) return
    const lastMsg = state.messages[state.messages.length - 1]
    if (!lastMsg) return
    sendReadReceipt(lastMsg).then(() => clearReadMarker()).catch(() => {/* ignore */})
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.messages, state.readMarkerEventId])

  const sendReceiptRef = useRef(sendReceiptForLastMessage)
  sendReceiptRef.current = sendReceiptForLastMessage

  // Track when the user has manually scrolled away — programmatic scrolls don't count.
  const pinToBottomUntilRef = useRef(0)

  // Scroll to bottom when room changes or new messages arrive (only if already at bottom)
  useEffect(() => {
    const roomChanged = prevRoomIdRef.current !== state.activeRoomId
    prevRoomIdRef.current = state.activeRoomId

    if (isLoadingOlderRef.current) return  // restoration handled by the effect above

    // On room switch always scroll to bottom; on new message only if already at bottom
    if (roomChanged) {
      atBottomRef.current = true
      setAtBottom(true)
      // Force-pin for the next 2.5s to absorb late layout (images, embeds, lazy content).
      pinToBottomUntilRef.current = performance.now() + 2500
    }
    if (!atBottomRef.current) return

    const el = messageListRef.current
    if (!el) return

    requestAnimationFrame(() => {
      const node = messageListRef.current
      if (!node) return
      node.scrollTop = node.scrollHeight
      bottomRef.current?.scrollIntoView({ block: 'end' })
      atBottomRef.current = true
      sendReceiptRef.current()

      // Retry on each frame for a short window — absorbs late layout from images,
      // embeds, etc. Bail immediately if the user has scrolled away.
      const tick = () => {
        if (performance.now() > pinToBottomUntilRef.current) return
        if (!atBottomRef.current) return
        const n = messageListRef.current
        if (!n) return
        if (n.scrollHeight - n.scrollTop - n.clientHeight > 2) {
          n.scrollTop = n.scrollHeight
          bottomRef.current?.scrollIntoView({ block: 'end' })
        }
        requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
    })
  }, [state.activeRoomId, state.messages.length])

  // Keep the list pinned to the bottom as content resizes (images/embeds loading
  // after room switch grow scrollHeight — without this the user ends up stranded
  // above the newest message).
  useEffect(() => {
    if (!listEl) return
    const snapIfPinned = () => {
      if (!atBottomRef.current || isLoadingOlderRef.current) return
      listEl.scrollTop = listEl.scrollHeight
    }
    const ro = new ResizeObserver(snapIfPinned)
    for (const child of Array.from(listEl.children)) ro.observe(child as Element)
    const mo = new MutationObserver(records => {
      for (const r of records) {
        for (const node of Array.from(r.addedNodes)) {
          if (node.nodeType === 1) ro.observe(node as Element)
        }
      }
      snapIfPinned()
    })
    mo.observe(listEl, { childList: true, subtree: true })

    // img/video/iframe `load` events bubble when captured — this catches layout
    // shifts the ResizeObserver might miss (e.g. images with explicit width/height
    // placeholders that don't change the element's bounding box).
    const onMediaLoad = (e: Event) => {
      const t = e.target as HTMLElement | null
      if (!t) return
      const tag = t.tagName
      if (tag === 'IMG' || tag === 'VIDEO' || tag === 'IFRAME') snapIfPinned()
    }
    listEl.addEventListener('load', onMediaLoad, { capture: true })

    return () => {
      ro.disconnect()
      mo.disconnect()
      listEl.removeEventListener('load', onMediaLoad, { capture: true } as any)
    }
  }, [listEl])

  useEffect(() => { setEditingEvent(null); setShowSearch(false); setShowPinned(false); setMsgCtxMenu(null); setThreadRootEvent(null); setForwardEvent(null) }, [state.activeRoomId])

  function openMsgCtxMenu(e: React.MouseEvent, event: MatrixEvent) {
    e.preventDefault()
    setMsgCtxMenu({
      x: e.clientX,
      y: e.clientY,
      event,
      isMine: event.getSender() === state.userId,
      canRedact: canUserRedact(event),
      isPinned: pinnedEventIds.has(event.getId() ?? ''),
    })
  }

  function canUserRedact(event: MatrixEvent): boolean {
    const room = activeRoom
    if (!room) return false
    const sender = event.getSender()
    if (sender === state.userId) return true
    const myMember = room.getMember(state.userId ?? '')
    const pl = room.currentState.getStateEvents('m.room.power_levels', '')?.getContent() as any
    const redactPl: number = pl?.redact ?? 50
    return (myMember?.powerLevel ?? 0) >= redactPl
  }

  function getDisplayName(userId: string): string {
    return activeRoom?.getMember(userId)?.name || userId.replace(/^@/, '').split(':')[0]
  }

  function openProfile(userId: string, senderName: string, avatarMxc: string | null, e: React.MouseEvent) {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
    setProfile({ userId, displayName: senderName, avatarMxc, anchorRect: rect, roomId: state.activeRoomId ?? undefined, myUserId: state.userId ?? undefined })
  }

  const userCanPin = (() => {
    if (!activeRoom) return false
    const myMember = activeRoom.getMember(state.userId ?? '')
    const pl = activeRoom.currentState.getStateEvents('m.room.power_levels', '')?.getContent() as any
    const pinPl: number = pl?.state_events?.['m.room.pinned_events'] ?? pl?.state_default ?? 50
    return (myMember?.powerLevel ?? 0) >= pinPl
  })()

  const pinnedEventIds = new Set(
    (activeRoom?.currentState.getStateEvents('m.room.pinned_events', '')?.getContent()?.pinned ?? []) as string[]
  )

  if (state.syncState === null && state.isLoggedIn) {
    return (
      <div className="chat-area">
        <div className="loading-state">
          <div className="spinner" />
          <p>Connecting…</p>
        </div>
      </div>
    )
  }

  async function handleDroppedFiles(files: FileList | File[]) {
    if (!state.activeRoomId) return
    const list = Array.from(files)
    for (const f of list) {
      try { await sendFile(f) }
      catch (err) { console.error('Drop upload failed:', err) }
    }
  }

  function onDragEnter(e: React.DragEvent) {
    if (!state.activeRoomId) return
    if (!e.dataTransfer || !Array.from(e.dataTransfer.types).includes('Files')) return
    e.preventDefault()
    dragDepthRef.current += 1
    if (dragDepthRef.current === 1) setDragOver(true)
  }
  function onDragOver(e: React.DragEvent) {
    if (!state.activeRoomId) return
    if (!e.dataTransfer || !Array.from(e.dataTransfer.types).includes('Files')) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
  }
  function onDragLeave(e: React.DragEvent) {
    if (!state.activeRoomId) return
    e.preventDefault()
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1)
    if (dragDepthRef.current === 0) setDragOver(false)
  }
  function onDrop(e: React.DragEvent) {
    if (!state.activeRoomId) return
    e.preventDefault()
    dragDepthRef.current = 0
    setDragOver(false)
    const files = e.dataTransfer?.files
    if (files && files.length > 0) handleDroppedFiles(files)
  }

  return (
    <EmoteMapContext.Provider value={emoteMap}>
    <div
      className="chat-area"
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      {dragOver && state.activeRoomId && (
        <div className="drop-overlay" aria-hidden="true">
          <div className="drop-overlay-inner">
            <div className="drop-overlay-icon">
              <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                <polyline points="17 8 12 3 7 8" />
                <line x1="12" y1="3" x2="12" y2="15" />
              </svg>
            </div>
            <div className="drop-overlay-title">Drop files to upload</div>
            <div className="drop-overlay-sub">They'll be sent to #{roomName}</div>
          </div>
        </div>
      )}
      <div className="chat-main">
      {/* Header */}
      <div className="chat-header">
        <button
          className="sidebar-toggle-btn"
          onClick={onToggleSidebar}
          title={sidebarOpen ? 'Hide channel list' : 'Show channel list'}
          aria-label={sidebarOpen ? 'Hide channel list' : 'Show channel list'}
          aria-pressed={sidebarOpen}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <rect x="3" y="4" width="18" height="16" rx="2" />
            <line x1="9" y1="4" x2="9" y2="20" />
            {sidebarOpen ? (
              <polyline points="7 10 5 12 7 14" />
            ) : (
              <polyline points="5 10 7 12 5 14" />
            )}
          </svg>
        </button>
        {activeRoom ? (
          <>
            {isVoiceChannel(activeRoom) ? (
              <span className="channel-hash channel-hash--voice" title="Voice channel">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                  <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
                  <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
                </svg>
              </span>
            ) : (
              <span className="channel-hash">#</span>
            )}
            <h3>{roomName}</h3>
            {topic && <span className="topic">{topic}</span>}
            <button
              type="button"
              className="header-member-count"
              onClick={onToggleMembers}
              title="Show members"
              aria-label="Show members"
            >
              <MembersIcon />
              {activeRoom.getJoinedMembers().length}
            </button>
            {activeRoom.currentState.getStateEvents('m.room.encryption', '') && (
              <span className="header-e2ee-badge" title="End-to-end encrypted">
                <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true">
                  <path d="M18 8h-1V6A5 5 0 0 0 7 6v2H6a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V10a2 2 0 0 0-2-2zm-6 9a2 2 0 1 1 0-4 2 2 0 0 1 0 4zm3.1-9H8.9V6a3.1 3.1 0 0 1 6.2 0v2z" />
                </svg>
              </span>
            )}
          </>
        ) : (
          <h3 style={{ color: 'var(--text-muted)' }}>Select a room</h3>
        )}
        <div className="chat-header-spacer" />
        {activeRoom && (
          <>
            <button
              className="icon-btn"
              onClick={() => placeVoiceCall(activeRoom.roomId)}
              title="Start voice call"
              disabled={!!activeCall}
            >
              <CallIcon />
            </button>
            <button
              className="icon-btn"
              onClick={() => placeVideoCall(activeRoom.roomId)}
              title="Start video call"
              disabled={!!activeCall}
            >
              <VideoCallIcon />
            </button>
            <button className="icon-btn" onClick={() => setShowPinned(true)} title="Pinned messages">
              <PinIcon />
            </button>
            <button className="icon-btn" onClick={() => setShowSearch(true)} title="Search messages">
              <SearchIcon />
            </button>
          </>
        )}
      </div>

      {/* Messages */}
      <div className="message-list" ref={messageListCallback}>
        {!activeRoom ? (
          <div className="empty-state">
            <span className="empty-icon">💬</span>
            <p>Select a room from the sidebar to start chatting</p>
          </div>
        ) : (
          <>
            {isLoadingOlder && (
              <div className="load-older-indicator">
                <div className="spinner" />
              </div>
            )}

            <div className="chat-welcome">
              <div className="welcome-icon">#</div>
              <h2>Welcome to #{roomName}!</h2>
              {topic && <p>{topic}</p>}
            </div>

            {groups.length === 0 && (
              <div className="empty-state" style={{ flex: 'none', padding: '32px' }}>
                <p style={{ color: 'var(--text-muted)' }}>No messages yet. Say hello!</p>
              </div>
            )}

            {(() => {
              let prevDateLabel = ''
              const readMarkerId = state.readMarkerEventId
              let newMessagesDividerShown = false
              return timelineItems.map((item, idx) => {
                const ts = item.kind === 'group' ? item.group.events[0].getTs() : item.event.getTs()
                const dateLabel = formatDateLabel(ts)
                const showDate = dateLabel !== prevDateLabel
                prevDateLabel = dateLabel
                const key = item.kind === 'group' ? (item.group.events[0].getId() ?? `g${idx}`) : (item.event.getId() ?? `s${idx}`)

                if (item.kind === 'system') {
                  return (
                    <React.Fragment key={key}>
                      {showDate && <div className="date-separator"><span>{dateLabel}</span></div>}
                      <SystemEventRow event={item.event} />
                    </React.Fragment>
                  )
                }

                const group = item.group

                // Show "NEW MESSAGES" before the first message group after the read marker
                let showNewDivider = false
                if (readMarkerId && !newMessagesDividerShown) {
                  const markerInEarlierGroup = timelineItems.slice(0, idx).some(it =>
                    it.kind === 'group' && it.group.events.some(e => e.getId() === readMarkerId)
                  )
                  if (markerInEarlierGroup) {
                    showNewDivider = true
                    newMessagesDividerShown = true
                  } else if (!timelineItems.slice(0, idx).some(it => it.kind === 'group')) {
                    const markerAnywhere = timelineItems.some(it => it.kind === 'group' && it.group.events.some(e => e.getId() === readMarkerId))
                    if (!markerAnywhere) { showNewDivider = true; newMessagesDividerShown = true }
                  }
                }

                return (
              <React.Fragment key={key}>
                {showDate && <div className="date-separator"><span>{dateLabel}</span></div>}
                {showNewDivider && <div className="new-messages-divider"><span>New Messages</span></div>}
              <div>
                {/* First message in group */}
                <div className={`message-group${group.sender === state.userId ? ' message-mine' : ''}`} onContextMenu={e => openMsgCtxMenu(e, group.events[0])}>
                  <div
                    className="message-avatar"
                    onClick={e => openProfile(group.sender, group.senderName, group.avatarMxc, e)}
                    style={{ cursor: 'pointer' }}
                  >
                    <MxcAvatar mxcUrl={group.avatarMxc} size={40} name={group.senderName} />
                  </div>
                  <div className="message-header">
                    <span
                      className="message-author"
                      onClick={e => openProfile(group.sender, group.senderName, group.avatarMxc, e)}
                      style={{ cursor: 'pointer' }}
                    >
                      {group.senderName}
                    </span>
                    <span className="message-timestamp">
                      {formatTime(group.events[0].getTs())}
                    </span>
                  </div>
                  <MessageContent event={group.events[0]} client={client} />
                  <ReactionBar
                    eventId={group.events[0].getId() ?? ''}
                    onReact={emoji => sendReaction(group.events[0].getId() ?? '', emoji)}
                  />
                  <MessageActions
                    event={group.events[0]}
                    onReact={emoji => sendReaction(group.events[0].getId() ?? '', emoji)}
                    onReply={() => setReplyTo(group.events[0])}
                    onOpenThread={() => setThreadRootEvent(group.events[0])}
                    isMine={group.sender === state.userId}
                    canRedact={canUserRedact(group.events[0])}
                    onEdit={() => setEditingEvent(group.events[0])}
                    onDelete={() => redactMessage(state.activeRoomId!, group.events[0].getId() ?? '')}
                    roomId={state.activeRoomId!}
                    isPinned={pinnedEventIds.has(group.events[0].getId() ?? '')}
                    canPin={userCanPin}
                    onPin={() => pinMessage(state.activeRoomId!, group.events[0].getId() ?? '')}
                    onUnpin={() => unpinMessage(state.activeRoomId!, group.events[0].getId() ?? '')}
                    onForward={() => setForwardEvent(group.events[0])}
                  />
                </div>

                {/* Continuation messages */}
                {group.events.slice(1).map(event => (
                  <div
                    key={event.getId()}
                    className={`message-continuation${group.sender === state.userId ? ' message-mine' : ''}`}
                    style={{ position: 'relative', paddingLeft: '72px', paddingRight: '48px' }}
                    onContextMenu={e => openMsgCtxMenu(e, event)}
                  >
                    <span className="continuation-time">
                      {formatShortTime(event.getTs())}
                    </span>
                    <MessageContent event={event} client={client} />
                    <ReactionBar
                      eventId={event.getId() ?? ''}
                      onReact={emoji => sendReaction(event.getId() ?? '', emoji)}
                    />
                    <MessageActions
                      event={event}
                      onReact={emoji => sendReaction(event.getId() ?? '', emoji)}
                      onReply={() => setReplyTo(event)}
                      onOpenThread={() => setThreadRootEvent(event)}
                      isMine={event.getSender() === state.userId}
                      canRedact={canUserRedact(event)}
                      onEdit={() => setEditingEvent(event)}
                      onDelete={() => redactMessage(state.activeRoomId!, event.getId() ?? '')}
                      roomId={state.activeRoomId!}
                      isPinned={pinnedEventIds.has(event.getId() ?? '')}
                      canPin={userCanPin}
                      onPin={() => pinMessage(state.activeRoomId!, event.getId() ?? '')}
                      onUnpin={() => unpinMessage(state.activeRoomId!, event.getId() ?? '')}
                      onForward={() => setForwardEvent(event)}
                    />
                  </div>
                ))}
              </div>
              </React.Fragment>
                )
              })
            })()}

            <div ref={bottomRef} />
          </>
        )}
      </div>

      {/* Jump-to-bottom button */}
      {!atBottom && (
        <button
          className="jump-to-bottom"
          onClick={() => {
            const el = messageListRef.current
            if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
            atBottomRef.current = true
            setAtBottom(true)
          }}
          title="Jump to latest messages"
        >
          ↓
        </button>
      )}

      {/* Typing indicator */}
      {(() => {
        const typingIds = state.typingUserIds.filter(id => !ignoredSet.has(id))
        return typingIds.length > 0 && (
          <div className="typing-indicator">
            <span className="typing-dots"><span /><span /><span /></span>
            <span className="typing-text">
              {typingIds.length === 1
                ? `${getDisplayName(typingIds[0])} is typing…`
                : `${typingIds.length} people are typing…`}
            </span>
          </div>
        )
      })()}

      {/* Message input */}
      <MessageInput roomName={roomName} editingEvent={editingEvent} onCancelEdit={() => setEditingEvent(null)} />
      </div>{/* end chat-main */}

      {/* Thread panel */}
      {threadRootEvent && (
        <ThreadPanel rootEvent={threadRootEvent} onClose={() => setThreadRootEvent(null)} />
      )}

      {/* Profile popup */}
      {profile && (
        <ProfilePopup info={profile} onClose={() => setProfile(null)} />
      )}

      {/* Message context menu */}
      {msgCtxMenu && (
        <MessageContextMenu
          data={msgCtxMenu}
          canPin={userCanPin}
          onClose={() => setMsgCtxMenu(null)}
          onReply={() => setReplyTo(msgCtxMenu.event)}
          onOpenThread={() => setThreadRootEvent(msgCtxMenu.event)}
          onCopyText={() => navigator.clipboard.writeText(
            (msgCtxMenu.event.replacingEvent()?.getContent()?.['m.new_content'] ?? msgCtxMenu.event.getContent()).body ?? ''
          )}
          onCopyLink={() => navigator.clipboard.writeText(
            `https://matrix.to/#/${state.activeRoomId}/${msgCtxMenu.event.getId() ?? ''}`
          )}
          onPin={() => pinMessage(state.activeRoomId!, msgCtxMenu.event.getId() ?? '')}
          onUnpin={() => unpinMessage(state.activeRoomId!, msgCtxMenu.event.getId() ?? '')}
          onEdit={() => setEditingEvent(msgCtxMenu.event)}
          onDelete={() => redactMessage(state.activeRoomId!, msgCtxMenu.event.getId() ?? '')}
          onReact={emoji => sendReaction(msgCtxMenu.event.getId() ?? '', emoji)}
          onForward={() => setForwardEvent(msgCtxMenu.event)}
        />
      )}

      {/* Forward message modal */}
      {forwardEvent && (
        <ForwardModal event={forwardEvent} onClose={() => setForwardEvent(null)} />
      )}

      {/* Pinned messages modal */}
      {showPinned && state.activeRoomId && (
        <PinnedMessagesModal roomId={state.activeRoomId} onClose={() => setShowPinned(false)} />
      )}

      {/* Search modal */}
      {showSearch && (
        <SearchModal roomId={state.activeRoomId} onClose={() => setShowSearch(false)} />
      )}
    </div>
    </EmoteMapContext.Provider>
  )
}

function MembersIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
      <path d="M16 3.13a4 4 0 0 1 0 7.75" />
    </svg>
  )
}

function PinIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="12" y1="17" x2="12" y2="22" />
      <path d="M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1v4.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24Z" />
    </svg>
  )
}

function SearchIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="11" cy="11" r="8" />
      <line x1="21" y1="21" x2="16.65" y2="16.65" />
    </svg>
  )
}

function CallIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M15.5 10.5c.5 1.2 1.8 2.5 3 3" />
      <path d="M20.2 15.6a2 2 0 0 1 .8 1.6v2a2 2 0 0 1-2.2 2c-3.3-.3-6.3-1.7-8.7-3.8a14.5 14.5 0 0 1-4.8-7.1 15 15 0 0 1-.5-3.2A2 2 0 0 1 6.7 5h2a2 2 0 0 1 2 1.7 10 10 0 0 0 .7 2.4 2 2 0 0 1-.4 2.1l-.9.9a12 12 0 0 0 4.9 4.9l.9-.9a2 2 0 0 1 2.1-.4 10 10 0 0 0 2.3.7z" />
    </svg>
  )
}

function VideoCallIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="6" width="13" height="12" rx="2.5" ry="2.5" />
      <path d="M15 10.5l6-3.5v10l-6-3.5z" />
    </svg>
  )
}

function CtxReplyIcon() {
  return <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="9 17 4 12 9 7" /><path d="M20 18v-2a4 4 0 0 0-4-4H4" /></svg>
}
function CtxCopyIcon() {
  return <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></svg>
}
function CtxLinkIcon() {
  return <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" /><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" /></svg>
}
function CtxSmileIcon() {
  return <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10" /><path d="M8 14s1.5 2 4 2 4-2 4-2" /><line x1="9" y1="9" x2="9.01" y2="9" /><line x1="15" y1="9" x2="15.01" y2="9" /></svg>
}
function CtxPinIcon() {
  return <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="12" y1="17" x2="12" y2="22" /><path d="M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1v4.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24Z" /></svg>
}
function CtxEditIcon() {
  return <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" /><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" /></svg>
}
function CtxTrashIcon() {
  return <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="3 6 5 6 21 6" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" /></svg>
}
function CtxThreadIcon() {
  return <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" /><line x1="9" y1="10" x2="15" y2="10" /><line x1="9" y1="14" x2="12" y2="14" /></svg>
}
function CtxForwardIcon() {
  return <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="15 17 20 12 15 7" /><path d="M4 18v-2a4 4 0 0 1 4-4h12" /></svg>
}

/* Compact stroked icons for the hover action bar. Same style (1.8 stroke, 16px)
   so they visually match regardless of the user's emoji font. */
function ActBtnReactIcon() {
  return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10" /><path d="M8 14s1.5 2 4 2 4-2 4-2" /><line x1="9" y1="9" x2="9.01" y2="9" /><line x1="15" y1="9" x2="15.01" y2="9" /></svg>
}
function ActBtnReplyIcon() {
  return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><polyline points="9 17 4 12 9 7" /><path d="M20 18v-2a4 4 0 0 0-4-4H4" /></svg>
}
function ActBtnEditIcon() {
  return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" /><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" /></svg>
}
function ActBtnMoreIcon() {
  return <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="1.8" /><circle cx="12" cy="12" r="1.8" /><circle cx="19" cy="12" r="1.8" /></svg>
}
