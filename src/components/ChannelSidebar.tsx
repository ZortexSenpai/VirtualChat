import React, { useEffect, useRef, useState } from 'react'
import { Room, Direction, NotificationCountType, RoomStateEvent } from 'matrix-js-sdk'
import { useMatrix } from '../context/MatrixContext'
import UserPanel from './UserPanel'
import MxcAvatar, { useMxcBlobUrl } from './MxcAvatar'
import RoomContextMenu from './RoomContextMenu'
import RoomSettingsModal from './RoomSettingsModal'
import RoomDirectory from './RoomDirectory'
import { isVoiceChannel } from '../services/roomKind'
import { useTranslation } from '../services/i18n'

function VoiceChannelIcon() {
  return (
    <svg className="channel-voice-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
      <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
      <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
    </svg>
  )
}

// Space banner state event — same key Commet and Sable use (from everypizza client).
const SPACE_BANNER_EVENT = 'page.codeberg.everypizza.room.banner'

function SpaceBanner({ space }: { space: Room }) {
  const { client, state } = useMatrix()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  // Read + subscribe: re-render when the banner state event changes (so an
  // update echoed back by sync actually appears in the UI).
  const readBanner = () => {
    const ev = space.currentState.getStateEvents(SPACE_BANNER_EVENT, '')
    const url = ev?.getContent()?.url
    return typeof url === 'string' && url.startsWith('mxc://') ? url : null
  }
  const [bannerMxc, setBannerMxc] = useState<string | null>(readBanner)

  useEffect(() => {
    setBannerMxc(readBanner())
    const handler = (ev: any) => {
      if (ev?.getType?.() === SPACE_BANNER_EVENT) setBannerMxc(readBanner())
    }
    space.currentState.on(RoomStateEvent.Events, handler)
    return () => { space.currentState.off(RoomStateEvent.Events, handler) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [space.roomId])

  const bannerHttpUrl = useMxcBlobUrl(bannerMxc, 600, 160)

  const userId = state.userId ?? ''
  const canEdit = space.currentState.maySendStateEvent(SPACE_BANNER_EVENT, userId)

  async function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file || !client) return
    setBusy(true)
    setError(null)
    try {
      const upload = await client.uploadContent(file, { type: file.type }) as any
      await (client as any).sendStateEvent(space.roomId, SPACE_BANNER_EVENT, {
        url: upload.content_uri,
        mimetype: file.type,
      }, '')
      // Optimistic: local state event may not be in the cache yet — show
      // the new banner immediately, the sync echo will confirm or override.
      setBannerMxc(upload.content_uri)
    } catch (err: any) {
      console.error('Space banner update failed:', err)
      setError(err?.message ?? 'Failed to update banner')
    } finally {
      setBusy(false)
      if (e.target) e.target.value = ''
    }
  }

  async function handleRemove() {
    if (!client) return
    setBusy(true)
    setError(null)
    try {
      await (client as any).sendStateEvent(space.roomId, SPACE_BANNER_EVENT, {}, '')
      setBannerMxc(null)
    } catch (err: any) {
      console.error('Space banner remove failed:', err)
      setError(err?.message ?? 'Failed to remove banner')
    } finally {
      setBusy(false)
    }
  }

  if (!bannerMxc && !canEdit) return null

  return (
    <div
      className="space-banner"
      style={bannerHttpUrl ? { backgroundImage: `url(${bannerHttpUrl})` } : undefined}
    >
      {canEdit && (
        <div className="space-banner-actions">
          <button
            type="button"
            className="space-banner-btn"
            onClick={() => fileInputRef.current?.click()}
            disabled={busy}
            title={bannerMxc ? 'Change banner' : 'Upload banner'}
          >
            {busy ? '…' : bannerMxc ? 'Change' : 'Upload banner'}
          </button>
          {bannerMxc && (
            <button
              type="button"
              className="space-banner-btn"
              onClick={handleRemove}
              disabled={busy}
              title="Remove banner"
            >
              Remove
            </button>
          )}
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            style={{ display: 'none' }}
            onChange={handleFile}
          />
        </div>
      )}
      {error && <div className="space-banner-error">{error}</div>}
    </div>
  )
}

/** Render the appropriate channel glyph (speaker for voice channels, `#` otherwise). */
function ChannelGlyph({ room }: { room: Room }) {
  if (isVoiceChannel(room)) {
    return <span className="channel-hash channel-hash--voice"><VoiceChannelIcon /></span>
  }
  return <span className="channel-hash">#</span>
}

function CreateRoomModal({ onClose }: { onClose: () => void }) {
  const { createRoom, setActiveRoom } = useMatrix()
  const [name, setName] = useState('')
  const [topic, setTopic] = useState('')
  const [isPrivate, setIsPrivate] = useState(true)
  const [enableEncryption, setEnableEncryption] = useState(() => localStorage.getItem('vc_encrypt_rooms_default') === 'true')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  async function handleCreate() {
    const n = name.trim()
    if (!n) return
    setError(null)
    setLoading(true)
    try {
      const roomId = await createRoom(n, topic.trim() || undefined, isPrivate, enableEncryption)
      await setActiveRoom(roomId)
      onClose()
    } catch (err: any) {
      setError(err?.message ?? 'Failed to create room')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="modal-overlay" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="modal-card">
        <h2>Create Room</h2>
        <div className="form-group">
          <label>Room Name</label>
          <input type="text" value={name} onChange={e => setName(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') handleCreate() }}
            placeholder="my-room" autoFocus />
        </div>
        <div className="form-group">
          <label>Topic (optional)</label>
          <input type="text" value={topic} onChange={e => setTopic(e.target.value)}
            placeholder="What's this room about?" />
        </div>
        <div className="form-group form-group--row">
          <label>
            <input type="checkbox" checked={isPrivate} onChange={e => setIsPrivate(e.target.checked)} />
            {' '}Private room
          </label>
        </div>
        <div className="form-group form-group--row">
          <label>
            <input type="checkbox" checked={enableEncryption} onChange={e => setEnableEncryption(e.target.checked)} />
            {' '}Enable end-to-end encryption
          </label>
        </div>
        {error && <p style={{ color: '#fca5a5', fontSize: 13, margin: '4px 0 0' }}>{error}</p>}
        <div className="modal-actions">
          <button className="btn-secondary" onClick={onClose}>Cancel</button>
          <button className="btn-primary" style={{ display: 'inline-block', width: 'auto', marginTop: 0 }}
            onClick={handleCreate} disabled={loading || !name.trim()}>
            {loading ? 'Creating…' : 'Create'}
          </button>
        </div>
      </div>
    </div>
  )
}

function JoinRoomModal({ onClose }: { onClose: () => void }) {
  const { joinRoom, knockRoom, setActiveRoom } = useMatrix()
  const [address, setAddress] = useState('')
  const [reason, setReason] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [knockMode, setKnockMode] = useState(false)
  const [knocked, setKnocked] = useState(false)

  async function handleJoin() {
    const addr = address.trim()
    if (!addr) return
    setError(null)
    setLoading(true)
    try {
      const roomId = await joinRoom(addr)
      await setActiveRoom(roomId)
      onClose()
    } catch (err: any) {
      const msg: string = err?.message ?? ''
      // If the room requires knocking, switch to knock mode
      if (msg.includes('knock') || msg.includes('M_FORBIDDEN') || err?.errcode === 'M_FORBIDDEN') {
        setKnockMode(true)
        setError(null)
      } else {
        setError(msg || 'Failed to join room')
      }
    } finally {
      setLoading(false)
    }
  }

  async function handleKnock() {
    const addr = address.trim()
    if (!addr) return
    setError(null)
    setLoading(true)
    try {
      await knockRoom(addr, reason.trim() || undefined)
      setKnocked(true)
    } catch (err: any) {
      setError(err?.message ?? 'Failed to send knock request')
    } finally {
      setLoading(false)
    }
  }

  if (knocked) {
    return (
      <div className="modal-overlay" onClick={e => e.target === e.currentTarget && onClose()}>
        <div className="modal-card">
          <h2>Request Sent</h2>
          <p style={{ color: 'var(--text-normal)', fontSize: 14, lineHeight: 1.5, margin: '8px 0 0' }}>
            Your request to join has been sent. A room admin will need to approve it.
          </p>
          <div className="modal-actions">
            <button className="btn-primary" style={{ display: 'inline-block', width: 'auto', marginTop: 0 }} onClick={onClose}>Done</button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="modal-overlay" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="modal-card">
        <h2>{knockMode ? 'Request to Join' : 'Join Room'}</h2>
        <div className="form-group">
          <label>Room address or ID</label>
          <input
            type="text"
            value={address}
            onChange={e => { setAddress(e.target.value); setKnockMode(false) }}
            onKeyDown={e => { if (e.key === 'Enter') knockMode ? handleKnock() : handleJoin() }}
            placeholder="#room:homeserver.org or !id:homeserver.org"
            autoFocus
          />
        </div>
        {knockMode && (
          <div className="form-group">
            <label>Reason (optional)</label>
            <input
              type="text"
              value={reason}
              onChange={e => setReason(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') handleKnock() }}
              placeholder="Why do you want to join?"
            />
          </div>
        )}
        {knockMode && !error && (
          <p style={{ color: 'var(--text-muted)', fontSize: 13, margin: '4px 0 0' }}>
            This room requires approval to join. Send a request to the room admins.
          </p>
        )}
        {error && <p style={{ color: '#fca5a5', fontSize: 13, margin: '4px 0 0' }}>{error}</p>}
        <div className="modal-actions">
          <button className="btn-secondary" onClick={onClose}>Cancel</button>
          <button
            className="btn-primary"
            style={{ display: 'inline-block', width: 'auto', marginTop: 0 }}
            onClick={knockMode ? handleKnock : handleJoin}
            disabled={loading || !address.trim()}
          >
            {loading ? (knockMode ? 'Requesting…' : 'Joining…') : knockMode ? 'Request to Join' : 'Join'}
          </button>
        </div>
      </div>
    </div>
  )
}

interface ContextMenuState {
  room: Room
  x: number
  y: number
}

function NewDMModal({ onClose }: { onClose: () => void }) {
  const { createDM, setActiveRoom, client } = useMatrix()
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<Array<{ user_id: string; display_name?: string }>>([])
  const [searching, setSearching] = useState(false)
  const [selected, setSelected] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    const q = query.trim()
    if (!q || !client) { setResults([]); return }
    const timer = setTimeout(async () => {
      setSearching(true)
      try {
        const res = await (client as any).searchUserDirectory({ term: q, limit: 8 })
        setResults(res.results ?? [])
      } catch {
        setResults([])
      } finally {
        setSearching(false)
      }
    }, 300)
    return () => clearTimeout(timer)
  }, [query, client])

  async function handleStart(targetId: string) {
    const target = targetId.trim()
    if (!target) return
    setError(null)
    setLoading(true)
    try {
      const roomId = await createDM(target)
      await setActiveRoom(roomId)
      onClose()
    } catch (err: any) {
      setError(err?.message ?? 'Failed to open DM')
    } finally {
      setLoading(false)
    }
  }

  const effectiveTarget = selected || query.trim()

  return (
    <div className="modal-overlay" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="modal-card">
        <h2>New Direct Message</h2>
        <div className="form-group">
          <label>Search by name or user ID</label>
          <input
            type="text"
            value={query}
            onChange={e => { setQuery(e.target.value); setSelected('') }}
            onKeyDown={e => { if (e.key === 'Enter' && effectiveTarget) handleStart(effectiveTarget) }}
            placeholder="@user:homeserver.org or display name"
            autoFocus
          />
        </div>
        {searching && (
          <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: '-4px 0 8px' }}>Searching…</p>
        )}
        {results.length > 0 && (
          <div className="dm-search-results">
            {results.map(r => (
              <button
                key={r.user_id}
                className={`dm-search-result${selected === r.user_id ? ' selected' : ''}`}
                onClick={() => setSelected(r.user_id)}
                onDoubleClick={() => handleStart(r.user_id)}
              >
                <span className="dm-search-name">
                  {r.display_name || r.user_id.replace(/^@/, '').split(':')[0]}
                </span>
                <span className="dm-search-id">{r.user_id}</span>
              </button>
            ))}
          </div>
        )}
        {error && <p style={{ color: '#fca5a5', fontSize: 13, margin: '4px 0 0' }}>{error}</p>}
        <div className="modal-actions">
          <button className="btn-secondary" onClick={onClose}>Cancel</button>
          <button
            className="btn-primary"
            style={{ display: 'inline-block', width: 'auto', marginTop: 0 }}
            onClick={() => handleStart(effectiveTarget)}
            disabled={loading || !effectiveTarget}
          >
            {loading ? 'Opening…' : 'Open DM'}
          </button>
        </div>
      </div>
    </div>
  )
}

function loadPinnedRooms(): Set<string> {
  try { return new Set(JSON.parse(localStorage.getItem('vc_pinned_rooms') ?? '[]')) } catch { return new Set() }
}
function savePinnedRooms(ids: Set<string>) {
  localStorage.setItem('vc_pinned_rooms', JSON.stringify([...ids]))
}

export default function ChannelSidebar() {
  const { t } = useTranslation()
  const { state, setActiveRoom, joinRoom, declineInvite } = useMatrix()
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null)
  const [settingsRoom, setSettingsRoom] = useState<Room | null>(null)
  const [showNewDM, setShowNewDM] = useState(false)
  const [showCreateRoom, setShowCreateRoom] = useState(false)
  const [showJoinRoom, setShowJoinRoom] = useState(false)
  const [showDirectory, setShowDirectory] = useState(false)
  const [pinnedRoomIds, setPinnedRoomIds] = useState<Set<string>>(loadPinnedRooms)

  function togglePin(roomId: string) {
    setPinnedRoomIds(prev => {
      const next = new Set(prev)
      if (next.has(roomId)) next.delete(roomId)
      else next.add(roomId)
      savePinnedRooms(next)
      return next
    })
  }

  const activeSpace = state.activeSpaceId
    ? state.spaces.find(s => s.roomId === state.activeSpaceId) ?? null
    : null
  const spaceName = activeSpace ? activeSpace.name ?? 'Space' : 'Home'

  const channels = state.activeSpaceId !== null ? state.rooms : []
  const dms = state.activeSpaceId === null ? state.directRooms : []

  function openContextMenu(e: React.MouseEvent, room: Room) {
    e.preventDefault()
    e.stopPropagation()
    setContextMenu({ room, x: e.clientX, y: e.clientY })
  }

  function openMoreMenu(e: React.MouseEvent, room: Room) {
    e.preventDefault()
    e.stopPropagation()
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
    setContextMenu({ room, x: rect.right + 4, y: rect.top })
  }

  return (
    <>
      <div className="channel-sidebar">
        {/* Banner + Header */}
        {activeSpace && <SpaceBanner space={activeSpace} />}
        <div className="sidebar-header">
          <h2>{spaceName}</h2>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <polyline points="6 9 12 15 18 9" />
          </svg>
        </div>

        {/* Channel list */}
        <div className="channel-list">
          {state.pendingInvites.length > 0 && (
            <div className="invite-section">
              <div className="channel-section-header">{t('sidebar.invites')}</div>
              {state.pendingInvites.map(room => (
                <div key={room.roomId} className="invite-item">
                  <span className="invite-name">{room.name || room.roomId}</span>
                  <div className="invite-actions">
                    <button className="invite-accept" onClick={() => joinRoom(room.roomId)} title={t('sidebar.accept')}>✓</button>
                    <button className="invite-decline" onClick={() => declineInvite(room.roomId)} title={t('sidebar.decline')}>✕</button>
                  </div>
                </div>
              ))}
            </div>
          )}

          {state.activeSpaceId === null && (
            <button className="explore-rooms-btn" onClick={() => setShowDirectory(true)}>
              <ExploreIcon />
              <span>{t('sidebar.explorePublic')}</span>
            </button>
          )}

          {/* Pinned rooms section — shown in home view when any rooms are pinned */}
          {state.activeSpaceId === null && pinnedRoomIds.size > 0 && (() => {
            const allRooms = [...state.rooms, ...state.directRooms]
            const pinned = allRooms.filter(r => pinnedRoomIds.has(r.roomId))
            if (pinned.length === 0) return null
            return (
              <>
                <div className="channel-section-header">{t('sidebar.pinned')}</div>
                {pinned.map(room => {
                  const isActive = state.activeRoomId === room.roomId
                  const name = room.name || room.roomId
                  const isDM = state.directRooms.some(d => d.roomId === room.roomId)
                  const avatarMxc = room.getMxcAvatarUrl() ?? null
                  return (
                    <div
                      key={room.roomId}
                      className={`channel-item${isActive ? ' active' : ''}`}
                      onClick={() => setActiveRoom(room.roomId)}
                      onContextMenu={e => openContextMenu(e, room)}
                    >
                      {isDM ? (
                        <span className="dm-avatar">
                          <MxcAvatar mxcUrl={avatarMxc} size={20} name={name} />
                        </span>
                      ) : (
                        <ChannelGlyph room={room} />
                      )}
                      <span className="channel-name">{name}</span>
                      <button
                        className="pinned-room-unpin"
                        title={t('sidebar.unpin')}
                        onClick={e => { e.stopPropagation(); togglePin(room.roomId) }}
                      >
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                          <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                        </svg>
                      </button>
                    </div>
                  )
                })}
              </>
            )
          })()}

          {channels.length === 0 && dms.length === 0 ? (
            <p className="no-rooms-hint">
              {state.syncState === 'PREPARED' || state.syncState === 'SYNCING'
                ? t('sidebar.noRoomsFound')
                : t('sidebar.loadingRooms')}
            </p>
          ) : (
            <>
              {channels.length > 0 && (
                <>
                  <div className="channel-section-header">
                    {t('sidebar.channels')}
                    <button className="channel-section-add-btn" onClick={() => setShowDirectory(true)} title={t('sidebar.explorePublic')}><ExploreIcon /></button>
                    <button className="channel-section-add-btn" onClick={() => setShowJoinRoom(true)} title={t('sidebar.joinByAddress')}><JoinIcon /></button>
                    <button className="channel-section-add-btn" onClick={() => setShowCreateRoom(true)} title={t('sidebar.createRoom')}><PlusIcon /></button>
                  </div>
                  {channels.map(room => {
                    const isActive = state.activeRoomId === room.roomId
                    const name = room.name || room.roomId
                    const highlights = room.getUnreadNotificationCount(NotificationCountType.Highlight)
                    const total = room.getUnreadNotificationCount(NotificationCountType.Total)
                    return (
                      <div
                        key={room.roomId}
                        className={`channel-item${isActive ? ' active' : ''}${total > 0 && !isActive ? ' has-unread' : ''}${isVoiceChannel(room) ? ' channel-item--voice' : ''}`}
                        onClick={() => setActiveRoom(room.roomId)}
                        onContextMenu={e => openContextMenu(e, room)}
                        title={room.getLiveTimeline().getState(Direction.Forward)
                          ?.getStateEvents('m.room.topic', '')
                          ?.getContent()?.topic ?? ''}
                      >
                        <ChannelGlyph room={room} />
                        <span className="channel-name">{name}</span>
                        {highlights > 0 && !isActive && <span className="unread-badge unread-badge--highlight">{highlights > 99 ? '99+' : highlights}</span>}
                        {highlights === 0 && total > 0 && !isActive && <span className="unread-badge unread-badge--total">{total > 99 ? '99+' : total}</span>}
                        <button
                          className="channel-more-btn"
                          onClick={e => openMoreMenu(e, room)}
                          title={t('sidebar.roomOptions')}
                        >
                          <DotsIcon />
                        </button>
                      </div>
                    )
                  })}
                </>
              )}

              {(dms.length > 0 || state.activeSpaceId === null) && (
                <>
                  <div className="channel-section-header">
                    {t('sidebar.dms')}
                    <button
                      className="channel-section-add-btn"
                      onClick={() => setShowNewDM(true)}
                      title={t('sidebar.newDm')}
                    >
                      <PlusIcon />
                    </button>
                  </div>
                  {dms.map(room => {
                    const isActive = state.activeRoomId === room.roomId
                    const name = room.name || room.roomId
                    const avatarMxc = room.getMxcAvatarUrl() ?? null
                    const highlights = room.getUnreadNotificationCount(NotificationCountType.Highlight)
                    const total = room.getUnreadNotificationCount(NotificationCountType.Total)
                    return (
                      <div
                        key={room.roomId}
                        className={`channel-item${isActive ? ' active' : ''}${total > 0 && !isActive ? ' has-unread' : ''}`}
                        onClick={() => setActiveRoom(room.roomId)}
                        onContextMenu={e => openContextMenu(e, room)}
                      >
                        <span className="dm-avatar">
                          <MxcAvatar mxcUrl={avatarMxc} size={20} name={name} />
                        </span>
                        <span className="channel-name">{name}</span>
                        {highlights > 0 && !isActive && <span className="unread-badge unread-badge--highlight">{highlights > 99 ? '99+' : highlights}</span>}
                        {highlights === 0 && total > 0 && !isActive && <span className="unread-badge unread-badge--total">{total > 99 ? '99+' : total}</span>}
                        <button
                          className="channel-more-btn"
                          onClick={e => openMoreMenu(e, room)}
                          title={t('sidebar.roomOptions')}
                        >
                          <DotsIcon />
                        </button>
                      </div>
                    )
                  })}
                </>
              )}
            </>
          )}
        </div>

        {/* User panel at the bottom */}
        <UserPanel />
      </div>

      {/* Context menu — rendered outside sidebar to avoid overflow clipping */}
      {contextMenu && (
        <RoomContextMenu
          room={contextMenu.room}
          x={contextMenu.x}
          y={contextMenu.y}
          onClose={() => setContextMenu(null)}
          onOpenSettings={() => {
            setSettingsRoom(contextMenu.room)
            setContextMenu(null)
          }}
          isPinned={pinnedRoomIds.has(contextMenu.room.roomId)}
          onTogglePin={() => togglePin(contextMenu.room.roomId)}
        />
      )}

      {settingsRoom && (
        <RoomSettingsModal
          room={settingsRoom}
          onClose={() => setSettingsRoom(null)}
        />
      )}

      {showNewDM && <NewDMModal onClose={() => setShowNewDM(false)} />}
      {showCreateRoom && <CreateRoomModal onClose={() => setShowCreateRoom(false)} />}
      {showJoinRoom && <JoinRoomModal onClose={() => setShowJoinRoom(false)} />}
      {showDirectory && <RoomDirectory onClose={() => setShowDirectory(false)} />}
    </>
  )
}

function DotsIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
      <circle cx="5" cy="12" r="2" />
      <circle cx="12" cy="12" r="2" />
      <circle cx="19" cy="12" r="2" />
    </svg>
  )
}

function PlusIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  )
}

function JoinIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4" />
      <polyline points="10 17 15 12 10 7" />
      <line x1="15" y1="12" x2="3" y2="12" />
    </svg>
  )
}

function ExploreIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10" />
      <polygon points="16.24 7.76 14.12 14.12 7.76 16.24 9.88 9.88 16.24 7.76" />
    </svg>
  )
}
