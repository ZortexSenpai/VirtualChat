import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Room } from 'matrix-js-sdk'
import { useMatrix } from '../context/MatrixContext'
import MxcAvatar from './MxcAvatar'
import { isVoiceChannel } from '../services/roomKind'

interface SwitchEntry {
  room: Room
  name: string
  kind: 'dm' | 'room' | 'space' | 'voice'
  avatarMxc: string | null
  parentSpaceName?: string
}

export default function QuickSwitcher() {
  const { client, state, setActiveRoom, setActiveSpace } = useMatrix()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [selectedIdx, setSelectedIdx] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  // Global Ctrl/Cmd+K shortcut
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k' && !e.shiftKey && !e.altKey) {
        const target = e.target as HTMLElement | null
        // Don't hijack native find-in-page / other editor chords by checking it's a 'k'
        e.preventDefault()
        setOpen(o => !o)
        setQuery('')
        setSelectedIdx(0)
        // Avoid double-trigger when textareas/contenteditables are focused; the
        // preventDefault above is enough — we still want to toggle regardless.
        target?.blur?.()
      } else if (e.key === 'Escape' && open) {
        setOpen(false)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  // Focus the input when opened
  useEffect(() => {
    if (open) setTimeout(() => inputRef.current?.focus(), 0)
  }, [open])

  // Build a searchable list from all joined rooms + spaces
  const entries = useMemo<SwitchEntry[]>(() => {
    if (!client) return []
    const rooms = client.getRooms().filter(r => r.getMyMembership() === 'join')
    const dmContent = (client.getAccountData('m.direct' as any)?.getContent() ?? {}) as Record<string, string[]>
    const directIds = new Set(Object.values(dmContent).flat())

    // For each non-space, non-DM room, find its containing space (if any) to show as context
    const parentSpaceByRoomId = new Map<string, string>()
    for (const space of rooms.filter(r => r.isSpaceRoom())) {
      const childEvents = space.currentState.getStateEvents('m.space.child')
      const list = Array.isArray(childEvents) ? childEvents : [childEvents]
      for (const ev of list) {
        if (!ev) continue
        const childId = ev.getStateKey()
        if (childId && !parentSpaceByRoomId.has(childId)) {
          parentSpaceByRoomId.set(childId, space.name)
        }
      }
    }

    const out: SwitchEntry[] = []
    for (const room of rooms) {
      let kind: SwitchEntry['kind']
      if (room.isSpaceRoom()) kind = 'space'
      else if (isVoiceChannel(room)) kind = 'voice'
      else if (directIds.has(room.roomId)) kind = 'dm'
      else kind = 'room'
      out.push({
        room,
        name: room.name,
        kind,
        avatarMxc: room.getMxcAvatarUrl() ?? null,
        parentSpaceName: parentSpaceByRoomId.get(room.roomId),
      })
    }
    return out
  }, [client, state.rooms, state.spaces, state.directRooms])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) {
      // With no query, show a stable recency-ish default: DMs first, then rooms, then voice, then spaces
      const order: Record<SwitchEntry['kind'], number> = { dm: 0, room: 1, voice: 2, space: 3 }
      return [...entries]
        .sort((a, b) => order[a.kind] - order[b.kind] || a.name.localeCompare(b.name))
        .slice(0, 30)
    }
    // Simple scoring: prefix > word-start > substring. Tie-break by name.
    const scored: { e: SwitchEntry; score: number }[] = []
    for (const e of entries) {
      const name = e.name.toLowerCase()
      let score = -1
      if (name.startsWith(q)) score = 100
      else if (name.split(/\s+/).some(w => w.startsWith(q))) score = 60
      else if (name.includes(q)) score = 30
      if (score >= 0) scored.push({ e, score })
    }
    scored.sort((a, b) => b.score - a.score || a.e.name.localeCompare(b.e.name))
    return scored.map(s => s.e).slice(0, 30)
  }, [entries, query])

  // Clamp selection when filter changes
  useEffect(() => {
    if (selectedIdx >= filtered.length) setSelectedIdx(Math.max(0, filtered.length - 1))
  }, [filtered.length, selectedIdx])

  // Scroll selected into view
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-idx="${selectedIdx}"]`)
    el?.scrollIntoView({ block: 'nearest' })
  }, [selectedIdx])

  async function activate(entry: SwitchEntry) {
    setOpen(false)
    if (entry.kind === 'space') {
      setActiveSpace(entry.room.roomId)
    } else {
      await setActiveRoom(entry.room.roomId)
    }
  }

  function onInputKey(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setSelectedIdx(i => Math.min(filtered.length - 1, i + 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setSelectedIdx(i => Math.max(0, i - 1))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const target = filtered[selectedIdx]
      if (target) activate(target)
    }
  }

  if (!open) return null

  return (
    <div className="quick-switcher-overlay" onClick={e => e.target === e.currentTarget && setOpen(false)}>
      <div className="quick-switcher">
        <div className="quick-switcher-input-row">
          <svg className="quick-switcher-search-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="11" cy="11" r="8" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
          <input
            ref={inputRef}
            className="quick-switcher-input"
            placeholder="Jump to room, DM, or space…"
            value={query}
            onChange={e => { setQuery(e.target.value); setSelectedIdx(0) }}
            onKeyDown={onInputKey}
          />
          <span className="quick-switcher-hint">ESC</span>
        </div>
        <div className="quick-switcher-list" ref={listRef}>
          {filtered.length === 0 ? (
            <div className="quick-switcher-empty">No matches</div>
          ) : filtered.map((e, i) => (
            <button
              key={e.room.roomId}
              data-idx={i}
              className={`quick-switcher-item${i === selectedIdx ? ' selected' : ''}`}
              onMouseEnter={() => setSelectedIdx(i)}
              onClick={() => activate(e)}
              type="button"
            >
              <div className="quick-switcher-avatar">
                <MxcAvatar mxcUrl={e.avatarMxc} size={28} name={e.name} />
              </div>
              <div className="quick-switcher-text">
                <div className="quick-switcher-name">
                  <span className={`quick-switcher-kind quick-switcher-kind--${e.kind}`}>
                    {e.kind === 'dm' ? '@'
                      : e.kind === 'space' ? '◈'
                      : e.kind === 'voice' ? (
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                          <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                          <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
                          <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
                        </svg>
                      )
                      : '#'}
                  </span>
                  {e.name}
                </div>
                {e.parentSpaceName && (
                  <div className="quick-switcher-sub">in {e.parentSpaceName}</div>
                )}
              </div>
            </button>
          ))}
        </div>
        <div className="quick-switcher-footer">
          <span><kbd>↑</kbd><kbd>↓</kbd> navigate</span>
          <span><kbd>↵</kbd> open</span>
          <span><kbd>esc</kbd> close</span>
        </div>
      </div>
    </div>
  )
}
