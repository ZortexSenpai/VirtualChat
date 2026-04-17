import React, { useEffect, useRef, useState } from 'react'
import MxcAvatar, { useMxcBlobUrl } from './MxcAvatar'
import { useMatrix } from '../context/MatrixContext'

export interface ProfileInfo {
  userId: string
  displayName: string
  avatarMxc: string | null
  anchorRect: DOMRect
  roomId?: string
  myUserId?: string
}

const ROLES = [
  { label: 'Member', level: 0 },
  { label: 'Moderator', level: 50 },
  { label: 'Admin', level: 100 },
]

export function ProfilePopup({ info, onClose }: { info: ProfileInfo; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  const { state, client, kickMember, setPowerLevel, banMember, ignoreUser, unignoreUser, fetchUserBanner } = useMatrix()

  const [bannerMxc, setBannerMxc] = useState<string | null>(
    info.userId === state.userId ? state.myBannerMxc : null,
  )
  useEffect(() => {
    if (info.userId === state.userId) {
      setBannerMxc(state.myBannerMxc)
      return
    }
    let cancelled = false
    fetchUserBanner(info.userId).then(mxc => { if (!cancelled) setBannerMxc(mxc) })
    return () => { cancelled = true }
  }, [info.userId, state.userId, state.myBannerMxc, fetchUserBanner])

  const bannerHttpUrl = useMxcBlobUrl(bannerMxc, 480, 96)

  const [confirmKick, setConfirmKick] = useState(false)
  const [kickReason, setKickReason] = useState('')
  const [kicking, setKicking] = useState(false)
  const [kickError, setKickError] = useState<string | null>(null)

  const [confirmBan, setConfirmBan] = useState(false)
  const [banReason, setBanReason] = useState('')
  const [banning, setBanning] = useState(false)
  const [banError, setBanError] = useState<string | null>(null)

  const [roleError, setRoleError] = useState<string | null>(null)
  const [savingRole, setSavingRole] = useState(false)
  const [togglingIgnore, setTogglingIgnore] = useState(false)

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [onClose])

  // Derive power level info
  let canKick = false
  let canBan = false
  let canChangeRole = false
  let myPl = 0
  let targetPl = 0

  if (info.roomId && info.myUserId) {
    const room = client?.getRoom(info.roomId)
    if (room) {
      const pl = room.currentState.getStateEvents('m.room.power_levels', '')?.getContent() as any
      const kickPl: number = pl?.kick ?? 50
      const banPl: number = pl?.ban ?? 50
      myPl = room.getMember(info.myUserId)?.powerLevel ?? 0
      targetPl = room.getMember(info.userId)?.powerLevel ?? 0

      if (info.userId !== info.myUserId) {
        canKick = myPl >= kickPl
        canBan = myPl > targetPl && myPl >= banPl
        // Can change role if I outrank the target (can't modify equals or superiors)
        canChangeRole = myPl > targetPl
      }
    }
  }

  const POPUP_WIDTH = 280
  // Reserve space for role + kick + ban sections so the popup doesn't clip off-screen
  const popupH = 160 + (canChangeRole ? 80 : 0) + (canKick ? 60 : 0) + (canBan ? 60 : 0)
  const top = Math.min(info.anchorRect.top, window.innerHeight - popupH - 8)
  const spaceRight = window.innerWidth - info.anchorRect.right
  const left = spaceRight >= POPUP_WIDTH + 16
    ? info.anchorRect.right + 8
    : Math.max(8, info.anchorRect.left - POPUP_WIDTH - 8)

  async function handleKick() {
    if (!info.roomId) return
    setKicking(true)
    setKickError(null)
    try {
      await kickMember(info.roomId, info.userId, kickReason || undefined)
      onClose()
    } catch (err: any) {
      setKickError(err?.message ?? 'Failed to kick user')
    } finally {
      setKicking(false)
    }
  }

  async function handleBan() {
    if (!info.roomId) return
    setBanning(true)
    setBanError(null)
    try {
      await banMember(info.roomId, info.userId, banReason || undefined)
      onClose()
    } catch (err: any) {
      setBanError(err?.message ?? 'Failed to ban user')
    } finally {
      setBanning(false)
    }
  }

  async function handleRoleChange(level: number) {
    if (!info.roomId || level === targetPl) return
    setSavingRole(true)
    setRoleError(null)
    try {
      await setPowerLevel(info.roomId, info.userId, level)
    } catch (err: any) {
      setRoleError(err?.message ?? 'Failed to change role')
    } finally {
      setSavingRole(false)
    }
  }

  const isIgnored = state.ignoredUserIds.includes(info.userId)
  const isSelf = info.userId === state.userId

  async function handleToggleIgnore() {
    setTogglingIgnore(true)
    try {
      if (isIgnored) await unignoreUser(info.userId)
      else await ignoreUser(info.userId)
    } catch { /* ignore errors */ }
    setTogglingIgnore(false)
  }

  // Find the closest named role for the target's current level
  const currentRoleLabel =
    ROLES.find(r => r.level === targetPl)?.label ?? `Level ${targetPl}`

  return (
    <div className="profile-popup" ref={ref} style={{ top, left }}>
      <div
        className="profile-popup-banner"
        style={bannerHttpUrl ? { backgroundImage: `url(${bannerHttpUrl})`, backgroundSize: 'cover', backgroundPosition: 'center' } : undefined}
      />
      <div className="profile-popup-avatar">
        <MxcAvatar mxcUrl={info.avatarMxc} size={64} name={info.displayName} />
      </div>
      <div className="profile-popup-body">
        <div className="profile-popup-name">{info.displayName}</div>
        <div className="profile-popup-id">{info.userId}</div>
      </div>

      {canChangeRole && (
        <div className="profile-popup-section">
          <div className="profile-popup-section-label">Role</div>
          <div className="profile-popup-roles">
            {ROLES.filter(r => r.level <= myPl).map(role => (
              <button
                key={role.level}
                className={`profile-popup-role-btn${targetPl === role.level ? ' active' : ''}`}
                onClick={() => handleRoleChange(role.level)}
                disabled={savingRole || targetPl === role.level}
                title={`Set to ${role.label} (level ${role.level})`}
              >
                {role.label}
              </button>
            ))}
          </div>
          {!ROLES.find(r => r.level === targetPl) && (
            <div className="profile-popup-role-custom">Custom level: {targetPl}</div>
          )}
          {roleError && <p className="profile-popup-role-error">{roleError}</p>}
        </div>
      )}

      {canKick && (
        <div className="profile-popup-actions">
          {confirmKick ? (
            <div className="profile-popup-kick-confirm">
              <input
                className="profile-popup-kick-reason"
                type="text"
                placeholder="Reason (optional)"
                value={kickReason}
                onChange={e => setKickReason(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') handleKick() }}
                autoFocus
              />
              {kickError && <p className="profile-popup-kick-error">{kickError}</p>}
              <div className="profile-popup-kick-btns">
                <button className="profile-popup-kick-cancel" onClick={() => setConfirmKick(false)}>
                  Cancel
                </button>
                <button className="profile-popup-kick-do" onClick={handleKick} disabled={kicking}>
                  {kicking ? 'Kicking…' : 'Kick'}
                </button>
              </div>
            </div>
          ) : (
            <button className="profile-popup-kick-btn" onClick={() => setConfirmKick(true)}>
              <KickIcon /> Kick from room
            </button>
          )}
        </div>
      )}

      {canBan && (
        <div className="profile-popup-actions">
          {confirmBan ? (
            <div className="profile-popup-kick-confirm">
              <input
                className="profile-popup-kick-reason"
                type="text"
                placeholder="Reason (optional)"
                value={banReason}
                onChange={e => setBanReason(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') handleBan() }}
                autoFocus
              />
              {banError && <p className="profile-popup-kick-error">{banError}</p>}
              <div className="profile-popup-kick-btns">
                <button className="profile-popup-kick-cancel" onClick={() => setConfirmBan(false)}>
                  Cancel
                </button>
                <button className="profile-popup-kick-do" onClick={handleBan} disabled={banning}>
                  {banning ? 'Banning…' : 'Ban'}
                </button>
              </div>
            </div>
          ) : (
            <button className="profile-popup-kick-btn" onClick={() => setConfirmBan(true)}>
              <BanIcon /> Ban from room
            </button>
          )}
        </div>
      )}

      {!isSelf && (
        <div className="profile-popup-actions">
          <button
            className={`profile-popup-ignore-btn${isIgnored ? ' active' : ''}`}
            onClick={handleToggleIgnore}
            disabled={togglingIgnore}
          >
            <BlockIcon /> {togglingIgnore ? (isIgnored ? 'Unblocking…' : 'Blocking…') : isIgnored ? 'Unblock user' : 'Block user'}
          </button>
        </div>
      )}
    </div>
  )
}

function KickIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M16 17l5-5-5-5" />
      <path d="M21 12H9" />
      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
    </svg>
  )
}

function BanIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10" />
      <line x1="4.93" y1="4.93" x2="19.07" y2="19.07" />
    </svg>
  )
}

function BlockIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <line x1="18" y1="8" x2="23" y2="13" />
      <line x1="23" y1="8" x2="18" y2="13" />
    </svg>
  )
}
