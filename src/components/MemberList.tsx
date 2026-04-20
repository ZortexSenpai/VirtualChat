import React, { useEffect, useRef, useState } from 'react'
import { RoomMember, RoomStateEvent, ClientEvent } from 'matrix-js-sdk'
import { useMatrix } from '../context/MatrixContext'
import MxcAvatar from './MxcAvatar'
import { ProfilePopup, ProfileInfo } from './ProfilePopup'
import { useTranslation } from '../services/i18n'

/**
 * Lightweight shape used when we fall back to the `/joined_members` REST
 * endpoint. Real `RoomMember` objects are preferred whenever the SDK's
 * room state is populated; this is only a display-time stand-in.
 */
interface DisplayMember {
  userId: string
  name: string
  avatarMxc: string | null
  powerLevel: number
}

function getPresenceCls(presence: string | undefined): string {
  if (presence === 'online') return 'online'
  if (presence === 'unavailable') return 'unavailable'
  return 'offline'
}

function roleLabelForPowerLevel(pl: number): string | null {
  if (pl >= 100) return 'Admin'
  if (pl >= 50) return 'Mod'
  return null
}

function MemberItem({
  member,
  client,
  roomId,
  myUserId,
  onOpenProfile,
}: {
  member: DisplayMember
  client: any
  roomId: string
  myUserId: string
  onOpenProfile: (info: ProfileInfo) => void
}) {
  const user = client?.getUser(member.userId)
  const displayName = member.name || member.userId.replace(/^@/, '').split(':')[0]
  const presence = user?.presence ?? 'offline'
  const statusMsg = user?.presenceStatusMsg ?? ''
  const avatarMxc = member.avatarMxc ?? user?.avatarUrl ?? null

  function handleClick(e: React.MouseEvent) {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
    onOpenProfile({ userId: member.userId, displayName, avatarMxc, anchorRect: rect, roomId, myUserId })
  }

  const roleLabel = roleLabelForPowerLevel(member.powerLevel)

  return (
    <div className="member-item" title={member.userId} onClick={handleClick} style={{ cursor: 'pointer' }}>
      <div className="member-avatar-wrap">
        <div className="member-avatar">
          <MxcAvatar mxcUrl={avatarMxc} size={32} name={displayName} />
        </div>
        <div className={`presence-dot ${getPresenceCls(presence)}`} />
      </div>

      <div className="member-info">
        <div className="member-name">
          {displayName}
          {roleLabel && (
            <span className={`member-role-badge member-role-badge--${roleLabel.toLowerCase()}`}>
              {roleLabel}
            </span>
          )}
        </div>
        {statusMsg && <div className="member-status-text">{statusMsg}</div>}
      </div>
    </div>
  )
}

function toDisplayMembers(list: RoomMember[]): DisplayMember[] {
  return list.map(m => ({
    userId: m.userId,
    name: m.name ?? m.userId,
    avatarMxc: m.getMxcAvatarUrl() ?? null,
    powerLevel: m.powerLevel ?? 0,
  }))
}

export default function MemberList() {
  const { t } = useTranslation()
  const { state, client } = useMatrix()
  const [profile, setProfile] = useState<ProfileInfo | null>(null)
  const [localMembers, setLocalMembers] = useState<DisplayMember[]>([])
  const lastRoomIdRef = useRef<string | null>(null)

  const roomId = state.activeRoomId

  // Keep a local, Room-sourced member list. On page reload, the context's
  // `SET_MEMBERS` dispatch can fire before the Matrix SDK has fully populated
  // the room's member state (or `loadMembersIfNeeded` short-circuits with a
  // partial set). We combine two strategies:
  //
  //   1. Reactive: subscribe to every SDK event that signals member-state
  //      change, re-reading `getJoinedMembers()` each time.
  //   2. Authoritative fallback: hit `/rooms/{roomId}/joined_members` via
  //      `client.getJoinedRoomMembers()` — this returns the full roster
  //      straight from the server without relying on the Room's local cache,
  //      so it always succeeds even if the SDK state is stale.
  useEffect(() => {
    if (!client || !roomId) {
      setLocalMembers([])
      lastRoomIdRef.current = null
      return
    }
    lastRoomIdRef.current = roomId
    let cancelled = false

    const refreshFromSdk = () => {
      if (cancelled) return
      const r = client.getRoom(roomId)
      if (!r) return
      const joined = r.getJoinedMembers()
      if (joined.length > 0) setLocalMembers(toDisplayMembers(joined))
    }

    const refreshFromServer = async () => {
      try {
        const resp: any = await (client as any).getJoinedRoomMembers(roomId)
        if (cancelled) return
        const joined = resp?.joined ?? {}
        const r = client.getRoom(roomId)
        const plContent = r?.currentState?.getStateEvents('m.room.power_levels', '')?.getContent() as any
        const users: Record<string, number> = plContent?.users ?? {}
        const defaultPl: number = plContent?.users_default ?? 0
        const list: DisplayMember[] = Object.entries(joined).map(([userId, info]: [string, any]) => ({
          userId,
          name: info?.display_name || userId.replace(/^@/, '').split(':')[0],
          avatarMxc: info?.avatar_url ?? null,
          powerLevel: users[userId] ?? defaultPl,
        }))
        if (list.length > 0) setLocalMembers(list)
      } catch {
        /* best-effort */
      }
    }

    const kickLoadAndRefresh = () => {
      const r = client.getRoom(roomId)
      if (r) {
        r.loadMembersIfNeeded()
          .then(() => refreshFromSdk())
          .catch(() => { /* fall back to server fetch */ })
      }
      // Always attempt the authoritative server fetch as a fallback.
      refreshFromServer()
    }

    // Initial reads — SDK first (cheap), server second (authoritative).
    refreshFromSdk()
    kickLoadAndRefresh()

    const onMember = (_evt: any, _s: any, member: RoomMember) => {
      if (member.roomId === roomId) refreshFromSdk()
    }
    const onRoomAdded = (room: { roomId: string }) => {
      if (room.roomId === roomId) kickLoadAndRefresh()
    }

    client.on(RoomStateEvent.NewMember, onMember)
    client.on(RoomStateEvent.Members, onMember)
    client.on(ClientEvent.Room, onRoomAdded as any)
    client.on(ClientEvent.Sync, refreshFromSdk as any)

    return () => {
      cancelled = true
      client.off(RoomStateEvent.NewMember, onMember)
      client.off(RoomStateEvent.Members, onMember)
      client.off(ClientEvent.Room, onRoomAdded as any)
      client.off(ClientEvent.Sync, refreshFromSdk as any)
    }
  }, [client, roomId])

  // Prefer the context's SET_MEMBERS list when it has meaningful data (loaded
  // via click-to-switch path) — it uses real RoomMember objects with richer
  // presence data. Otherwise fall back to the locally-fetched list which is
  // guaranteed to populate on reload.
  const contextMembers = state.members.length > 0 && state.activeRoomId === lastRoomIdRef.current
    ? toDisplayMembers(state.members)
    : null
  const members = contextMembers ?? localMembers

  if (!roomId) return null

  const myUserId = state.userId ?? ''

  const online = members.filter(m => {
    const user = client?.getUser(m.userId)
    return user?.presence === 'online'
  })
  const offline = members.filter(m => {
    const user = client?.getUser(m.userId)
    return user?.presence !== 'online'
  })

  return (
    <>
      <div className="member-list">
        {online.length > 0 && (
          <>
            <div className="member-section-header">{t('members.onlineCount', { count: online.length })}</div>
            {online.map(m => (
              <MemberItem key={m.userId} member={m} client={client} roomId={roomId} myUserId={myUserId} onOpenProfile={setProfile} />
            ))}
          </>
        )}

        {offline.length > 0 && (
          <>
            <div className="member-section-header">{t('members.membersCount', { count: offline.length })}</div>
            {offline.map(m => (
              <MemberItem key={m.userId} member={m} client={client} roomId={roomId} myUserId={myUserId} onOpenProfile={setProfile} />
            ))}
          </>
        )}

        {members.length === 0 && (
          <div className="no-rooms-hint">{t('members.loading')}</div>
        )}
      </div>

      {profile && (
        <ProfilePopup info={profile} onClose={() => setProfile(null)} />
      )}
    </>
  )
}
