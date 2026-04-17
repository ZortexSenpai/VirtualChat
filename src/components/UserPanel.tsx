import { useEffect, useState } from 'react'
import { SetPresence } from 'matrix-js-sdk'
import { useMatrix } from '../context/MatrixContext'
import MxcAvatar from './MxcAvatar'
import SettingsModal from './SettingsModal'
import { useTranslation } from '../services/i18n'

const PRESENCES = [
  { value: SetPresence.Online, label: 'Online', cls: 'online' },
  { value: SetPresence.Unavailable, label: 'Idle', cls: 'unavailable' },
  { value: SetPresence.Offline, label: 'Invisible', cls: 'offline' },
]

function StatusModal({ onClose, initialPresence, initialStatusMsg, onSaved }: {
  onClose: () => void
  initialPresence: SetPresence
  initialStatusMsg: string
  onSaved: (presence: SetPresence, statusMsg: string) => void
}) {
  const { setStatus } = useMatrix()
  const [selected, setSelected] = useState<SetPresence>(initialPresence)
  const [statusMsg, setStatusMsg] = useState(initialStatusMsg)
  const [saving, setSaving] = useState(false)

  async function handleSave() {
    setSaving(true)
    try {
      await setStatus(selected, statusMsg || undefined)
      onSaved(selected, statusMsg)
      onClose()
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="modal-overlay" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="modal-card">
        <h2>Set Status</h2>

        <div className="presence-options">
          {PRESENCES.map(p => (
            <div
              key={p.value}
              className={`presence-option ${selected === p.value ? 'selected' : ''}`}
              onClick={() => setSelected(p.value)}
            >
              <div className={`presence-option-dot presence-dot ${p.cls}`} style={{ position: 'static', border: 'none' }} />
              <span className="presence-option-label">{p.label}</span>
            </div>
          ))}
        </div>

        <div className="form-group">
          <label>Custom Status</label>
          <input
            type="text"
            value={statusMsg}
            onChange={e => setStatusMsg(e.target.value)}
            placeholder="What's on your mind?"
            maxLength={128}
          />
        </div>

        <div className="modal-actions">
          <button className="btn-secondary" onClick={onClose}>Cancel</button>
          <button
            className="btn-primary"
            style={{ display: 'inline-block', width: 'auto', marginTop: 0 }}
            onClick={handleSave}
            disabled={saving}
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  )
}

function presenceToSetPresence(p: string): SetPresence {
  if (p === 'online') return SetPresence.Online
  if (p === 'unavailable') return SetPresence.Unavailable
  return SetPresence.Offline
}

export default function UserPanel() {
  const { t } = useTranslation()
  const { state, client, logout } = useMatrix()
  const [showStatusModal, setShowStatusModal] = useState(false)
  const [showSettings, setShowSettings] = useState(false)

  const userId = state.userId ?? ''
  const user = client?.getUser(userId)
  const displayName = user?.displayName || userId.replace(/^@/, '').split(':')[0] || 'Unknown'

  // Use local state for presence so it updates when User.presence events fire.
  // Fall back to localStorage so the chosen status survives until the next server event.
  const [localPresence, setLocalPresence] = useState<string>(
    () => user?.presence || localStorage.getItem('vc_presence') || 'offline'
  )
  const [localStatusMsg, setLocalStatusMsg] = useState<string>(
    () => user?.presenceStatusMsg || localStorage.getItem('vc_status_msg') || ''
  )

  useEffect(() => {
    if (!client) return
    const onPresence = (_: unknown, u: any) => {
      if (u?.userId === userId) {
        setLocalPresence(u.presence ?? 'offline')
        setLocalStatusMsg(u.presenceStatusMsg || '')
      }
    }
    client.on('User.presence' as any, onPresence)
    return () => { client.off('User.presence' as any, onPresence) }
  }, [client, userId])

  // Sync once the User object is populated (presence events may never fire on
  // servers with presence disabled, so useState's initial read can miss it).
  useEffect(() => {
    if (user?.presence) setLocalPresence(user.presence)
    if (user?.presenceStatusMsg) setLocalStatusMsg(user.presenceStatusMsg)
  }, [user?.presence, user?.presenceStatusMsg])

  // User.avatarUrl is only populated from presence events (often disabled).
  // Fall back to room member state which is always populated from m.room.member events.
  let avatarMxc: string | null = user?.avatarUrl ?? null
  if (!avatarMxc && client) {
    for (const room of client.getRooms()) {
      const mxc = room.getMember(userId)?.getMxcAvatarUrl() ?? null
      if (mxc) { avatarMxc = mxc; break }
    }
  }

  const presenceCls =
    localPresence === 'online' ? 'online'
    : localPresence === 'unavailable' ? 'unavailable'
    : 'offline'

  return (
    <>
      <div className="user-panel">
        <div className="user-panel-avatar-wrap">
          <div className="user-panel-avatar">
            <MxcAvatar mxcUrl={avatarMxc} size={32} name={displayName} />
          </div>
          <div className={`presence-dot ${presenceCls}`} />
        </div>

        <div className="user-panel-info" onClick={() => setShowStatusModal(true)} title={t('userPanel.setStatus')}>
          <div className="user-panel-name">{displayName}</div>
          {localStatusMsg && <div className="user-panel-status">{localStatusMsg}</div>}
        </div>

        <div className="user-panel-actions">
          <button
            className="panel-icon-btn"
            title={t('userPanel.settings')}
            onClick={() => setShowSettings(true)}
          >
            ⚙
          </button>
          <button
            className="panel-icon-btn"
            title={t('userPanel.signOut')}
            onClick={() => {
              if (confirm(t('userPanel.signOutConfirm'))) logout()
            }}
          >
            ⏻
          </button>
        </div>
      </div>

      {showStatusModal && (
        <StatusModal
          onClose={() => setShowStatusModal(false)}
          initialPresence={presenceToSetPresence(localPresence)}
          initialStatusMsg={localStatusMsg}
          onSaved={(presence, msg) => {
            setLocalPresence(presence)
            setLocalStatusMsg(msg)
          }}
        />
      )}
      {showSettings && <SettingsModal onClose={() => setShowSettings(false)} />}
    </>
  )
}
