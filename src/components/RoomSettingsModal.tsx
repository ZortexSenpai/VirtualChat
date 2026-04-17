import React, { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Room, Direction } from 'matrix-js-sdk'
import { useMatrix } from '../context/MatrixContext'
import MxcAvatar from './MxcAvatar'
import {
  EMOTES_STATE_TYPE,
  getRoomEmotes,
  uploadEmote,
  setDefaultRoomEmotes,
  type RoomEmote,
} from '../services/emotes'

interface Props {
  room: Room
  onClose: () => void
}

type Tab = 'general' | 'security' | 'notifications' | 'emojis' | 'members'
type NotifLevel = 'all' | 'mentions' | 'mute'

const ROOM_VERSIONS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11']

export default function RoomSettingsModal({ room, onClose }: Props) {
  const { client, state, upgradeRoom, setActiveRoom } = useMatrix()
  const [tab, setTab] = useState<Tab>('general')
  const bodyRef = useRef<HTMLDivElement>(null)

  function switchTab(t: Tab) {
    setTab(t)
    if (bodyRef.current) bodyRef.current.scrollTop = 0
  }

  // ---- General tab ----
  const [name, setName] = useState(room.name)
  const roomState = room.getLiveTimeline().getState(Direction.Forward)
  const [topic, setTopic] = useState(
    roomState?.getStateEvents('m.room.topic', '')?.getContent()?.topic ?? ''
  )
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const [idCopied, setIdCopied] = useState(false)

  // ---- Room avatar ----
  const avatarInputRef = useRef<HTMLInputElement>(null)
  const [avatarUploading, setAvatarUploading] = useState(false)

  // ---- Notifications tab ----
  const [notif, setNotif] = useState<NotifLevel>('mentions')

  // ---- Security tab ----
  const [selectedHistVis, setSelectedHistVis] = useState<string>(
    roomState?.getStateEvents('m.room.history_visibility', '')?.getContent()?.history_visibility ?? 'shared'
  )
  const [selectedJoinRule, setSelectedJoinRule] = useState<string>(
    roomState?.getStateEvents('m.room.join_rules', '')?.getContent()?.join_rule ?? 'invite'
  )
  const [securitySaving, setSecuritySaving] = useState(false)
  const [securitySaved, setSecuritySaved] = useState(false)
  const [securityError, setSecurityError] = useState<string | null>(null)

  // ---- Room upgrade ----
  const currentRoomVersion = (room as any).getVersion?.() ?? (roomState?.getStateEvents('m.room.create', '')?.getContent()?.room_version ?? '1')
  const [upgradeVersion, setUpgradeVersion] = useState('')
  const [upgrading, setUpgrading] = useState(false)
  const [upgradeError, setUpgradeError] = useState<string | null>(null)

  // ---- Leave confirmation ----
  const [confirmLeave, setConfirmLeave] = useState(false)

  const userId = state.userId ?? ''
  const canEdit = roomState?.maySendStateEvent('m.room.name', userId) ?? false
  const canEditSecurity = (roomState?.maySendStateEvent('m.room.history_visibility', userId) ?? false)
    || (roomState?.maySendStateEvent('m.room.join_rules', userId) ?? false)

  const encryptionEvent = roomState?.getStateEvents('m.room.encryption', '')
  const isEncrypted = encryptionEvent != null

  const alias = room.getCanonicalAlias()
  const members = room.getJoinedMembers()

  // Load notification level on mount
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

  // Escape to close
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  async function handleSave() {
    if (!client || !canEdit) return
    setSaving(true)
    setSaveError(null)
    try {
      const origName = room.name
      const origTopic = room.getLiveTimeline().getState(Direction.Forward)?.getStateEvents('m.room.topic', '')?.getContent()?.topic ?? ''
      if (name.trim() && name.trim() !== origName) {
        await client.setRoomName(room.roomId, name.trim())
      }
      if (topic !== origTopic) {
        await (client as any).sendStateEvent(room.roomId, 'm.room.topic', { topic }, '')
      }
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
    } catch (err: any) {
      setSaveError(err?.message ?? 'Failed to save changes')
    } finally {
      setSaving(false)
    }
  }

  async function handleRoomAvatarChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file || !client) return
    setAvatarUploading(true)
    try {
      const uploadResp = await client.uploadContent(file, { type: file.type }) as any
      await (client as any).sendStateEvent(room.roomId, 'm.room.avatar', { url: uploadResp.content_uri }, '')
    } catch (err) {
      console.warn('Failed to upload room avatar:', err)
    } finally {
      setAvatarUploading(false)
      if (e.target) e.target.value = ''
    }
  }

  async function handleSaveSecurity() {
    if (!client) return
    setSecuritySaving(true)
    setSecurityError(null)
    try {
      const origHistVis = roomState?.getStateEvents('m.room.history_visibility', '')?.getContent()?.history_visibility ?? 'shared'
      const origJoinRule = roomState?.getStateEvents('m.room.join_rules', '')?.getContent()?.join_rule ?? 'invite'
      if (selectedHistVis !== origHistVis) {
        await (client as any).sendStateEvent(room.roomId, 'm.room.history_visibility', { history_visibility: selectedHistVis }, '')
      }
      if (selectedJoinRule !== origJoinRule) {
        await (client as any).sendStateEvent(room.roomId, 'm.room.join_rules', { join_rule: selectedJoinRule }, '')
      }
      setSecuritySaved(true)
      setTimeout(() => setSecuritySaved(false), 2000)
    } catch (err: any) {
      setSecurityError(err?.message ?? 'Failed to save security settings')
    } finally {
      setSecuritySaving(false)
    }
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

  async function handleCopyId() {
    await navigator.clipboard.writeText(room.roomId)
    setIdCopied(true)
    setTimeout(() => setIdCopied(false), 1500)
  }

  async function handleLeave() {
    if (!client) return
    try {
      await client.leave(room.roomId)
      onClose()
    } catch (err) {
      console.warn('Leave failed:', err)
    }
  }

  return createPortal(
    <div
      className="room-settings-overlay"
      onClick={e => { if (e.target === e.currentTarget) onClose() }}
    >
      <div className="room-settings-modal">

        {/* ── Header ── */}
        <div className="room-settings-header">
          <div className="room-settings-header-info">
            <div className="room-settings-header-avatar">
              <MxcAvatar mxcUrl={room.getMxcAvatarUrl() ?? null} size={42} name={room.name} />
            </div>
            <div className="room-settings-header-text">
              <div className="room-settings-header-name">{room.name}</div>
              {alias && <div className="room-settings-header-alias">{alias}</div>}
            </div>
          </div>
          <button className="settings-close-btn" onClick={onClose}>✕</button>
        </div>

        {/* ── Tabs ── */}
        <div className="room-settings-tabs">
          {([
            ['general', 'General'],
            ['security', 'Security'],
            ['notifications', 'Notifications'],
            ['emojis', 'Emojis'],
            ['members', `Members (${members.length})`],
          ] as [Tab, string][]).map(([t, label]) => (
            <button
              key={t}
              className={`room-settings-tab${tab === t ? ' active' : ''}`}
              onClick={() => switchTab(t)}
            >
              {label}
            </button>
          ))}
        </div>

        {/* ── Body ── */}
        <div className="room-settings-body" ref={bodyRef}>

          {/* ─── General ─── */}
          {tab === 'general' && (
            <div className="room-settings-section">

              {/* Room avatar */}
              <div className="rs-avatar-row">
                <div
                  className={`rs-avatar-wrap${canEdit ? ' rs-avatar-wrap--editable' : ''}`}
                  onClick={() => canEdit && avatarInputRef.current?.click()}
                  title={canEdit ? 'Change room avatar' : undefined}
                >
                  <MxcAvatar mxcUrl={room.getMxcAvatarUrl() ?? null} size={56} name={room.name} />
                  {canEdit && (
                    <div className="rs-avatar-overlay">
                      {avatarUploading ? '…' : <PencilIcon />}
                    </div>
                  )}
                </div>
                <input
                  ref={avatarInputRef}
                  type="file"
                  accept="image/*"
                  style={{ display: 'none' }}
                  onChange={handleRoomAvatarChange}
                />
                <div className="rs-avatar-hint">
                  {canEdit ? 'Click avatar to change room photo' : 'Room photo'}
                </div>
              </div>

              <div className="rs-field">
                <label className="rs-label">Room name</label>
                <input
                  className="rs-input"
                  value={name}
                  onChange={e => setName(e.target.value)}
                  disabled={!canEdit}
                  placeholder="Room name"
                />
              </div>

              <div className="rs-field">
                <label className="rs-label">Topic</label>
                <textarea
                  className="rs-input rs-textarea"
                  value={topic}
                  onChange={e => setTopic(e.target.value)}
                  disabled={!canEdit}
                  placeholder="Describe this room…"
                  rows={3}
                />
              </div>

              {canEdit && (
                <div className="rs-save-row">
                  {saveError && <span className="rs-save-error">{saveError}</span>}
                  <button
                    className="rs-save-btn"
                    onClick={handleSave}
                    disabled={saving}
                  >
                    {saving ? 'Saving…' : saved ? '✓ Saved' : 'Save changes'}
                  </button>
                </div>
              )}

              <div className="rs-divider" />

              {/* Info grid */}
              <div className="rs-info-grid">
                <div className="rs-info-item">
                  <div className="rs-info-label">Room ID</div>
                  <div className="rs-info-value rs-info-id">
                    <span className="rs-info-id-text">{room.roomId}</span>
                    <button className="rs-copy-btn" onClick={handleCopyId} title="Copy room ID">
                      {idCopied ? <CheckSmIcon /> : <CopyIcon />}
                    </button>
                  </div>
                </div>

                <div className="rs-info-item">
                  <div className="rs-info-label">Members</div>
                  <div className="rs-info-value">{members.length}</div>
                </div>

                <div className="rs-info-item">
                  <div className="rs-info-label">Encryption</div>
                  <div className="rs-info-value">
                    {isEncrypted
                      ? <span className="rs-badge rs-badge--green">Enabled</span>
                      : <span className="rs-badge rs-badge--muted">Not enabled</span>}
                  </div>
                </div>

                {alias && (
                  <div className="rs-info-item">
                    <div className="rs-info-label">Address</div>
                    <div className="rs-info-value rs-info-alias">{alias}</div>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* ─── Security ─── */}
          {tab === 'security' && (
            <div className="room-settings-section">

              <div className="rs-field">
                <label className="rs-label">Who can read history?</label>
                <p className="rs-desc-small">Controls which messages new members can see when they join.</p>
                <div className="rs-notif-list" style={{ marginTop: 10 }}>
                  {([
                    ['world_readable', 'Anyone', 'Anyone can read the full history, including guests and unauthenticated users.'],
                    ['shared', 'Members (current & future)', 'Only joined members can read history from when they joined onwards.'],
                    ['invited', 'Members (since invited)', 'Members see history from when they were invited to the room.'],
                    ['joined', 'Members (since joined)', 'Members only see messages from after the moment they actually joined.'],
                  ] as [string, string, string][]).map(([v, label, desc]) => (
                    <button
                      key={v}
                      className={`rs-notif-option${selectedHistVis === v ? ' active' : ''}${!canEditSecurity ? ' rs-notif-option--disabled' : ''}`}
                      onClick={() => canEditSecurity && setSelectedHistVis(v)}
                      disabled={!canEditSecurity}
                    >
                      <div className="rs-notif-radio">
                        {selectedHistVis === v && <div className="rs-notif-radio-fill" />}
                      </div>
                      <div className="rs-notif-text">
                        <div className="rs-notif-label">{label}</div>
                        <div className="rs-notif-desc">{desc}</div>
                      </div>
                    </button>
                  ))}
                </div>
              </div>

              <div className="rs-field" style={{ marginTop: 24 }}>
                <label className="rs-label">Who can join this room?</label>
                <p className="rs-desc-small">Controls how people can become members of this room.</p>
                <div className="rs-notif-list" style={{ marginTop: 10 }}>
                  {([
                    ['invite', 'Invite only', 'Only people with an invitation can join.'],
                    ['knock', 'Knock', 'People can request to join; room admins can approve or deny.'],
                    ['public', 'Public', 'Anyone can join without an invitation.'],
                  ] as [string, string, string][]).map(([v, label, desc]) => (
                    <button
                      key={v}
                      className={`rs-notif-option${selectedJoinRule === v ? ' active' : ''}${!canEditSecurity ? ' rs-notif-option--disabled' : ''}`}
                      onClick={() => canEditSecurity && setSelectedJoinRule(v)}
                      disabled={!canEditSecurity}
                    >
                      <div className="rs-notif-radio">
                        {selectedJoinRule === v && <div className="rs-notif-radio-fill" />}
                      </div>
                      <div className="rs-notif-text">
                        <div className="rs-notif-label">{label}</div>
                        <div className="rs-notif-desc">{desc}</div>
                      </div>
                    </button>
                  ))}
                </div>
              </div>

              {canEditSecurity ? (
                <div className="rs-save-row">
                  {securityError && <span className="rs-save-error">{securityError}</span>}
                  <button
                    className="rs-save-btn"
                    onClick={handleSaveSecurity}
                    disabled={securitySaving}
                  >
                    {securitySaving ? 'Saving…' : securitySaved ? '✓ Saved' : 'Save changes'}
                  </button>
                </div>
              ) : (
                <p className="rs-no-permission">You don't have permission to change security settings.</p>
              )}

              {/* Room upgrade */}
              <div className="rs-field" style={{ marginTop: 24 }}>
                <label className="rs-label">Room version</label>
                <p className="rs-desc-small">
                  Current version: <strong>{currentRoomVersion}</strong>.
                  Upgrading creates a new room and moves members automatically.
                </p>
                {canEditSecurity && (
                  <div style={{ display: 'flex', gap: 8, marginTop: 10, alignItems: 'center' }}>
                    <select
                      className="rs-select"
                      value={upgradeVersion}
                      onChange={e => setUpgradeVersion(e.target.value)}
                    >
                      <option value="">Select version...</option>
                      {ROOM_VERSIONS.filter(v => v > currentRoomVersion).map(v => (
                        <option key={v} value={v}>Version {v}</option>
                      ))}
                    </select>
                    <button
                      className="rs-save-btn"
                      disabled={!upgradeVersion || upgrading}
                      onClick={async () => {
                        if (!upgradeVersion) return
                        setUpgrading(true)
                        setUpgradeError(null)
                        try {
                          const newRoomId = await upgradeRoom(room.roomId, upgradeVersion)
                          await setActiveRoom(newRoomId)
                          onClose()
                        } catch (err: any) {
                          setUpgradeError(err?.message ?? 'Failed to upgrade room')
                        } finally {
                          setUpgrading(false)
                        }
                      }}
                    >
                      {upgrading ? 'Upgrading…' : 'Upgrade'}
                    </button>
                  </div>
                )}
                {upgradeError && <p className="rs-save-error" style={{ marginTop: 8 }}>{upgradeError}</p>}
              </div>
            </div>
          )}

          {/* ─── Notifications ─── */}
          {tab === 'notifications' && (
            <div className="room-settings-section">
              <p className="rs-desc">
                Choose what notifications you receive from <strong>{room.name}</strong>.
              </p>
              <div className="rs-notif-list">
                {([
                  { level: 'all' as NotifLevel, label: 'All messages', desc: 'You will be notified for every message.' },
                  { level: 'mentions' as NotifLevel, label: 'Mentions & keywords', desc: 'Only notify when you are mentioned or a keyword matches.' },
                  { level: 'mute' as NotifLevel, label: 'Mute', desc: 'No notifications will be sent from this room.' },
                ]).map(({ level, label, desc }) => (
                  <button
                    key={level}
                    className={`rs-notif-option${notif === level ? ' active' : ''}`}
                    onClick={() => handleSetNotif(level)}
                  >
                    <div className="rs-notif-radio">
                      {notif === level && <div className="rs-notif-radio-fill" />}
                    </div>
                    <div className="rs-notif-text">
                      <div className="rs-notif-label">{label}</div>
                      <div className="rs-notif-desc">{desc}</div>
                    </div>
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* ─── Emojis ─── */}
          {tab === 'emojis' && (
            <EmojisTabContent room={room} client={client} />
          )}

          {/* ─── Members ─── */}
          {tab === 'members' && (
            <MembersTabContent room={room} client={client} members={members} />
          )}
        </div>

        {/* ── Footer ── */}
        <div className="room-settings-footer">
          {confirmLeave ? (
            <div className="rs-leave-confirm">
              <span className="rs-leave-confirm-msg">Are you sure you want to leave?</span>
              <button className="rs-leave-cancel" onClick={() => setConfirmLeave(false)}>Cancel</button>
              <button className="rs-leave-confirm-btn" onClick={handleLeave}>Leave</button>
            </div>
          ) : (
            <button className="rs-leave-btn" onClick={() => setConfirmLeave(true)}>
              <LeaveIcon /> Leave room
            </button>
          )}
        </div>
      </div>
    </div>,
    document.body
  )
}

function MembersTabContent({ room, client, members }: { room: Room; client: any; members: ReturnType<Room['getJoinedMembers']> }) {
  const [inviteId, setInviteId] = useState('')
  const [inviting, setInviting] = useState(false)
  const [inviteError, setInviteError] = useState<string | null>(null)

  async function handleInvite() {
    const id = inviteId.trim()
    if (!id || !client) return
    setInviting(true)
    setInviteError(null)
    try {
      await client.invite(room.roomId, id)
      setInviteId('')
    } catch (err: any) {
      setInviteError(err?.message ?? 'Failed to invite user')
    } finally {
      setInviting(false)
    }
  }

  return (
    <div className="room-settings-section">
      <div className="rs-invite-row">
        <input
          className="rs-input"
          type="text"
          placeholder="@user:homeserver.org"
          value={inviteId}
          onChange={e => setInviteId(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') handleInvite() }}
        />
        <button className="rs-save-btn" onClick={handleInvite} disabled={inviting || !inviteId.trim()}>
          {inviting ? '…' : 'Invite'}
        </button>
      </div>
      {inviteError && <p className="rs-save-error" style={{ marginBottom: 8 }}>{inviteError}</p>}
      <div className="rs-member-list">
        {members
          .slice()
          .sort((a, b) => (b.powerLevel ?? 0) - (a.powerLevel ?? 0))
          .map(member => (
            <div key={member.userId} className="rs-member">
              <MxcAvatar
                mxcUrl={member.getMxcAvatarUrl() ?? null}
                size={32}
                name={member.name}
              />
              <div className="rs-member-info">
                <div className="rs-member-name">{member.name}</div>
                <div className="rs-member-id">{member.userId}</div>
              </div>
              {(member.powerLevel ?? 0) >= 50 && (
                <span className={`rs-power-badge${(member.powerLevel ?? 0) >= 100 ? ' admin' : ''}`}>
                  {(member.powerLevel ?? 0) >= 100 ? 'Admin' : 'Mod'}
                </span>
              )}
            </div>
          ))}
      </div>
    </div>
  )
}

function PencilIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
      <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
    </svg>
  )
}

function CopyIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  )
}

function CheckSmIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="20 6 9 17 4 12" />
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

// ---- Emojis (MSC2545 room emote pack) ----

function EmojisTabContent({ room, client }: { room: Room; client: any }) {
  const { state } = useMatrix()
  const roomState = room.getLiveTimeline().getState(Direction.Forward)
  const userId = state.userId ?? ''
  const canEdit = roomState?.maySendStateEvent(EMOTES_STATE_TYPE, userId) ?? false

  // Local copy of the default pack's emotes; synced back to the room on save.
  // We read only the default pack (state_key="") for editing — other packs are shown read-only.
  const [emotes, setEmotes] = useState<RoomEmote[]>(() =>
    getRoomEmotes(room).filter(e => e.pack === 'default' || e.pack === ''),
  )
  const otherPackEmotes = getRoomEmotes(room).filter(e => e.pack !== 'default' && e.pack !== '')

  const [shortcode, setShortcode] = useState('')
  const [pendingFile, setPendingFile] = useState<File | null>(null)
  const [pendingPreview, setPendingPreview] = useState<string | null>(null)
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => () => { if (pendingPreview) URL.revokeObjectURL(pendingPreview) }, [pendingPreview])

  function pickFile() { fileInputRef.current?.click() }

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    if (!file.type.startsWith('image/')) { setError('Please select an image file.'); return }
    setError(null)
    setPendingFile(file)
    if (pendingPreview) URL.revokeObjectURL(pendingPreview)
    setPendingPreview(URL.createObjectURL(file))
    // Suggest a shortcode from the file name if none typed yet.
    if (!shortcode) {
      const base = file.name.replace(/\.[^.]+$/, '').replace(/[^a-zA-Z0-9_+\-]/g, '_').slice(0, 24)
      if (base) setShortcode(base)
    }
  }

  async function persist(next: RoomEmote[]): Promise<boolean> {
    const images: Record<string, { url: string; info?: RoomEmote['info'] }> = {}
    for (const e of next) images[e.shortcode] = { url: e.url, info: e.info }
    try {
      await setDefaultRoomEmotes(client, room.roomId, images)
      return true
    } catch (err: any) {
      setError(err?.message ?? 'Failed to save emojis')
      return false
    }
  }

  async function handleAdd() {
    setError(null)
    const code = shortcode.trim().replace(/^:+|:+$/g, '')
    if (!code) { setError('Shortcode is required.'); return }
    if (!/^[a-zA-Z0-9_+\-.]{1,64}$/.test(code)) {
      setError('Shortcode can only contain letters, numbers, _, +, -, and . (max 64 chars).')
      return
    }
    if (!pendingFile) { setError('Please choose an image.'); return }
    if (emotes.some(e => e.shortcode === code)) { setError('Shortcode already exists — pick another or remove the existing one.'); return }

    setUploading(true)
    try {
      const { url, info } = await uploadEmote(client, pendingFile)
      const next = [...emotes, { shortcode: code, url, info, pack: 'default' }]
      const ok = await persist(next)
      if (!ok) return
      setEmotes(next)
      setShortcode('')
      setPendingFile(null)
      if (pendingPreview) URL.revokeObjectURL(pendingPreview)
      setPendingPreview(null)
    } catch (err: any) {
      setError(err?.message ?? 'Upload failed')
    } finally {
      setUploading(false)
    }
  }

  async function handleRemove(code: string) {
    setError(null)
    const next = emotes.filter(e => e.shortcode !== code)
    const ok = await persist(next)
    if (ok) setEmotes(next)
  }

  return (
    <div className="room-settings-section">
      <p className="rs-desc-small" style={{ marginTop: 0 }}>
        Custom emojis are usable as <code>:shortcode:</code> in messages and as reactions. Members who can send state events can manage this room's emojis.
      </p>

      {canEdit && (
        <div className="rs-field" style={{ marginTop: 8 }}>
          <label className="rs-label">Add a new emoji</label>
          <div className="rs-emoji-add-row">
            <button
              type="button"
              className="rs-emoji-upload"
              onClick={pickFile}
              disabled={uploading}
              title="Choose image"
            >
              {pendingPreview
                ? <img src={pendingPreview} alt="preview" />
                : <span className="rs-emoji-upload-plus">+</span>}
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              style={{ display: 'none' }}
              onChange={handleFileChange}
            />
            <div className="rs-emoji-add-fields">
              <div className="rs-emoji-shortcode-wrap">
                <span className="rs-emoji-shortcode-colon">:</span>
                <input
                  className="rs-input rs-emoji-shortcode-input"
                  type="text"
                  value={shortcode}
                  onChange={e => setShortcode(e.target.value)}
                  placeholder="shortcode"
                  disabled={uploading}
                  maxLength={64}
                />
                <span className="rs-emoji-shortcode-colon">:</span>
              </div>
              <button
                className="rs-save-btn"
                onClick={handleAdd}
                disabled={uploading || !pendingFile || !shortcode.trim()}
                type="button"
              >
                {uploading ? 'Uploading…' : 'Add emoji'}
              </button>
            </div>
          </div>
          {error && <p className="rs-save-error" style={{ marginTop: 8 }}>{error}</p>}
        </div>
      )}

      <div className="rs-field">
        <label className="rs-label">Room emojis ({emotes.length})</label>
        {emotes.length === 0 ? (
          <p className="rs-desc-small">No custom emojis yet.</p>
        ) : (
          <div className="rs-emoji-grid">
            {emotes.map(e => {
              const httpUrl = client?.mxcUrlToHttp(e.url, 96, 96, 'scale', false, true)
              return (
                <div key={e.shortcode} className="rs-emoji-item">
                  {httpUrl
                    ? <img src={httpUrl} alt={e.shortcode} className="rs-emoji-img" />
                    : <div className="rs-emoji-img rs-emoji-img--placeholder">🖼</div>}
                  <div className="rs-emoji-code" title={`:${e.shortcode}:`}>:{e.shortcode}:</div>
                  {canEdit && (
                    <button
                      className="rs-emoji-remove"
                      onClick={() => handleRemove(e.shortcode)}
                      title={`Remove :${e.shortcode}:`}
                      type="button"
                    >
                      ✕
                    </button>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>

      {otherPackEmotes.length > 0 && (
        <div className="rs-field">
          <label className="rs-label">Other packs ({otherPackEmotes.length})</label>
          <p className="rs-desc-small">Emojis from additional packs set up on this room. Manage them from the server's admin tooling.</p>
          <div className="rs-emoji-grid">
            {otherPackEmotes.map(e => {
              const httpUrl = client?.mxcUrlToHttp(e.url, 96, 96, 'scale', false, true)
              return (
                <div key={`${e.pack}-${e.shortcode}`} className="rs-emoji-item rs-emoji-item--readonly">
                  {httpUrl && <img src={httpUrl} alt={e.shortcode} className="rs-emoji-img" />}
                  <div className="rs-emoji-code">:{e.shortcode}:</div>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {!canEdit && (
        <p className="rs-no-permission">You don't have permission to manage this room's emojis.</p>
      )}
    </div>
  )
}
