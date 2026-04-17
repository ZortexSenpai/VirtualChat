import React, { useEffect, useMemo, useRef, useState } from 'react'
import { MatrixEvent, Room } from 'matrix-js-sdk'
import { useMatrix } from '../context/MatrixContext'
import MxcAvatar from './MxcAvatar'
import { isVoiceChannel } from '../services/roomKind'

interface ForwardTarget {
  room: Room
  name: string
  kind: 'dm' | 'room' | 'voice'
  avatarMxc: string | null
}

export default function ForwardModal({ event, onClose }: { event: MatrixEvent; onClose: () => void }) {
  const { client, forwardMessage, setActiveRoom } = useMatrix()
  const [query, setQuery] = useState('')
  const [selectedIdx, setSelectedIdx] = useState(0)
  // Track which room IDs are currently being forwarded to, and which succeeded,
  // so the user can fan-out to multiple rooms and see progress per-row.
  const [sending, setSending] = useState<Set<string>>(new Set())
  const [sent, setSent] = useState<Set<string>>(new Set())
  const [error, setError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => { setTimeout(() => inputRef.current?.focus(), 0) }, [])
  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const targets = useMemo<ForwardTarget[]>(() => {
    if (!client) return []
    const rooms = client.getRooms().filter(r => r.getMyMembership() === 'join' && !r.isSpaceRoom())
    const dmContent = (client.getAccountData('m.direct' as any)?.getContent() ?? {}) as Record<string, string[]>
    const directIds = new Set(Object.values(dmContent).flat())
    const out: ForwardTarget[] = []
    for (const room of rooms) {
      let kind: ForwardTarget['kind']
      if (isVoiceChannel(room)) kind = 'voice'
      else if (directIds.has(room.roomId)) kind = 'dm'
      else kind = 'room'
      out.push({
        room,
        name: room.name || room.roomId,
        kind,
        avatarMxc: room.getMxcAvatarUrl() ?? null,
      })
    }
    return out
  }, [client])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) {
      const order: Record<ForwardTarget['kind'], number> = { dm: 0, room: 1, voice: 2 }
      return [...targets]
        .sort((a, b) => order[a.kind] - order[b.kind] || a.name.localeCompare(b.name))
        .slice(0, 50)
    }
    const scored: { t: ForwardTarget; score: number }[] = []
    for (const t of targets) {
      const name = t.name.toLowerCase()
      let score = -1
      if (name.startsWith(q)) score = 100
      else if (name.split(/\s+/).some(w => w.startsWith(q))) score = 60
      else if (name.includes(q)) score = 30
      if (score >= 0) scored.push({ t, score })
    }
    scored.sort((a, b) => b.score - a.score || a.t.name.localeCompare(b.t.name))
    return scored.map(s => s.t).slice(0, 50)
  }, [targets, query])

  useEffect(() => {
    if (selectedIdx >= filtered.length) setSelectedIdx(Math.max(0, filtered.length - 1))
  }, [filtered.length, selectedIdx])

  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-idx="${selectedIdx}"]`)
    el?.scrollIntoView({ block: 'nearest' })
  }, [selectedIdx])

  async function forwardTo(t: ForwardTarget, opts: { thenOpen?: boolean } = {}) {
    if (sending.has(t.room.roomId) || sent.has(t.room.roomId)) return
    setError(null)
    setSending(prev => new Set(prev).add(t.room.roomId))
    try {
      await forwardMessage(event, t.room.roomId)
      setSent(prev => new Set(prev).add(t.room.roomId))
      if (opts.thenOpen) {
        await setActiveRoom(t.room.roomId)
        onClose()
      }
    } catch (e: any) {
      setError(e?.message ?? 'Forward failed')
    } finally {
      setSending(prev => {
        const next = new Set(prev)
        next.delete(t.room.roomId)
        return next
      })
    }
  }

  function onInputKey(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'ArrowDown') { e.preventDefault(); setSelectedIdx(i => Math.min(filtered.length - 1, i + 1)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setSelectedIdx(i => Math.max(0, i - 1)) }
    else if (e.key === 'Enter') {
      e.preventDefault()
      const target = filtered[selectedIdx]
      if (target) forwardTo(target, { thenOpen: true })
    }
  }

  // Build a tiny preview of what's being forwarded for the modal header.
  const effective = event.replacingEvent()?.getContent()?.['m.new_content'] ?? event.getContent()
  const msgtype = effective.msgtype
  const eventType = event.getType()
  let previewText = ''
  if (eventType === 'm.sticker') previewText = '🖼 Sticker'
  else if (eventType === 'm.poll.start' || eventType === 'org.matrix.msc3381.poll.start') previewText = '📊 Poll'
  else if (msgtype === 'm.image') previewText = '🖼 Image'
  else if (msgtype === 'm.video') previewText = '🎬 Video'
  else if (msgtype === 'm.audio') previewText = '🔊 Audio'
  else if (msgtype === 'm.file') previewText = '📎 File'
  else {
    const body = (effective.body ?? '').replace(/^(>[^\n]*\n)+\n/, '')
    previewText = body.length > 120 ? body.slice(0, 120) + '…' : body
  }

  const senderShort = (event.getSender() ?? '').replace(/^@/, '').split(':')[0] || 'Unknown'

  return (
    <div className="modal-overlay" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="modal-card forward-modal">
        <h2>Forward message</h2>

        <div className="forward-preview">
          <div className="forward-preview-sender">{senderShort}</div>
          <div className="forward-preview-body">{previewText}</div>
        </div>

        <div className="forward-search-row">
          <svg className="forward-search-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="11" cy="11" r="8" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
          <input
            ref={inputRef}
            className="forward-search-input"
            placeholder="Search rooms & DMs…"
            value={query}
            onChange={e => { setQuery(e.target.value); setSelectedIdx(0) }}
            onKeyDown={onInputKey}
          />
        </div>

        {error && <div className="forward-error">{error}</div>}

        <div className="forward-list" ref={listRef}>
          {filtered.length === 0 ? (
            <div className="forward-empty">No matches</div>
          ) : filtered.map((t, i) => {
            const isSending = sending.has(t.room.roomId)
            const isSent = sent.has(t.room.roomId)
            return (
              <div
                key={t.room.roomId}
                data-idx={i}
                className={`forward-item${i === selectedIdx ? ' selected' : ''}${isSent ? ' sent' : ''}`}
                onMouseEnter={() => setSelectedIdx(i)}
              >
                <div className="forward-item-avatar">
                  <MxcAvatar mxcUrl={t.avatarMxc} size={32} name={t.name} />
                </div>
                <div className="forward-item-text">
                  <div className="forward-item-name">
                    <span className={`forward-item-kind forward-item-kind--${t.kind}`}>
                      {t.kind === 'dm' ? '@' : t.kind === 'voice' ? '🔊' : '#'}
                    </span>
                    {t.name}
                  </div>
                </div>
                <button
                  className={`forward-item-send${isSent ? ' done' : ''}`}
                  onClick={() => forwardTo(t)}
                  disabled={isSending || isSent}
                  type="button"
                >
                  {isSent ? '✓ Sent' : isSending ? '…' : 'Send'}
                </button>
              </div>
            )
          })}
        </div>

        <div className="modal-actions">
          <button className="btn-secondary" onClick={onClose}>Done</button>
        </div>
      </div>
    </div>
  )
}
