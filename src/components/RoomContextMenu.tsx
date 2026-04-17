import React, { useEffect, useRef, useState } from 'react'
import { Room } from 'matrix-js-sdk'
import { useMatrix } from '../context/MatrixContext'

interface Props {
  room: Room
  x: number
  y: number
  onClose: () => void
  onOpenSettings: () => void
  isPinned: boolean
  onTogglePin: () => void
}

type NotifLevel = 'all' | 'mentions' | 'mute'

export default function RoomContextMenu({ room, x, y, onClose, onOpenSettings, isPinned, onTogglePin }: Props) {
  const { client } = useMatrix()
  const menuRef = useRef<HTMLDivElement>(null)
  const [confirmLeave, setConfirmLeave] = useState(false)
  const [copied, setCopied] = useState<'link' | 'id' | null>(null)
  const [notif, setNotif] = useState<NotifLevel>('mentions')

  // Clamp to viewport
  const menuW = 224
  const menuH = 330
  const ax = Math.min(x, window.innerWidth - menuW - 8)
  const ay = Math.min(y, window.innerHeight - menuH - 8)

  // Read current notification level
  useEffect(() => {
    if (!client) return
    const rules = (client as any).getPushRules?.()
    const overrides: any[] = rules?.global?.override ?? []
    const roomRules: any[] = rules?.global?.room ?? []
    if (overrides.find((r: any) => r.rule_id === room.roomId && r.enabled)) {
      setNotif('mute')
    } else if (roomRules.find((r: any) => r.rule_id === room.roomId && r.enabled)) {
      setNotif('all')
    } else {
      setNotif('mentions')
    }
  }, [client, room.roomId])

  // Close on outside click or Escape
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    const onDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) onClose()
    }
    document.addEventListener('keydown', onKey)
    document.addEventListener('mousedown', onDown)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('mousedown', onDown)
    }
  }, [onClose])

  async function handleMarkAsRead() {
    if (!client) return
    const events = room.getLiveTimeline().getEvents()
    const last = [...events].reverse().find(e => !e.isRedacted())
    if (last) {
      try { await client.sendReadReceipt(last as any) } catch {}
    }
    onClose()
  }

  async function handleSetNotif(level: NotifLevel) {
    if (!client) return
    const id = room.roomId
    setNotif(level)
    try {
      try { await (client as any).deletePushRule('global', 'override', id) } catch {}
      try { await (client as any).deletePushRule('global', 'room', id) } catch {}
      if (level === 'mute') {
        await (client as any).addPushRule('global', 'override', id, {
          conditions: [{ kind: 'event_match', key: 'room_id', pattern: id }],
          actions: ['dont_notify'],
        })
        await (client as any).setPushRuleEnabled('global', 'override', id, true)
      } else if (level === 'all') {
        await (client as any).addPushRule('global', 'room', id, {
          actions: ['notify', { set_tweak: 'sound', value: 'default' }],
        })
        await (client as any).setPushRuleEnabled('global', 'room', id, true)
      }
    } catch (err) {
      console.warn('Failed to update push rules:', err)
    }
  }

  async function handleLeave() {
    if (!client) return
    try { await client.leave(room.roomId) } catch (err) { console.warn('Leave failed:', err) }
    onClose()
  }

  async function handleCopyLink() {
    const alias = room.getCanonicalAlias()
    const text = alias ? `https://matrix.to/#/${alias}` : `https://matrix.to/#/${room.roomId}`
    await navigator.clipboard.writeText(text)
    setCopied('link')
    setTimeout(() => { setCopied(null); onClose() }, 1200)
  }

  async function handleCopyId() {
    await navigator.clipboard.writeText(room.roomId)
    setCopied('id')
    setTimeout(() => { setCopied(null); onClose() }, 1200)
  }

  return (
    <div ref={menuRef} className="room-ctx-menu" style={{ top: ay, left: ax }}>
      {confirmLeave ? (
        <div className="room-ctx-confirm">
          <p className="room-ctx-confirm-msg">
            Leave <strong>{room.name}</strong>?
          </p>
          <div className="room-ctx-confirm-actions">
            <button className="room-ctx-confirm-cancel" onClick={() => setConfirmLeave(false)}>
              Cancel
            </button>
            <button className="room-ctx-confirm-leave" onClick={handleLeave}>
              Leave
            </button>
          </div>
        </div>
      ) : (
        <>
          <button className="room-ctx-item" onClick={handleMarkAsRead}>
            <CheckIcon /> Mark as read
          </button>

          <div className="room-ctx-sep" />
          <div className="room-ctx-group-label">Notifications</div>

          {([
            ['all', 'All messages'],
            ['mentions', 'Mentions & keywords'],
            ['mute', 'Mute'],
          ] as [NotifLevel, string][]).map(([level, label]) => (
            <button
              key={level}
              className={`room-ctx-item room-ctx-item--radio${notif === level ? ' active' : ''}`}
              onClick={() => handleSetNotif(level)}
            >
              <span className="room-ctx-radio-dot" />
              {label}
            </button>
          ))}

          <div className="room-ctx-sep" />

          <button className="room-ctx-item" onClick={() => { onOpenSettings(); onClose() }}>
            <GearIcon /> Room settings
          </button>
          <button className="room-ctx-item" onClick={handleCopyLink}>
            <LinkIcon /> {copied === 'link' ? 'Copied!' : 'Copy room link'}
          </button>
          <button className="room-ctx-item" onClick={handleCopyId}>
            <CopyIcon /> {copied === 'id' ? 'Copied!' : 'Copy room ID'}
          </button>

          <button className="room-ctx-item" onClick={() => { onTogglePin(); onClose() }}>
            <PinIcon /> {isPinned ? 'Unpin room' : 'Pin room'}
          </button>

          <div className="room-ctx-sep" />

          <button className="room-ctx-item room-ctx-item--danger" onClick={() => setConfirmLeave(true)}>
            <LeaveIcon /> Leave room
          </button>
        </>
      )}
    </div>
  )
}

function CheckIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="20 6 9 17 4 12" />
    </svg>
  )
}

function GearIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06-.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  )
}

function LinkIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
      <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
    </svg>
  )
}

function CopyIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  )
}

function LeaveIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
      <polyline points="16 17 21 12 16 7" />
      <line x1="21" y1="12" x2="9" y2="12" />
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
