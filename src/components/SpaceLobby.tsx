import React, { useEffect, useState } from 'react'
import { useMatrix } from '../context/MatrixContext'
import MxcAvatar from './MxcAvatar'

interface HierarchyRoom {
  room_id: string
  name?: string
  avatar_url?: string
  topic?: string
  canonical_alias?: string
  num_joined_members: number
  world_readable: boolean
  guest_can_join: boolean
  join_rule?: string
  room_type?: string
}

export default function SpaceLobby({ spaceId, onClose }: { spaceId: string; onClose: () => void }) {
  const { client, joinRoom, knockRoom, setActiveRoom } = useMatrix()
  const [rooms, setRooms] = useState<HierarchyRoom[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [joiningId, setJoiningId] = useState<string | null>(null)

  const space = client?.getRoom(spaceId) ?? null
  const spaceName = space?.name ?? 'Space'

  useEffect(() => {
    if (!client) return
    let cancelled = false
    setLoading(true)
    setError(null)
    ;(async () => {
      try {
        const resp: any = await (client as any).getRoomHierarchy(spaceId, 50, 1, false)
        if (cancelled) return
        // Drop the space itself (first entry of the hierarchy response)
        const children: HierarchyRoom[] = (resp.rooms ?? []).filter((r: HierarchyRoom) => r.room_id !== spaceId && r.room_type !== 'm.space')
        setRooms(children)
      } catch (e: any) {
        if (!cancelled) setError(e?.message ?? 'Failed to load space hierarchy')
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [client, spaceId])

  function isJoined(roomId: string): boolean {
    return client?.getRoom(roomId)?.getMyMembership() === 'join'
  }

  async function handleJoin(room: HierarchyRoom) {
    const roomId = room.room_id
    setJoiningId(roomId)
    try {
      if (room.join_rule === 'knock') {
        await knockRoom(roomId)
        setError(null)
        setJoiningId(null)
        alert('Request to join sent. A room admin will need to approve it.')
        return
      }
      const id = await joinRoom(roomId)
      await setActiveRoom(id)
      onClose()
    } catch (e: any) {
      setError(e?.message ?? 'Failed to join room')
      setJoiningId(null)
    }
  }

  async function handleOpen(roomId: string) {
    await setActiveRoom(roomId)
    onClose()
  }

  return (
    <div className="modal-overlay" onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <div className="room-directory-modal">
        <div className="room-directory-header">
          <h2>Browse channels in {spaceName}</h2>
          <button className="room-directory-close" onClick={onClose} aria-label="Close">✕</button>
        </div>

        {error && <p className="room-directory-error">{error}</p>}

        <div className="room-directory-list">
          {loading ? (
            <div className="room-directory-loading">
              <div className="spinner" />
            </div>
          ) : rooms.length === 0 ? (
            <div className="room-directory-empty">
              No channels available in this space yet.
            </div>
          ) : (
            rooms.map(room => {
              const joined = isJoined(room.room_id)
              const alias = room.canonical_alias || room.room_id
              return (
                <div key={room.room_id} className="room-directory-item">
                  <MxcAvatar
                    mxcUrl={room.avatar_url ?? null}
                    size={40}
                    name={room.name || alias}
                    style={{ width: 40, height: 40, borderRadius: 8, flexShrink: 0 }}
                  />
                  <div className="room-directory-info">
                    <div className="room-directory-name">{room.name || alias}</div>
                    {room.canonical_alias && room.name && (
                      <div className="room-directory-alias">{room.canonical_alias}</div>
                    )}
                    {room.topic && (
                      <div className="room-directory-topic">{room.topic}</div>
                    )}
                    <div className="room-directory-meta">
                      <span>{room.num_joined_members.toLocaleString()} members</span>
                      {room.join_rule === 'knock' && <span className="room-directory-badge">Knock</span>}
                      {room.world_readable && <span className="room-directory-badge">Preview</span>}
                    </div>
                  </div>
                  <button
                    className={`room-directory-join-btn${joined ? ' joined' : ''}`}
                    onClick={() => joined ? handleOpen(room.room_id) : handleJoin(room)}
                    disabled={joiningId === room.room_id}
                  >
                    {joiningId === room.room_id
                      ? (room.join_rule === 'knock' ? 'Requesting...' : 'Joining...')
                      : joined
                        ? 'Open'
                        : room.join_rule === 'knock' ? 'Knock' : 'Join'}
                  </button>
                </div>
              )
            })
          )}
        </div>
      </div>
    </div>
  )
}
