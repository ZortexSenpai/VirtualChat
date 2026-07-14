import React, { useEffect, useRef, useState } from 'react'
import { Room, Direction, NotificationCountType, RoomStateEvent } from 'matrix-js-sdk'
import { useMatrix } from '../context/MatrixContext'
import UserPanel from './UserPanel'
import MxcAvatar, { useMxcBlobUrl } from './MxcAvatar'
import RoomContextMenu from './RoomContextMenu'
import RoomSettingsModal from './RoomSettingsModal'
import RoomDirectory from './RoomDirectory'
import SpaceLobby from './SpaceLobby'
import { isVoiceChannel } from '../services/roomKind'
import { getRoomAvatarMxc } from '../services/roomAvatar'
import { useTranslation } from '../services/i18n'
import {
  ChannelGroup,
  applyRoomOrder,
  channelGroupScope,
  newGroupId,
  readCollapsedGroups,
  saveCollapsedGroups,
} from '../services/channelGroups'
import { SETTINGS_CHANGED_EVENT, setSetting } from '../services/settingsSync'

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

type DragItem =
  | { kind: 'channel'; roomId: string }
  | { kind: 'group'; groupId: string }

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

function GroupNameModal({ title, initialName, onSubmit, onClose }: {
  title: string
  initialName: string
  onSubmit: (name: string) => void
  onClose: () => void
}) {
  const { t } = useTranslation()
  const [name, setName] = useState(initialName)

  function handleSubmit() {
    const n = name.trim()
    if (!n) return
    onSubmit(n)
    onClose()
  }

  return (
    <div className="modal-overlay" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="modal-card">
        <h2>{title}</h2>
        <div className="form-group">
          <label>{t('sidebar.groupName')}</label>
          <input type="text" value={name} onChange={e => setName(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') handleSubmit() }}
            placeholder={t('sidebar.groupNamePlaceholder')} autoFocus />
        </div>
        <div className="modal-actions">
          <button className="btn-secondary" onClick={onClose}>{t('common.cancel')}</button>
          <button className="btn-primary" style={{ display: 'inline-block', width: 'auto', marginTop: 0 }}
            onClick={handleSubmit} disabled={!name.trim()}>
            {initialName ? t('common.save') : t('common.create')}
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
  setSetting('vc_pinned_rooms', JSON.stringify([...ids]))
}

export default function ChannelSidebar() {
  const { t } = useTranslation()
  const { state, setActiveRoom, joinRoom, declineInvite, setChannelGroups, setChannelOrder } = useMatrix()
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null)
  const [settingsRoom, setSettingsRoom] = useState<Room | null>(null)
  const [showNewDM, setShowNewDM] = useState(false)
  const [showCreateRoom, setShowCreateRoom] = useState(false)
  const [showJoinRoom, setShowJoinRoom] = useState(false)
  const [showDirectory, setShowDirectory] = useState(false)
  const [showSpaceLobby, setShowSpaceLobby] = useState(false)
  const [pinnedRoomIds, setPinnedRoomIds] = useState<Set<string>>(loadPinnedRooms)
  // Create/rename group modal: group=null → create (optionally moving roomId
  // into the new group), group set → rename.
  const [groupModal, setGroupModal] = useState<{ group: ChannelGroup | null; roomId?: string } | null>(null)
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(readCollapsedGroups)
  const [dragItem, setDragItem] = useState<DragItem | null>(null)
  const [dropTarget, setDropTarget] = useState<string | null>(null)

  function togglePin(roomId: string) {
    // Compute outside the updater — savePinnedRooms dispatches a window event,
    // which must not run inside a (pure) state updater.
    const next = new Set(pinnedRoomIds)
    if (next.has(roomId)) next.delete(roomId)
    else next.add(roomId)
    savePinnedRooms(next)
    setPinnedRoomIds(next)
  }

  // Pick up pinned-room changes synced from other devices.
  useEffect(() => {
    const onSettingsChanged = (e: Event) => {
      if ((e as CustomEvent).detail?.key === 'vc_pinned_rooms') {
        setPinnedRoomIds(loadPinnedRooms())
      }
    }
    window.addEventListener(SETTINGS_CHANGED_EVENT, onSettingsChanged)
    return () => window.removeEventListener(SETTINGS_CHANGED_EVENT, onSettingsChanged)
  }, [])

  // ---- Channel groups (scoped to the current space / Home view) ----

  const groups = state.channelGroups[channelGroupScope(state.activeSpaceId)] ?? []

  function saveGroups(next: ChannelGroup[]) {
    setChannelGroups(state.activeSpaceId, next).catch(console.error)
  }

  function createGroup(name: string, initialRoomId?: string) {
    const cleaned = initialRoomId
      ? groups.map(g => ({ ...g, roomIds: g.roomIds.filter(id => id !== initialRoomId) }))
      : groups
    saveGroups([...cleaned, { id: newGroupId(), name, roomIds: initialRoomId ? [initialRoomId] : [] }])
  }

  function renameGroup(groupId: string, name: string) {
    saveGroups(groups.map(g => (g.id === groupId ? { ...g, name } : g)))
  }

  function deleteGroup(groupId: string) {
    saveGroups(groups.filter(g => g.id !== groupId))
  }

  function moveRoomToGroup(roomId: string, groupId: string | null) {
    const cleaned = groups.map(g => ({ ...g, roomIds: g.roomIds.filter(id => id !== roomId) }))
    saveGroups(groupId === null
      ? cleaned
      : cleaned.map(g => (g.id === groupId ? { ...g, roomIds: [...g.roomIds, roomId] } : g)))
  }

  function toggleGroupCollapsed(groupId: string) {
    setCollapsedGroups(prev => {
      const next = new Set(prev)
      if (next.has(groupId)) next.delete(groupId)
      else next.add(groupId)
      saveCollapsedGroups(next)
      return next
    })
  }

  function reorderGroups(sourceId: string, targetId: string) {
    const fromIdx = groups.findIndex(g => g.id === sourceId)
    const toIdx = groups.findIndex(g => g.id === targetId)
    if (fromIdx < 0 || toIdx < 0) return
    const next = [...groups]
    const [moved] = next.splice(fromIdx, 1)
    next.splice(toIdx, 0, moved)
    saveGroups(next)
  }

  function insertRoomInGroup(roomId: string, groupId: string, beforeRoomId: string) {
    const cleaned = groups.map(g => ({ ...g, roomIds: g.roomIds.filter(id => id !== roomId) }))
    saveGroups(cleaned.map(g => {
      if (g.id !== groupId) return g
      const roomIds = [...g.roomIds]
      const idx = roomIds.indexOf(beforeRoomId)
      if (idx < 0) roomIds.push(roomId)
      else roomIds.splice(idx, 0, roomId)
      return { ...g, roomIds }
    }))
  }

  function saveChannelOrder(orderedIds: string[]) {
    setChannelOrder(state.activeSpaceId, orderedIds).catch(console.error)
  }

  /**
   * Place a channel in the ungrouped list: before beforeRoomId, or at the top
   * when beforeRoomId is null. Also removes it from its group if needed.
   */
  function insertRoomInUngrouped(roomId: string, beforeRoomId: string | null) {
    const displayed = ungroupedChannels.map(r => r.roomId)
    const next = displayed.filter(id => id !== roomId)
    const idx = beforeRoomId === null ? 0 : next.indexOf(beforeRoomId)
    next.splice(idx < 0 ? next.length : idx, 0, roomId)
    if (groupedIds.has(roomId)) moveRoomToGroup(roomId, null)
    else if (next.every((id, i) => id === displayed[i])) return // no-op reorder
    saveChannelOrder(next)
  }

  // ---- Drag & drop: channels into/out of groups, groups reordered ----

  function clearDrag() {
    setDragItem(null)
    setDropTarget(null)
  }

  function handleDragStart(e: React.DragEvent, item: DragItem) {
    setDragItem(item)
    e.dataTransfer.effectAllowed = 'move'
    // Firefox requires data to be set for the drag to begin
    try { e.dataTransfer.setData('text/plain', item.kind === 'channel' ? item.roomId : item.groupId) } catch { /* ignore */ }
  }

  function handleDragOver(e: React.DragEvent, targetKey: string, accept: boolean) {
    if (!dragItem || !accept) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    if (dropTarget !== targetKey) setDropTarget(targetKey)
  }

  function handleDragLeave(targetKey: string) {
    if (dropTarget === targetKey) setDropTarget(null)
  }

  /** Channel dropped on a group header appends to it; group dropped on a group header reorders. */
  function handleDropOnGroup(e: React.DragEvent, groupId: string) {
    e.preventDefault()
    const item = dragItem
    clearDrag()
    if (!item) return
    if (item.kind === 'channel') moveRoomToGroup(item.roomId, groupId)
    else if (item.groupId !== groupId) reorderGroups(item.groupId, groupId)
  }

  /** Channel dropped on another channel row: insert before it (ungrouping first if the target is ungrouped). */
  function handleDropOnChannel(e: React.DragEvent, targetRoomId: string, targetGroupId: string | null) {
    e.preventDefault()
    const item = dragItem
    clearDrag()
    if (!item || item.kind !== 'channel' || item.roomId === targetRoomId) return
    if (targetGroupId === null) {
      insertRoomInUngrouped(item.roomId, targetRoomId)
    } else {
      insertRoomInGroup(item.roomId, targetGroupId, targetRoomId)
    }
  }

  /** Channel dropped on the "Channels" section header: move to the top of the ungrouped list. */
  function handleDropOnUngrouped(e: React.DragEvent) {
    e.preventDefault()
    const item = dragItem
    clearDrag()
    if (!item || item.kind !== 'channel') return
    insertRoomInUngrouped(item.roomId, null)
  }

  const activeSpace = state.activeSpaceId
    ? state.spaces.find(s => s.roomId === state.activeSpaceId) ?? null
    : null
  const spaceName = activeSpace ? activeSpace.name ?? 'Space' : 'Home'

  // state.rooms is already filtered correctly by MatrixContext: in Home view it
  // contains all non-space, non-DM joined rooms (so group chats show up here);
  // inside a space it contains that space's child channels.
  const channels = state.rooms
  const dms = state.activeSpaceId === null ? state.directRooms : []

  // Partition channels into user-defined groups. Rooms referenced by a group
  // but no longer in the channel list (left/moved) are simply not rendered;
  // channels in no group render directly under the "Channels" header, in the
  // user's saved order (drag-reorderable).
  const channelById = new Map(channels.map(r => [r.roomId, r]))
  const groupedIds = new Set(groups.flatMap(g => g.roomIds))
  const channelOrder = state.channelOrder[channelGroupScope(state.activeSpaceId)] ?? []
  const ungroupedChannels = applyRoomOrder(channels.filter(r => !groupedIds.has(r.roomId)), channelOrder)
  const groupSections = groups.map(group => ({
    group,
    rooms: group.roomIds
      .map(id => channelById.get(id))
      .filter((r): r is Room => Boolean(r)),
  }))

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

  // Shared row markup for grouped (groupId set) and ungrouped channels.
  function renderChannelRow(room: Room, groupId: string | null = null) {
    const isActive = state.activeRoomId === room.roomId
    const name = room.name || room.roomId
    const highlights = room.getUnreadNotificationCount(NotificationCountType.Highlight)
    const total = room.getUnreadNotificationCount(NotificationCountType.Total)
    const dropKey = `chan:${room.roomId}`
    const isDragging = dragItem?.kind === 'channel' && dragItem.roomId === room.roomId
    const isDropTarget = dropTarget === dropKey && !isDragging
    return (
      <div
        key={room.roomId}
        className={`channel-item${isActive ? ' active' : ''}${total > 0 && !isActive ? ' has-unread' : ''}${isVoiceChannel(room) ? ' channel-item--voice' : ''}${groupId ? ' channel-item--grouped' : ''}${isDragging ? ' dragging' : ''}${isDropTarget ? ' drop-target' : ''}`}
        onClick={() => setActiveRoom(room.roomId)}
        onContextMenu={e => openContextMenu(e, room)}
        title={room.getLiveTimeline().getState(Direction.Forward)
          ?.getStateEvents('m.room.topic', '')
          ?.getContent()?.topic ?? ''}
        draggable
        onDragStart={e => handleDragStart(e, { kind: 'channel', roomId: room.roomId })}
        onDragOver={e => handleDragOver(e, dropKey, dragItem?.kind === 'channel' && dragItem.roomId !== room.roomId)}
        onDragLeave={() => handleDragLeave(dropKey)}
        onDrop={e => handleDropOnChannel(e, room.roomId, groupId)}
        onDragEnd={clearDrag}
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
  }

  return (
    <>
      <div className="channel-sidebar">
        {/* Banner + Header */}
        {activeSpace && <SpaceBanner space={activeSpace} />}
        <div
          className={`sidebar-header${activeSpace ? ' sidebar-header--clickable' : ''}`}
          onClick={activeSpace ? () => setSettingsRoom(activeSpace) : undefined}
          title={activeSpace ? t('sidebar.spaceSettings') : undefined}
        >
          <h2>{spaceName}</h2>
          {activeSpace && (
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06-.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
            </svg>
          )}
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
                  const avatarMxc = getRoomAvatarMxc(room)
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
            <>
              <p className="no-rooms-hint">
                {state.syncState === 'PREPARED' || state.syncState === 'SYNCING'
                  ? t('sidebar.noRoomsFound')
                  : t('sidebar.loadingRooms')}
              </p>
              {state.activeSpaceId !== null && (
                <button className="explore-rooms-btn" onClick={() => setShowSpaceLobby(true)}>
                  <ExploreIcon />
                  <span>Browse channels in this space</span>
                </button>
              )}
              {state.activeSpaceId === null && (
                <button className="explore-rooms-btn" onClick={() => setShowNewDM(true)}>
                  <PlusIcon />
                  <span>{t('sidebar.newDm')}</span>
                </button>
              )}
            </>
          ) : (
            <>
              {(channels.length > 0 || groups.length > 0) && (
                <>
                  <div
                    className={`channel-section-header${dropTarget === 'header:channels' ? ' drop-into' : ''}`}
                    onDragOver={e => handleDragOver(e, 'header:channels', dragItem?.kind === 'channel')}
                    onDragLeave={() => handleDragLeave('header:channels')}
                    onDrop={handleDropOnUngrouped}
                  >
                    {t('sidebar.channels')}
                    {state.activeSpaceId !== null && (
                      <button className="channel-section-add-btn" onClick={() => setShowSpaceLobby(true)} title="Browse channels in this space"><ExploreIcon /></button>
                    )}
                    {state.activeSpaceId === null && (
                      <button className="channel-section-add-btn" onClick={() => setShowDirectory(true)} title={t('sidebar.explorePublic')}><ExploreIcon /></button>
                    )}
                    <button className="channel-section-add-btn" onClick={() => setShowJoinRoom(true)} title={t('sidebar.joinByAddress')}><JoinIcon /></button>
                    <button className="channel-section-add-btn" onClick={() => setShowCreateRoom(true)} title={t('sidebar.createRoom')}><PlusIcon /></button>
                    <button className="channel-section-add-btn" onClick={() => setGroupModal({ group: null })} title={t('sidebar.createGroup')}><FolderPlusIcon /></button>
                  </div>
                  {ungroupedChannels.map(room => renderChannelRow(room))}
                  {groupSections.map(({ group, rooms }) => {
                    const collapsed = collapsedGroups.has(group.id)
                    // Collapsed groups still surface the active channel and
                    // anything unread, so nothing important disappears.
                    const visibleRooms = collapsed
                      ? rooms.filter(r =>
                          r.roomId === state.activeRoomId
                          || r.getUnreadNotificationCount(NotificationCountType.Total) > 0)
                      : rooms
                    const headerKey = `grp:${group.id}`
                    const isGroupDragging = dragItem?.kind === 'group' && dragItem.groupId === group.id
                    const isHeaderTarget = dropTarget === headerKey && !isGroupDragging
                    const headerCls = [
                      'channel-group-header',
                      collapsed ? 'collapsed' : '',
                      isGroupDragging ? 'dragging' : '',
                      // A dragged group shows an insertion bar; a dragged channel highlights the whole header.
                      isHeaderTarget ? (dragItem?.kind === 'group' ? 'drop-target' : 'drop-into') : '',
                    ].filter(Boolean).join(' ')
                    return (
                      <div key={group.id} className="channel-group">
                        <div
                          className={headerCls}
                          onClick={() => toggleGroupCollapsed(group.id)}
                          draggable
                          onDragStart={e => handleDragStart(e, { kind: 'group', groupId: group.id })}
                          onDragOver={e => handleDragOver(e, headerKey,
                            dragItem?.kind === 'channel' || (dragItem?.kind === 'group' && dragItem.groupId !== group.id))}
                          onDragLeave={() => handleDragLeave(headerKey)}
                          onDrop={e => handleDropOnGroup(e, group.id)}
                          onDragEnd={clearDrag}
                        >
                          <ChevronIcon />
                          <span className="channel-group-name">{group.name}</span>
                          <button
                            className="channel-section-add-btn"
                            onClick={e => { e.stopPropagation(); setGroupModal({ group }) }}
                            title={t('sidebar.renameGroup')}
                          >
                            <PencilIcon />
                          </button>
                          <button
                            className="channel-section-add-btn"
                            onClick={e => { e.stopPropagation(); deleteGroup(group.id) }}
                            title={t('sidebar.deleteGroup')}
                          >
                            <TrashIcon />
                          </button>
                        </div>
                        {visibleRooms.map(room => renderChannelRow(room, group.id))}
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
                    const avatarMxc = getRoomAvatarMxc(room)
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
          // Grouping only applies to channels, not DMs.
          groups={channelById.has(contextMenu.room.roomId) ? groups : null}
          currentGroupId={groups.find(g => g.roomIds.includes(contextMenu.room.roomId))?.id ?? null}
          onMoveToGroup={groupId => moveRoomToGroup(contextMenu.room.roomId, groupId)}
          onCreateGroup={() => setGroupModal({ group: null, roomId: contextMenu.room.roomId })}
        />
      )}

      {groupModal && (
        <GroupNameModal
          title={groupModal.group ? t('sidebar.renameGroup') : t('sidebar.createGroup')}
          initialName={groupModal.group?.name ?? ''}
          onSubmit={name => {
            if (groupModal.group) renameGroup(groupModal.group.id, name)
            else createGroup(name, groupModal.roomId)
          }}
          onClose={() => setGroupModal(null)}
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
      {showSpaceLobby && state.activeSpaceId && (
        <SpaceLobby spaceId={state.activeSpaceId} onClose={() => setShowSpaceLobby(false)} />
      )}
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

function FolderPlusIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
      <line x1="12" y1="11" x2="12" y2="17" />
      <line x1="9" y1="14" x2="15" y2="14" />
    </svg>
  )
}

function ChevronIcon() {
  return (
    <svg className="channel-group-chevron" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="6 9 12 15 18 9" />
    </svg>
  )
}

function PencilIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z" />
    </svg>
  )
}

function TrashIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="3 6 5 6 21 6" />
      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
    </svg>
  )
}
