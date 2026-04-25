import React, { useMemo, useState } from 'react'
import { EventType, MatrixClient, Room } from 'matrix-js-sdk'
import { useMatrix } from '../context/MatrixContext'
import MxcAvatar from './MxcAvatar'

function avatarColor(name: string): string {
  const colors = [
    '#5865f2', '#57f287', '#fee75c', '#eb459e',
    '#ed4245', '#3ba55c', '#faa61a', '#9b59b6',
  ]
  let hash = 0
  for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash)
  return colors[Math.abs(hash) % colors.length]
}

function getSpaceUnreadCount(space: Room, client: MatrixClient): number {
  const childEvents = space.currentState.getStateEvents(EventType.SpaceChild as string)
  const childIds = new Set(
    (Array.isArray(childEvents) ? childEvents : [childEvents])
      .filter(Boolean)
      .map((e: any) => e.getStateKey())
      .filter((id: any): id is string => Boolean(id)),
  )
  let total = 0
  for (const roomId of childIds) {
    const room = client.getRoom(roomId)
    if (room) total += room.getUnreadNotificationCount()
  }
  return total
}

function getHomeUnreadCount(rooms: Room[], directRooms: Room[]): number {
  let total = 0
  for (const room of rooms) total += room.getUnreadNotificationCount()
  for (const room of directRooms) total += room.getUnreadNotificationCount()
  return total
}

/** Apply saved order: known-ordered ids first (in order), then any remaining spaces in default order. */
function applyOrder(spaces: Room[], order: string[]): Room[] {
  if (order.length === 0) return spaces
  const byId = new Map(spaces.map(s => [s.roomId, s]))
  const ordered: Room[] = []
  const seen = new Set<string>()
  for (const id of order) {
    const s = byId.get(id)
    if (s && !seen.has(id)) {
      ordered.push(s)
      seen.add(id)
    }
  }
  for (const s of spaces) {
    if (!seen.has(s.roomId)) ordered.push(s)
  }
  return ordered
}

export default function SpaceBar() {
  const { state, setActiveSpace, client, reorderSpaces } = useMatrix()
  const [dragId, setDragId] = useState<string | null>(null)
  const [dropTargetId, setDropTargetId] = useState<string | null>(null)

  const orderedSpaces = useMemo(
    () => applyOrder(state.spaces, state.spaceOrder),
    [state.spaces, state.spaceOrder],
  )

  const homeUnread = getHomeUnreadCount(state.rooms, state.directRooms)
  const isHomeActive = state.activeSpaceId === null

  function handleDragStart(e: React.DragEvent<HTMLDivElement>, spaceId: string) {
    setDragId(spaceId)
    e.dataTransfer.effectAllowed = 'move'
    // Firefox requires data to be set for the drag to begin
    try { e.dataTransfer.setData('text/plain', spaceId) } catch { /* ignore */ }
  }

  function handleDragOver(e: React.DragEvent<HTMLDivElement>, overId: string) {
    if (!dragId || dragId === overId) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    if (dropTargetId !== overId) setDropTargetId(overId)
  }

  function handleDrop(e: React.DragEvent<HTMLDivElement>, dropId: string) {
    e.preventDefault()
    const sourceId = dragId
    setDragId(null)
    setDropTargetId(null)
    if (!sourceId || sourceId === dropId) return
    const current = orderedSpaces.map(s => s.roomId)
    const fromIdx = current.indexOf(sourceId)
    const toIdx = current.indexOf(dropId)
    if (fromIdx < 0 || toIdx < 0) return
    const next = [...current]
    next.splice(fromIdx, 1)
    next.splice(toIdx, 0, sourceId)
    reorderSpaces(next).catch(err => console.warn('reorderSpaces failed', err))
  }

  function handleDragEnd() {
    setDragId(null)
    setDropTargetId(null)
  }

  return (
    <div className="space-bar select-none">
      {/* Home / All rooms */}
      <div
        className={`space-icon-wrap ${isHomeActive ? 'active' : ''}`}
        onClick={() => setActiveSpace(null)}
        title="Home"
      >
        <div className="space-pill" />
        <div className="space-icon" style={{ background: isHomeActive ? '#5865f2' : undefined }}>
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M3 11.5 12 4l9 7.5" />
            <path d="M5 10.5V20a1 1 0 0 0 1 1h4v-6h4v6h4a1 1 0 0 0 1-1v-9.5" />
          </svg>
        </div>
        {homeUnread > 0 && !isHomeActive && (
          <span className="space-unread-badge">
            {homeUnread > 99 ? '99+' : homeUnread}
          </span>
        )}
      </div>

      <div className="space-separator" />

      {/* Space icons */}
      {orderedSpaces.map(space => {
        const avatarMxc = space.getMxcAvatarUrl() ?? null
        const name = space.name || space.roomId
        const isActive = state.activeSpaceId === space.roomId
        const unread = client ? getSpaceUnreadCount(space, client) : 0
        const isDragging = dragId === space.roomId
        const isDropTarget = dropTargetId === space.roomId && dragId !== space.roomId

        const cls = [
          'space-icon-wrap',
          isActive ? 'active' : '',
          isDragging ? 'dragging' : '',
          isDropTarget ? 'drop-target' : '',
        ].filter(Boolean).join(' ')

        return (
          <div
            key={space.roomId}
            className={cls}
            onClick={() => setActiveSpace(space.roomId)}
            title={name}
            draggable
            onDragStart={(e) => handleDragStart(e, space.roomId)}
            onDragOver={(e) => handleDragOver(e, space.roomId)}
            onDragLeave={() => { if (dropTargetId === space.roomId) setDropTargetId(null) }}
            onDrop={(e) => handleDrop(e, space.roomId)}
            onDragEnd={handleDragEnd}
          >
            <div className="space-pill" />
            <div
              className="space-icon"
              style={!avatarMxc ? { background: avatarColor(name) } : undefined}
            >
              <MxcAvatar mxcUrl={avatarMxc} size={48} name={name} />
            </div>
            {unread > 0 && !isActive && (
              <span className="space-unread-badge">
                {unread > 99 ? '99+' : unread}
              </span>
            )}
          </div>
        )
      })}
    </div>
  )
}
