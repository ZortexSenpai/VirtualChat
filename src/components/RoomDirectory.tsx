import React, { useEffect, useRef, useState } from 'react'
import { useMatrix } from '../context/MatrixContext'
import MxcAvatar from './MxcAvatar'

interface PublicRoom {
  room_id: string
  name?: string
  avatar_url?: string
  topic?: string
  canonical_alias?: string
  num_joined_members: number
  world_readable: boolean
  guest_can_join: boolean
  join_rule?: string
}

export default function RoomDirectory({ onClose }: { onClose: () => void }) {
  const { client, joinRoom, knockRoom, setActiveRoom } = useMatrix()
  const [search, setSearch] = useState('')
  const [rooms, setRooms] = useState<PublicRoom[]>([])
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [nextBatch, setNextBatch] = useState<string | null>(null)
  const [total, setTotal] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [joiningId, setJoiningId] = useState<string | null>(null)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const listRef = useRef<HTMLDivElement>(null)

  // Fetch rooms on mount and when search changes (debounced)
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => fetchRooms(search, false), 300)
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current) }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search])

  // Initial load
  useEffect(() => {
    fetchRooms('', false)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function fetchRooms(term: string, paginate: boolean) {
    if (!client) return
    if (paginate) setLoadingMore(true)
    else setLoading(true)
    setError(null)
    try {
      const resp = await (client as any).publicRooms({
        limit: 20,
        since: paginate ? nextBatch : undefined,
        filter: term ? { generic_search_term: term } : undefined,
      })
      const chunk: PublicRoom[] = resp.chunk ?? []
      if (paginate) {
        setRooms(prev => [...prev, ...chunk])
      } else {
        setRooms(chunk)
        if (listRef.current) listRef.current.scrollTop = 0
      }
      setNextBatch(resp.next_batch ?? null)
      setTotal(resp.total_room_count_estimate ?? null)
    } catch (e: any) {
      setError(e?.message ?? 'Failed to load room directory')
    } finally {
      setLoading(false)
      setLoadingMore(false)
    }
  }

  async function handleJoin(roomId: string, isKnock?: boolean) {
    setJoiningId(roomId)
    try {
      if (isKnock) {
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

  // Check if we already joined a room
  function isJoined(roomId: string): boolean {
    return client?.getRoom(roomId)?.getMyMembership() === 'join'
  }

  return (
    <div className="modal-overlay" onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <div className="room-directory-modal">
        <div className="room-directory-header">
          <h2>Explore Public Rooms</h2>
          <button className="room-directory-close" onClick={onClose} aria-label="Close">✕</button>
        </div>

        <div className="room-directory-search">
          <input
            type="text"
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search rooms..."
            autoFocus
          />
          {total !== null && !loading && (
            <span className="room-directory-count">{total.toLocaleString()} rooms</span>
          )}
        </div>

        {error && <p className="room-directory-error">{error}</p>}

        <div className="room-directory-list" ref={listRef}>
          {loading ? (
            <div className="room-directory-loading">
              <div className="spinner" />
            </div>
          ) : rooms.length === 0 ? (
            <div className="room-directory-empty">
              {search ? 'No rooms match your search.' : 'No public rooms found.'}
            </div>
          ) : (
            <>
              {rooms.map(room => {
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
                      onClick={() => joined ? setActiveRoom(room.room_id).then(onClose) : handleJoin(room.room_id, room.join_rule === 'knock')}
                      disabled={joiningId === room.room_id}
                    >
                      {joiningId === room.room_id ? (room.join_rule === 'knock' ? 'Requesting...' : 'Joining...') : joined ? 'Open' : room.join_rule === 'knock' ? 'Knock' : 'Join'}
                    </button>
                  </div>
                )
              })}

              {nextBatch && (
                <button
                  className="room-directory-load-more"
                  onClick={() => fetchRooms(search, true)}
                  disabled={loadingMore}
                >
                  {loadingMore ? 'Loading...' : 'Load more'}
                </button>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  )
}
