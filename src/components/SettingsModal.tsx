import React, { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useMatrix } from '../context/MatrixContext'
import { useTranslation, setLocale, LOCALES, type Locale } from '../services/i18n'
import { DARK_THEMES, LIGHT_THEMES, getThemeMode } from '../services/themes'
import type { StickerPack, StickerItem, KeyBackupStatus } from '../context/MatrixContext'
import MxcAvatar, { useMxcBlobUrl } from './MxcAvatar'
import {
  isDesktopNotificationsEnabled,
  setDesktopNotificationsEnabled,
  isNotificationSoundEnabled,
  setNotificationSoundEnabled,
  getNotificationPermission,
  requestNotificationPermission,
  playNotificationSound,
  getNotificationSoundChoice,
  setNotificationSoundChoice,
  previewSound,
  SOUND_PRESETS,
  SoundId,
  getNotificationVolume,
  setNotificationVolume,
  isCallRingEnabled,
  setCallRingEnabled,
  isDndManuallyOn,
  setDndManual,
  isDndScheduleEnabled,
  setDndScheduleEnabled,
  getDndSchedule,
  setDndSchedule,
  isDndAllowMentions,
  setDndAllowMentions,
  isDndActive,
} from '../services/notifications'

type Tab = 'account' | 'appearance' | 'notifications' | 'push-rules' | 'privacy' | 'stickerpacks' | 'devices' | 'security' | 'expert'

interface DeviceEntry {
  deviceId: string
  displayName: string
  // Canonical: device is verified (locally OR via trusted cross-signing chain).
  isVerified: boolean
  // Device has been cross-signed by the account's master key.
  signedByOwner: boolean
  // The account's cross-signing identity is trusted by THIS session.
  ownerTrusted: boolean
  // Device was verified directly from this session (SAS/QR).
  locallyVerified: boolean
  isCurrent: boolean
}

// ---- Devices Tab ----

function DevicesTab() {
  const { t } = useTranslation()
  const { state, client, requestVerification, unlockCrossSigning } = useMatrix()
  const [devices, setDevices] = useState<DeviceEntry[] | null>(null)
  const [sessionTrustsIdentity, setSessionTrustsIdentity] = useState(true)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [verifyingId, setVerifyingId] = useState<string | null>(null)
  const [unlocking, setUnlocking] = useState(false)

  const myUserId = state.userId ?? ''
  const currentDeviceId = client?.getDeviceId() ?? null

  const loadDevices = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const list: DeviceEntry[] = []
      const crypto = client?.getCrypto()

      if (crypto) {
        // Force a fresh pull of both the user's device list AND their
        // cross-signing keys. The rust-crypto store caches aggressively: if
        // the master public key wasn't loaded when the session first synced,
        // device signatures will silently fail to verify (reporting
        // signedByOwner=false), which is exactly what makes everything look
        // "not verified" on reload. The `true` flag forces a server query.
        try { await (crypto as any).userHasCrossSigningKeys?.(myUserId, true) } catch { /* continue */ }

        // Owner-identity trust from this session's perspective.
        let trustsOwnIdentity = false
        let ownerMasterKeyId: string | null = null
        try {
          const uvs: any = await (crypto as any).getUserVerificationStatus?.(myUserId)
          if (uvs) {
            if (typeof uvs.isCrossSigningVerified === 'function') trustsOwnIdentity = !!uvs.isCrossSigningVerified()
            else if (typeof uvs.isVerified === 'function') trustsOwnIdentity = !!uvs.isVerified()
          }
        } catch { /* ignore */ }
        setSessionTrustsIdentity(trustsOwnIdentity)

        // Grab the master public key ID so we can fall back to inspecting raw
        // device signatures when getDeviceVerificationStatus is incomplete.
        try {
          const keys: any = await (crypto as any).getCrossSigningKeyId?.()
          if (typeof keys === 'string') ownerMasterKeyId = keys
        } catch { /* ignore */ }

        const deviceMap = await crypto.getUserDeviceInfo([myUserId], true)
        const ownDevices = deviceMap.get(myUserId)

        if (ownDevices) {
          for (const [deviceId, device] of ownDevices) {
            const verStatus: any = await crypto.getDeviceVerificationStatus(myUserId, deviceId)

            // Resolve SDK naming drift: matrix-js-sdk ≤ v40 uses
            // crossSigningVerified; the wasm binding surfaces
            // crossSigningTrusted. Accept either.
            const sdkSignedByOwner = !!verStatus?.signedByOwner
            const sdkOwnerTrusted = !!(verStatus?.crossSigningVerified ?? verStatus?.crossSigningTrusted)
            const sdkLocallyVerified = !!verStatus?.localVerified

            // Fallback: inspect the device's signatures map directly. If the
            // device carries a signature from the owner's master key, treat it
            // as cross-signed even when getDeviceVerificationStatus says
            // otherwise (which happens when the crypto store hasn't finished
            // resolving trust chains on a fresh session).
            let rawSignedByOwner = false
            try {
              const sigMap: Map<string, Map<string, string>> | undefined = (device as any).signatures
              const mine = sigMap?.get?.(myUserId)
              if (mine && ownerMasterKeyId) {
                rawSignedByOwner = mine.has(`ed25519:${ownerMasterKeyId}`)
              } else if (mine) {
                // Even without a known master key id, multiple signatures from
                // the user typically mean device + master (or device + SSK).
                rawSignedByOwner = mine.size >= 2
              }
            } catch { /* ignore */ }

            const signedByOwnerFlag = sdkSignedByOwner || rawSignedByOwner

            // Canonical verified: locally verified, OR signed-by-owner AND
            // owner identity trusted by this session.
            let canon: boolean
            if (typeof verStatus?.isVerified === 'function') {
              canon = !!verStatus.isVerified()
            } else {
              canon = sdkLocallyVerified || (signedByOwnerFlag && trustsOwnIdentity)
            }
            // If SDK's isVerified() said false but we know the session trusts
            // the identity and the device IS signed by owner, override. This
            // covers the case where isVerified() is wired to the trusted-flag
            // check rather than the session-identity check.
            if (!canon && signedByOwnerFlag && trustsOwnIdentity) canon = true

            // eslint-disable-next-line no-console
            console.info('[devices][device]', deviceId, {
              displayName: device.displayName,
              sdkSignedByOwner,
              sdkOwnerTrusted,
              sdkLocallyVerified,
              rawSignedByOwner,
              trustsOwnIdentity,
              canon,
              verStatus_raw: verStatus,
            })

            list.push({
              deviceId,
              displayName: device.displayName ?? deviceId,
              isVerified: canon,
              signedByOwner: signedByOwnerFlag,
              ownerTrusted: trustsOwnIdentity || sdkOwnerTrusted,
              locallyVerified: sdkLocallyVerified,
              isCurrent: deviceId === currentDeviceId,
            })
          }
        } else {
          // eslint-disable-next-line no-console
          console.warn('[devices] getUserDeviceInfo returned no devices for', myUserId)
        }
      } else {
        // Crypto didn't initialise at startup. Fall through to the HTTP device
        // list so the user at least sees their sessions, but flag that
        // verification status is unavailable.
        setError(t('settings.devices.cryptoInitError'))
        const resp = await client?.getDevices()
        for (const d of resp?.devices ?? []) {
          list.push({
            deviceId: d.device_id,
            displayName: d.display_name ?? d.device_id,
            isVerified: false,
            signedByOwner: false,
            ownerTrusted: false,
            locallyVerified: false,
            isCurrent: d.device_id === currentDeviceId,
          })
        }
      }

      list.sort((a, b) => (a.isCurrent ? -1 : b.isCurrent ? 1 : 0))
      setDevices(list)
    } catch (err: any) {
      setError(err?.message ?? t('settings.devices.loadError'))
    } finally {
      setLoading(false)
    }
  }, [client, myUserId, currentDeviceId])

  useEffect(() => {
    loadDevices()
  }, [loadDevices])

  async function handleVerify(deviceId: string) {
    setVerifyingId(deviceId)
    try {
      await requestVerification(myUserId, deviceId)
    } catch (err: any) {
      setError(err?.message ?? t('settings.devices.startVerifyError'))
      setVerifyingId(null)
    }
  }

  async function handleUnlockWithRecoveryKey() {
    setUnlocking(true)
    setError(null)
    try {
      await unlockCrossSigning()
      await loadDevices()
    } catch (err: any) {
      setError(err?.message ?? t('settings.devices.verifySessionError'))
    } finally {
      setUnlocking(false)
    }
  }

  if (loading) {
    return (
      <div className="settings-loading">
        <div className="spinner" style={{ width: 28, height: 28, borderWidth: 3 }} />
      </div>
    )
  }

  if (error) {
    return (
      <div className="settings-error">
        <p>{error}</p>
        <button className="settings-retry-btn" onClick={loadDevices}>{t('settings.devices.retryButton')}</button>
      </div>
    )
  }

  if (!devices || devices.length === 0) {
    return <p className="settings-empty">{t('settings.devices.noDevices')}</p>
  }

  // Show the banner whenever this session hasn't been cross-signing-verified.
  // Until it is, the SDK reports signedByOwner=false for every device (its
  // signature validator can't trust anything without a trusted master key),
  // which is what makes all devices read "Not verified" instead of the more
  // helpful "Cross-signed" label.
  const showTrustBanner = !sessionTrustsIdentity

  return (
    <div className="settings-device-list">
      <div className="settings-device-toolbar">
        <button className="settings-device-refresh" onClick={loadDevices} type="button" title={t('settings.devices.refreshTooltip')}>
          ↻ {t('settings.devices.refresh')}
        </button>
      </div>
      {showTrustBanner && (
        <div className="settings-device-banner">
          <div className="settings-device-banner-title">{t('settings.devices.notVerifiedBanner')}</div>
          <div className="settings-device-banner-body">{t('settings.devices.notVerifiedExplanation')}</div>
          <button
            className="settings-verify-btn"
            style={{ marginTop: 12 }}
            onClick={handleUnlockWithRecoveryKey}
            disabled={unlocking}
            type="button"
          >
            {unlocking ? t('settings.devices.verifyingLabel') : t('settings.devices.verifyButtonLabel')}
          </button>
        </div>
      )}
      {devices.map(d => (
        <div key={d.deviceId} className={`settings-device-item ${d.isCurrent ? 'current' : ''}`}>
          <div className="settings-device-icon">{d.isCurrent ? '💻' : '📱'}</div>
          <div className="settings-device-info">
            <div className="settings-device-name">
              {d.displayName}
              {d.isCurrent && <span className="settings-device-badge">{t('settings.devices.currentDeviceBadge')}</span>}
            </div>
            <div className="settings-device-meta">
              {d.isVerified ? (
                <span className="settings-device-status verified" title={d.locallyVerified ? t('settings.devices.verifiedLocallyTooltip') : t('settings.devices.verifiedCrossTooltip')}>
                  {t('settings.devices.verifiedLabel')}
                </span>
              ) : d.signedByOwner ? (
                <span className="settings-device-status pending" title={t('settings.devices.crossSignedTooltip')}>
                  {t('settings.devices.crossSignedLabel')}
                </span>
              ) : (
                <span className="settings-device-status unverified">{t('settings.devices.notVerifiedLabel')}</span>
              )}
              <span className="settings-device-id">{d.deviceId}</span>
            </div>
          </div>
          <div className="settings-device-actions">
            {!d.isVerified && !d.isCurrent && (
              <button
                className="settings-verify-btn"
                onClick={() => handleVerify(d.deviceId)}
                disabled={verifyingId !== null}
              >
                {verifyingId === d.deviceId ? t('settings.devices.verifyStarting') : t('settings.devices.verifyAction')}
              </button>
            )}
          </div>
        </div>
      ))}
    </div>
  )
}

// ---- Account Tab ----

function AccountTab() {
  const { t } = useTranslation()
  const { state, client, updateAvatar, updateBanner, removeBanner } = useMatrix()
  const myUserId = state.userId ?? ''
  const user = client?.getUser(myUserId)
  const currentDisplayName = user?.displayName ?? myUserId.replace(/^@/, '').split(':')[0]

  const [displayName, setDisplayName] = useState(currentDisplayName)
  const [savingName, setSavingName] = useState(false)
  const [nameSaved, setNameSaved] = useState(false)
  const [nameError, setNameError] = useState<string | null>(null)
  const [avatarUploading, setAvatarUploading] = useState(false)
  const avatarInputRef = useRef<HTMLInputElement>(null)
  const bannerInputRef = useRef<HTMLInputElement>(null)
  const [bannerBusy, setBannerBusy] = useState(false)
  const [bannerError, setBannerError] = useState<string | null>(null)

  const bannerHttpUrl = useMxcBlobUrl(state.myBannerMxc, 960, 320)

  let avatarMxc: string | null = user?.avatarUrl ?? null
  if (!avatarMxc && client) {
    for (const room of client.getRooms()) {
      const mxc = room.getMember(myUserId)?.getMxcAvatarUrl() ?? null
      if (mxc) { avatarMxc = mxc; break }
    }
  }

  const homeserver = myUserId.includes(':') ? myUserId.split(':').slice(1).join(':') : ''

  async function handleSaveName() {
    if (!client || !displayName.trim()) return
    setSavingName(true)
    setNameError(null)
    try {
      await client.setDisplayName(displayName.trim())
      setNameSaved(true)
      setTimeout(() => setNameSaved(false), 2000)
    } catch (err: any) {
      setNameError(err?.message ?? 'Failed to save display name')
    } finally {
      setSavingName(false)
    }
  }

  async function handleAvatarChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    setAvatarUploading(true)
    try {
      await updateAvatar(file)
    } catch (err) {
      console.warn('Avatar upload failed:', err)
    } finally {
      setAvatarUploading(false)
      if (e.target) e.target.value = ''
    }
  }

  async function handleBannerChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    setBannerBusy(true)
    setBannerError(null)
    try {
      await updateBanner(file)
    } catch (err: any) {
      setBannerError(err?.message ?? 'Failed to update banner')
    } finally {
      setBannerBusy(false)
      if (e.target) e.target.value = ''
    }
  }

  async function handleBannerRemove() {
    setBannerBusy(true)
    setBannerError(null)
    try {
      await removeBanner()
    } catch (err: any) {
      setBannerError(err?.message ?? 'Failed to remove banner')
    } finally {
      setBannerBusy(false)
    }
  }

  return (
    <div className="settings-account">
      <div className="settings-account-header">
        <div
          className="settings-account-avatar settings-account-avatar--clickable"
          onClick={() => avatarInputRef.current?.click()}
          title={t('settings.account.changeAvatarTooltip')}
        >
          <MxcAvatar mxcUrl={avatarMxc} size={64} name={currentDisplayName} />
          <div className="settings-account-avatar-overlay">
            {avatarUploading ? '…' : <PencilIcon />}
          </div>
        </div>
        <input
          ref={avatarInputRef}
          type="file"
          accept="image/*"
          style={{ display: 'none' }}
          onChange={handleAvatarChange}
        />
        <div className="settings-account-info">
          <div className="settings-account-name">{currentDisplayName}</div>
          <div className="settings-account-id">{myUserId}</div>
        </div>
      </div>

      <div className="settings-field-group">
        <div className="settings-subheading">{t('settings.account.profileSection')}</div>
        <div className="settings-edit-field">
          <label className="settings-edit-label">{t('settings.account.bannerLabel')}</label>
          <div
            className="settings-banner-preview"
            onClick={() => { if (!bannerBusy) bannerInputRef.current?.click() }}
            style={bannerHttpUrl ? { backgroundImage: `url(${bannerHttpUrl})` } : undefined}
            title={t('settings.account.bannerClickTooltip')}
          >
            {!bannerHttpUrl && (
              <span className="settings-banner-placeholder">
                {bannerBusy ? t('settings.account.uploadingBanner') : t('settings.account.bannerPlaceholder')}
              </span>
            )}
          </div>
          <input
            ref={bannerInputRef}
            type="file"
            accept="image/*"
            style={{ display: 'none' }}
            onChange={handleBannerChange}
          />
          <div className="settings-banner-actions">
            <button
              className="btn-secondary"
              onClick={() => bannerInputRef.current?.click()}
              disabled={bannerBusy}
            >
              {state.myBannerMxc ? t('settings.account.changeBannerBtn') : t('settings.account.uploadBannerBtn')}
            </button>
            {state.myBannerMxc && (
              <button
                className="btn-secondary"
                onClick={handleBannerRemove}
                disabled={bannerBusy}
              >
                {t('settings.account.removeBannerBtn')}
              </button>
            )}
          </div>
          {bannerError && <div className="settings-field-error">{bannerError}</div>}
        </div>
        <div className="settings-edit-field">
          <label className="settings-edit-label">{t('settings.account.displayNameLabel')}</label>
          <div className="settings-edit-row">
            <input
              className="settings-edit-input"
              value={displayName}
              onChange={e => { setDisplayName(e.target.value); setNameSaved(false) }}
              onKeyDown={e => { if (e.key === 'Enter') handleSaveName() }}
              placeholder={t('settings.account.displayNamePlaceholder')}
              maxLength={100}
            />
            <button
              className="settings-save-btn"
              onClick={handleSaveName}
              disabled={savingName || !displayName.trim() || displayName.trim() === currentDisplayName}
            >
              {savingName ? t('settings.account.savingName') : nameSaved ? t('settings.account.nameSaved') : t('settings.account.saveBtn')}
            </button>
          </div>
          {nameError && <div className="settings-field-error">{nameError}</div>}
        </div>
      </div>

      <div className="settings-field-group">
        <div className="settings-subheading">{t('settings.account.infoSection')}</div>
        <div className="settings-field">
          <span className="settings-field-label">{t('settings.account.userIdLabel')}</span>
          <span className="settings-field-value">{myUserId}</span>
        </div>
        <div className="settings-field">
          <span className="settings-field-label">{t('settings.account.homeserverLabel')}</span>
          <span className="settings-field-value">{homeserver}</span>
        </div>
      </div>
    </div>
  )
}

// ---- Appearance Tab ----

const LAYOUT_IDS = ['default', 'compact', 'bubble'] as const
const SIDENAV_IDS = ['floating', 'classic', 'unified'] as const

function AppearanceTab() {
  const { t, locale } = useTranslation()
  const [theme, setTheme] = useState(() => localStorage.getItem('vc_theme') ?? 'dark')
  const [fontSize, setFontSize] = useState(() => parseInt(localStorage.getItem('vc_font_size') ?? '14', 10))
  const [layout, setLayout] = useState(() => localStorage.getItem('vc_layout') ?? 'default')
  const [sidenav, setSidenav] = useState(() => localStorage.getItem('vc_sidenav') ?? 'floating')
  const [glass, setGlass] = useState(() => (localStorage.getItem('vc_glass') ?? 'on') === 'on')

  function applyTheme(t: string) {
    setTheme(t)
    localStorage.setItem('vc_theme', t)
    document.documentElement.setAttribute('data-theme', t)
    document.documentElement.setAttribute('data-theme-mode', getThemeMode(t))
  }

  function applyFontSize(size: number) {
    setFontSize(size)
    localStorage.setItem('vc_font_size', String(size))
    document.documentElement.style.setProperty('--app-font-size', `${size}px`)
  }

  function applyLayout(l: string) {
    setLayout(l)
    localStorage.setItem('vc_layout', l)
    document.documentElement.setAttribute('data-layout', l)
  }

  function applySidenav(s: string) {
    setSidenav(s)
    localStorage.setItem('vc_sidenav', s)
    document.documentElement.setAttribute('data-sidenav', s)
  }

  function applyGlass(on: boolean) {
    setGlass(on)
    const v = on ? 'on' : 'off'
    localStorage.setItem('vc_glass', v)
    document.documentElement.setAttribute('data-glass', v)
  }

  return (
    <div className="settings-appearance">
      <div className="settings-field-group">
        <div className="settings-subheading">{t('settings.appearance.theme')}</div>

        <div className="settings-theme-group-label">{t('settings.appearance.themeDark')}</div>
        <div className="settings-theme-grid">
          {DARK_THEMES.map(({ id, label, colors }) => {
            const display = t('theme.' + id)
            return (
              <button
                key={id}
                className={`settings-theme-card${theme === id ? ' active' : ''}`}
                onClick={() => applyTheme(id)}
                title={display}
              >
                <div className="settings-theme-preview">
                  <div style={{ flex: 2, background: colors[0] }} />
                  <div style={{ flex: 1, background: colors[1] }} />
                  <div style={{ width: 10, flexShrink: 0, background: colors[2] }} />
                </div>
                <span className="settings-theme-label">{display === 'theme.' + id ? label : display}</span>
              </button>
            )
          })}
        </div>

        <div className="settings-theme-group-label settings-theme-group-label--spaced">
          {t('settings.appearance.themeLight')}
        </div>
        <div className="settings-theme-grid">
          {LIGHT_THEMES.map(({ id, label, colors }) => {
            const display = t('theme.' + id)
            return (
              <button
                key={id}
                className={`settings-theme-card${theme === id ? ' active' : ''}`}
                onClick={() => applyTheme(id)}
                title={display}
              >
                <div className="settings-theme-preview">
                  <div style={{ flex: 2, background: colors[0] }} />
                  <div style={{ flex: 1, background: colors[1] }} />
                  <div style={{ width: 10, flexShrink: 0, background: colors[2] }} />
                </div>
                <span className="settings-theme-label">{display === 'theme.' + id ? label : display}</span>
              </button>
            )
          })}
        </div>
      </div>

      <div className="settings-field-group">
        <div className="settings-subheading">{t('settings.appearance.language')}</div>
        <div className="settings-language-grid">
          {LOCALES.map(({ id, nativeLabel, englishLabel }) => (
            <button
              key={id}
              type="button"
              className={`settings-language-option${locale === id ? ' active' : ''}`}
              onClick={() => setLocale(id as Locale)}
            >
              <span className="settings-language-native">{nativeLabel}</span>
              {nativeLabel !== englishLabel && (
                <span className="settings-language-en">{englishLabel}</span>
              )}
            </button>
          ))}
        </div>
      </div>

      <div className="settings-field-group">
        <div className="settings-subheading">{t('settings.appearance.layout')}</div>
        <div className="settings-layout-options">
          {LAYOUT_IDS.map(id => (
            <button
              key={id}
              className={`settings-layout-option${layout === id ? ' active' : ''}`}
              onClick={() => applyLayout(id)}
            >
              <div className={`settings-layout-preview settings-layout-preview--${id}`}>
                <div className="slp-row"><span className="slp-avatar" /><span className="slp-line slp-w60" /></div>
                <div className="slp-row slp-indent"><span className="slp-line slp-w80" /></div>
                <div className="slp-row slp-indent"><span className="slp-line slp-w40" /></div>
              </div>
              <div className="settings-layout-label">{t(`settings.appearance.layout.${id}`)}</div>
              <div className="settings-layout-desc">{t(`settings.appearance.layout.${id}Desc`)}</div>
            </button>
          ))}
        </div>
      </div>

      <div className="settings-field-group">
        <div className="settings-subheading">{t('settings.appearance.sidebar')}</div>
        <div className="settings-layout-options">
          {SIDENAV_IDS.map(id => (
            <button
              key={id}
              className={`settings-layout-option${sidenav === id ? ' active' : ''}`}
              onClick={() => applySidenav(id)}
            >
              <div className={`settings-sidenav-preview settings-sidenav-preview--${id}`}>
                <span className="ssp-spaces" />
                <span className="ssp-sidebar" />
                <span className="ssp-chat" />
                <span className="ssp-members" />
              </div>
              <div className="settings-layout-label">{t(`settings.sidenav.${id}`)}</div>
              <div className="settings-layout-desc">{t(`settings.sidenav.${id}Desc`)}</div>
            </button>
          ))}
        </div>
      </div>

      <div className="settings-field-group">
        <div className="settings-subheading">{t('settings.appearance.liquidGlass')}</div>
        <div className="settings-toggle-row">
          <div className="settings-toggle-label">
            <div>
              <div className="settings-toggle-title">{t('settings.appearance.liquidGlassTitle')}</div>
              <div className="settings-toggle-desc">{t('settings.appearance.liquidGlassDesc')}</div>
            </div>
            <div
              className={`settings-toggle${glass ? ' on' : ''}`}
              onClick={() => applyGlass(!glass)}
            />
          </div>
        </div>
      </div>

      <div className="settings-field-group">
        <div className="settings-subheading">
          {t('settings.appearance.fontSize')} <span className="settings-font-value">{fontSize}px</span>
        </div>
        <div className="settings-font-row">
          <span className="settings-font-sm">A</span>
          <input
            type="range"
            min={12}
            max={18}
            step={1}
            value={fontSize}
            onChange={e => applyFontSize(Number(e.target.value))}
            className="settings-font-slider"
          />
          <span className="settings-font-lg">A</span>
        </div>
        <div className="settings-font-preview" style={{ fontSize }}>
          {t('settings.appearance.fontPreviewText')}
        </div>
      </div>
    </div>
  )
}

// ---- Notifications Tab ----

function NotificationsTab() {
  const { client } = useMatrix()
  const [level, setLevel] = useState<'all' | 'mentions' | 'mute'>('mentions')
  const [desktopEnabled, setDesktopEnabled] = useState(isDesktopNotificationsEnabled)
  const [soundEnabled, setSoundEnabled] = useState(isNotificationSoundEnabled)
  const [soundChoice, setSoundChoice] = useState<SoundId>(getNotificationSoundChoice)
  const [volume, setVolume] = useState(getNotificationVolume)
  const [ringEnabled, setRingEnabled] = useState(isCallRingEnabled)
  const [permission, setPermission] = useState(getNotificationPermission)

  useEffect(() => {
    if (!client) return
    const rules = (client as any).getPushRules?.()
    const overrides: any[] = rules?.global?.override ?? []
    const master = overrides.find((r: any) => r.rule_id === '.m.rule.master')
    if (master?.enabled) {
      setLevel('mute')
    } else {
      // 'all' if the content rule for all messages is enabled; otherwise 'mentions'
      const contentRules: any[] = rules?.global?.content ?? []
      const allMessages = contentRules.find((r: any) => r.rule_id === '.m.rule.message')
      setLevel(allMessages?.enabled ? 'all' : 'mentions')
    }
  }, [client])

  async function handleSetLevel(l: 'all' | 'mentions' | 'mute') {
    if (!client) return
    setLevel(l)
    try {
      if (l === 'mute') {
        await (client as any).setPushRuleEnabled('global', 'override', '.m.rule.master', true)
      } else {
        await (client as any).setPushRuleEnabled('global', 'override', '.m.rule.master', false)
        if (l === 'all') {
          try {
            await (client as any).setPushRuleEnabled('global', 'content', '.m.rule.message', true)
          } catch {}
        } else {
          try {
            await (client as any).setPushRuleEnabled('global', 'content', '.m.rule.message', false)
          } catch {}
        }
      }
    } catch (err) {
      console.warn('Failed to update global notification rules:', err)
    }
  }

  function handleToggleDesktop(val: boolean) {
    if (val && permission !== 'granted') {
      requestNotificationPermission().then(result => {
        setPermission(result)
        if (result === 'granted') {
          setDesktopEnabled(true)
          setDesktopNotificationsEnabled(true)
        }
      })
      return
    }
    setDesktopEnabled(val)
    setDesktopNotificationsEnabled(val)
  }

  function handleToggleSound(val: boolean) {
    setSoundEnabled(val)
    setNotificationSoundEnabled(val)
    if (val) playNotificationSound(soundChoice)
  }

  async function handleRequestPermission() {
    const result = await requestNotificationPermission()
    setPermission(result)
    if (result === 'granted' && !desktopEnabled) {
      setDesktopEnabled(true)
      setDesktopNotificationsEnabled(true)
    }
  }

  const options = [
    { l: 'all' as const, label: 'All messages', desc: 'Get notified for every message in any room.' },
    { l: 'mentions' as const, label: 'Mentions & keywords', desc: 'Only notify when you are mentioned or a keyword matches.' },
    { l: 'mute' as const, label: 'Mute all', desc: 'Suppress all notifications. Per-room settings are ignored.' },
  ]

  const notificationsSupported = 'Notification' in window

  return (
    <div className="settings-notif">
      <div className="settings-field-group">
        <div className="settings-subheading">Push Rules</div>
        <p className="settings-description">
          Set your default notification level. Per-room overrides take precedence where configured.
        </p>
        <div className="settings-notif-list">
          {options.map(({ l, label, desc }) => (
            <button
              key={l}
              className={`settings-notif-option${level === l ? ' active' : ''}`}
              onClick={() => handleSetLevel(l)}
            >
              <div className="settings-notif-radio">
                {level === l && <div className="settings-notif-radio-fill" />}
              </div>
              <div>
                <div className="settings-notif-label">{label}</div>
                <div className="settings-notif-desc">{desc}</div>
              </div>
            </button>
          ))}
        </div>
      </div>

      <div className="settings-field-group">
        <div className="settings-subheading">Desktop Notifications</div>
        {!notificationsSupported ? (
          <p className="settings-description">Your browser does not support desktop notifications.</p>
        ) : (
          <>
            <div className="settings-toggle-row">
              <div className="settings-toggle-label">
                <div>
                  <div className="settings-toggle-title">Enable desktop notifications</div>
                  <div className="settings-toggle-desc">
                    Show system notifications for new messages when the window is not focused.
                  </div>
                </div>
                <div
                  className={`settings-toggle${desktopEnabled && permission === 'granted' ? ' on' : ''}`}
                  onClick={() => handleToggleDesktop(!desktopEnabled)}
                />
              </div>
            </div>
            {permission === 'denied' && (
              <p className="settings-notif-warning">
                Notifications are blocked by your browser. Allow them in your browser's site settings to enable this feature.
              </p>
            )}
            {permission === 'default' && desktopEnabled && (
              <button className="settings-notif-permission-btn" onClick={handleRequestPermission}>
                Allow notifications
              </button>
            )}
          </>
        )}
      </div>

      <div className="settings-field-group">
        <div className="settings-subheading">Sound</div>
        <div className="settings-toggle-row">
          <div className="settings-toggle-label">
            <div>
              <div className="settings-toggle-title">Notification sound</div>
              <div className="settings-toggle-desc">
                Play a sound when a notification is received. Toggling on will preview the sound.
              </div>
            </div>
            <div
              className={`settings-toggle${soundEnabled ? ' on' : ''}`}
              onClick={() => handleToggleSound(!soundEnabled)}
            />
          </div>
        </div>

        {soundEnabled && (
          <div className="settings-sound-picker">
            <div className="settings-sound-picker-label">
              Volume <span className="settings-font-value">{Math.round(volume * 100)}%</span>
            </div>
            <div className="settings-font-row">
              <input
                type="range"
                min={0}
                max={100}
                step={1}
                value={Math.round(volume * 100)}
                onChange={e => {
                  const next = Number(e.target.value) / 100
                  setVolume(next)
                  setNotificationVolume(next)
                }}
                onMouseUp={() => previewSound(soundChoice)}
                onTouchEnd={() => previewSound(soundChoice)}
                onKeyUp={() => previewSound(soundChoice)}
                className="settings-font-slider"
              />
            </div>
            <div className="settings-sound-picker-label">Sound</div>
            <div className="settings-sound-list">
              {SOUND_PRESETS.map(preset => (
                <button
                  key={preset.id}
                  type="button"
                  className={`settings-sound-option${soundChoice === preset.id ? ' active' : ''}`}
                  onClick={() => {
                    setSoundChoice(preset.id)
                    setNotificationSoundChoice(preset.id)
                    previewSound(preset.id)
                  }}
                >
                  <div className="settings-notif-radio">
                    {soundChoice === preset.id && <div className="settings-notif-radio-fill" />}
                  </div>
                  <div className="settings-sound-option-text">
                    <div className="settings-sound-option-label">{preset.label}</div>
                    <div className="settings-sound-option-desc">{preset.desc}</div>
                  </div>
                  <button
                    type="button"
                    className="settings-sound-preview-btn"
                    onClick={e => { e.stopPropagation(); previewSound(preset.id) }}
                    title={`Preview ${preset.label}`}
                  >
                    ▶
                  </button>
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="settings-toggle-row" style={{ marginTop: 12 }}>
          <div className="settings-toggle-label">
            <div>
              <div className="settings-toggle-title">Incoming call ringtone</div>
              <div className="settings-toggle-desc">
                Ring until you answer or decline an incoming voice/video call.
              </div>
            </div>
            <div
              className={`settings-toggle${ringEnabled ? ' on' : ''}`}
              onClick={() => {
                const next = !ringEnabled
                setRingEnabled(next)
                setCallRingEnabled(next)
              }}
            />
          </div>
        </div>
      </div>

      <DndSection />

      <KeywordsSection />

      <PushersSection />
    </div>
  )
}

// ---- Do Not Disturb section ----

function DndSection() {
  const [manual, setManual] = useState(isDndManuallyOn)
  const [scheduleOn, setScheduleOn] = useState(isDndScheduleEnabled)
  const [startHHMM, setStartHHMM] = useState(() => getDndSchedule().startHHMM)
  const [endHHMM, setEndHHMM] = useState(() => getDndSchedule().endHHMM)
  const [allowMentions, setAllowMentions] = useState(isDndAllowMentions)

  // Re-compute "active" label every minute so the scheduled indicator stays current
  // even when the user leaves the settings tab open.
  const [, setTick] = useState(0)
  useEffect(() => {
    const timer = window.setInterval(() => setTick(t => t + 1), 60_000)
    return () => window.clearInterval(timer)
  }, [])

  function toggleManual() {
    const next = !manual
    setManual(next)
    setDndManual(next)
  }

  function toggleSchedule() {
    const next = !scheduleOn
    setScheduleOn(next)
    setDndScheduleEnabled(next)
  }

  function toggleAllowMentions() {
    const next = !allowMentions
    setAllowMentions(next)
    setDndAllowMentions(next)
  }

  function onTimeChange(which: 'start' | 'end', value: string) {
    if (which === 'start') setStartHHMM(value)
    else setEndHHMM(value)
    setDndSchedule({ startHHMM: which === 'start' ? value : startHHMM, endHHMM: which === 'end' ? value : endHHMM })
  }

  const active = isDndActive()

  return (
    <div className="settings-field-group">
      <div className="settings-subheading">
        Do Not Disturb {active && <span className="settings-dnd-pill">Active now</span>}
      </div>
      <p className="settings-description">
        Silence notifications globally. When DND is active, desktop notifications and sounds are suppressed — optionally except for mentions.
      </p>

      <div className="settings-toggle-row">
        <div className="settings-toggle-label">
          <div>
            <div className="settings-toggle-title">Enable Do Not Disturb</div>
            <div className="settings-toggle-desc">Silences all notifications until you turn it off.</div>
          </div>
          <div className={`settings-toggle${manual ? ' on' : ''}`} onClick={toggleManual} />
        </div>
      </div>

      <div className="settings-toggle-row">
        <div className="settings-toggle-label">
          <div>
            <div className="settings-toggle-title">Scheduled DND</div>
            <div className="settings-toggle-desc">Automatically turn DND on during these hours each day. Overnight ranges are supported (e.g. 22:00 – 08:00).</div>
          </div>
          <div className={`settings-toggle${scheduleOn ? ' on' : ''}`} onClick={toggleSchedule} />
        </div>
      </div>

      {scheduleOn && (
        <div className="settings-dnd-schedule">
          <label className="settings-dnd-time">
            <span>From</span>
            <input
              type="time"
              value={startHHMM}
              onChange={e => onTimeChange('start', e.target.value)}
            />
          </label>
          <label className="settings-dnd-time">
            <span>To</span>
            <input
              type="time"
              value={endHHMM}
              onChange={e => onTimeChange('end', e.target.value)}
            />
          </label>
        </div>
      )}

      <div className="settings-toggle-row">
        <div className="settings-toggle-label">
          <div>
            <div className="settings-toggle-title">Let mentions & keywords through</div>
            <div className="settings-toggle-desc">Still notify for direct mentions and keyword matches even when DND is active.</div>
          </div>
          <div className={`settings-toggle${allowMentions ? ' on' : ''}`} onClick={toggleAllowMentions} />
        </div>
      </div>
    </div>
  )
}

// ---- Keyword push rules ----
//
// Matrix supports user-defined "content" push rules — they match on message
// body text. Element, Cinny and FluffyChat all expose this as "keywords".
// Each keyword is saved as a content rule with the pattern = keyword.

interface KeywordRule { ruleId: string; pattern: string; enabled: boolean }

function KeywordsSection() {
  const { client } = useMatrix()
  const [keywords, setKeywords] = useState<KeywordRule[]>([])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  function refresh() {
    if (!client) { setKeywords([]); return }
    const rules = (client as any).getPushRules?.()
    const content: any[] = rules?.global?.content ?? []
    // User-created content rules. Server-default rules (.m.rule.*) are excluded.
    const user = content
      .filter(r => typeof r?.rule_id === 'string' && !r.rule_id.startsWith('.'))
      .map(r => ({ ruleId: r.rule_id as string, pattern: (r.pattern as string) ?? r.rule_id, enabled: !!r.enabled }))
    setKeywords(user)
  }

  useEffect(() => {
    refresh()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client])

  async function addKeyword() {
    setError(null)
    const keyword = input.trim()
    if (!keyword) return
    if (keywords.some(k => k.pattern.toLowerCase() === keyword.toLowerCase())) {
      setError('That keyword is already in your list.')
      return
    }
    if (!client) return
    setBusy(true)
    try {
      // Rule ID = keyword for human readability; the spec disallows leading dot (server-reserved),
      // so we strip any and fall back to a safe id if the keyword is purely dots.
      const ruleId = keyword.replace(/^\.+/, '') || `kw-${Date.now()}`
      await (client as any).addPushRule('global', 'content', ruleId, {
        pattern: keyword,
        actions: ['notify', { set_tweak: 'highlight' }, { set_tweak: 'sound', value: 'default' }],
      })
      // Refresh the local view. matrix-js-sdk updates its cached push rules via sync,
      // so the new rule may not appear in getPushRules() immediately — merge it in optimistically.
      setKeywords(prev => [...prev, { ruleId, pattern: keyword, enabled: true }])
      setInput('')
    } catch (err: any) {
      setError(err?.message ?? 'Failed to add keyword')
    } finally {
      setBusy(false)
    }
  }

  async function removeKeyword(rule: KeywordRule) {
    if (!client) return
    setError(null)
    setBusy(true)
    try {
      await (client as any).deletePushRule('global', 'content', rule.ruleId)
      setKeywords(prev => prev.filter(k => k.ruleId !== rule.ruleId))
    } catch (err: any) {
      setError(err?.message ?? 'Failed to remove keyword')
    } finally {
      setBusy(false)
    }
  }

  async function toggleKeyword(rule: KeywordRule) {
    if (!client) return
    setError(null)
    try {
      await (client as any).setPushRuleEnabled('global', 'content', rule.ruleId, !rule.enabled)
      setKeywords(prev => prev.map(k => k.ruleId === rule.ruleId ? { ...k, enabled: !rule.enabled } : k))
    } catch (err: any) {
      setError(err?.message ?? 'Failed to update keyword')
    }
  }

  return (
    <div className="settings-field-group">
      <div className="settings-subheading">Keywords</div>
      <p className="settings-description">
        Get a highlighted notification whenever a message contains one of your keywords — works across all rooms that aren't muted.
      </p>

      <div className="settings-keyword-add">
        <input
          className="settings-keyword-input"
          type="text"
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') addKeyword() }}
          placeholder="Add a keyword…"
          disabled={busy || !client}
          maxLength={128}
        />
        <button
          className="btn-primary"
          style={{ display: 'inline-block', width: 'auto', marginTop: 0 }}
          onClick={addKeyword}
          disabled={busy || !input.trim() || !client}
          type="button"
        >
          Add
        </button>
      </div>

      {error && <p className="settings-notif-warning" style={{ marginTop: 8 }}>{error}</p>}

      {keywords.length > 0 ? (
        <div className="settings-keyword-list">
          {keywords.map(k => (
            <div key={k.ruleId} className={`settings-keyword-chip${k.enabled ? '' : ' disabled'}`}>
              <span className="settings-keyword-text" title={k.pattern}>{k.pattern}</span>
              <button
                className="settings-keyword-toggle"
                onClick={() => toggleKeyword(k)}
                title={k.enabled ? 'Disable' : 'Enable'}
                type="button"
              >
                {k.enabled ? 'On' : 'Off'}
              </button>
              <button
                className="settings-keyword-remove"
                onClick={() => removeKeyword(k)}
                title={`Remove "${k.pattern}"`}
                type="button"
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      ) : (
        <p className="settings-description" style={{ marginTop: 8, marginBottom: 0, fontStyle: 'italic' }}>
          No keywords yet.
        </p>
      )}
    </div>
  )
}

// ---- Mobile Push (Sygnal / UnifiedPush) ----

type Pusher = {
  app_id: string
  pushkey: string
  app_display_name?: string
  device_display_name?: string
  kind?: string
  data?: { url?: string; format?: string; brand?: string }
}

type PushPresetId = 'unifiedpush' | 'sygnal' | 'custom'

const PUSH_PRESETS: Array<{
  id: PushPresetId
  label: string
  desc: string
  defaults: Partial<{ appId: string; appDisplayName: string; deviceDisplayName: string }>
}> = [
  {
    id: 'unifiedpush',
    label: 'UnifiedPush',
    desc: 'Push via a UnifiedPush distributor + Matrix-compatible gateway. Paste the endpoint from your distributor as the Push Key.',
    defaults: {
      appId: 'org.unifiedpush.default',
      appDisplayName: 'VirtualChat (UnifiedPush)',
      deviceDisplayName: 'VirtualChat Mobile',
    },
  },
  {
    id: 'sygnal',
    label: 'Sygnal',
    desc: 'Matrix reference push gateway (APNs / FCM). Uses the device token as Push Key and the Sygnal /notify endpoint.',
    defaults: {
      appId: 'org.virtualchat.web',
      appDisplayName: 'VirtualChat',
      deviceDisplayName: 'VirtualChat Mobile',
    },
  },
  {
    id: 'custom',
    label: 'Custom',
    desc: 'Point at any Matrix-compatible HTTP push gateway.',
    defaults: {},
  },
]

function PushersSection() {
  const { client } = useMatrix()
  const [pushers, setPushers] = useState<Pusher[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [showForm, setShowForm] = useState(false)

  const [preset, setPreset] = useState<PushPresetId>('unifiedpush')
  const [gatewayUrl, setGatewayUrl] = useState('')
  const [pushkey, setPushkey] = useState('')
  const [appId, setAppId] = useState('')
  const [appDisplayName, setAppDisplayName] = useState('')
  const [deviceDisplayName, setDeviceDisplayName] = useState('')

  const refresh = useCallback(async () => {
    if (!client) return
    setLoading(true)
    try {
      const res = await (client as any).getPushers()
      setPushers(Array.isArray(res?.pushers) ? res.pushers : [])
      setError(null)
    } catch (err: any) {
      setError(err?.message ?? 'Failed to load pushers')
    } finally {
      setLoading(false)
    }
  }, [client])

  useEffect(() => {
    refresh()
  }, [refresh])

  function applyPreset(id: PushPresetId) {
    setPreset(id)
    const p = PUSH_PRESETS.find(x => x.id === id)
    if (!p) return
    if (p.defaults.appId !== undefined) setAppId(p.defaults.appId)
    if (p.defaults.appDisplayName !== undefined) setAppDisplayName(p.defaults.appDisplayName)
    if (p.defaults.deviceDisplayName !== undefined) setDeviceDisplayName(p.defaults.deviceDisplayName)
  }

  function openForm() {
    setGatewayUrl('')
    setPushkey('')
    setError(null)
    applyPreset('unifiedpush')
    setShowForm(true)
  }

  function closeForm() {
    setShowForm(false)
    setError(null)
  }

  async function submit() {
    if (!client) return
    const gw = gatewayUrl.trim()
    const pk = pushkey.trim()
    const aid = appId.trim()
    if (!gw || !pk || !aid) {
      setError('Gateway URL, Push Key and App ID are required.')
      return
    }
    if (!/^https?:\/\//i.test(gw)) {
      setError('Gateway URL must start with http:// or https://')
      return
    }
    setBusy(true)
    setError(null)
    try {
      await (client as any).setPusher({
        kind: 'http',
        app_id: aid,
        pushkey: pk,
        app_display_name: appDisplayName.trim() || 'VirtualChat',
        device_display_name: deviceDisplayName.trim() || 'Mobile device',
        lang: 'en',
        data: { url: gw, format: 'event_id_only' },
        append: false,
      })
      setShowForm(false)
      await refresh()
    } catch (err: any) {
      const msg = err?.errcode ? `${err.errcode}: ${err.error ?? err.message ?? ''}` : (err?.message ?? 'Failed to register pusher')
      setError(msg.trim())
    } finally {
      setBusy(false)
    }
  }

  async function remove(p: Pusher) {
    if (!client) return
    const label = p.device_display_name || p.app_display_name || p.pushkey
    if (!confirm(`Remove pusher "${label}"?`)) return
    setBusy(true)
    setError(null)
    try {
      await (client as any).removePusher(p.pushkey, p.app_id)
      setPushers(prev => prev.filter(x => !(x.pushkey === p.pushkey && x.app_id === p.app_id)))
    } catch (err: any) {
      setError(err?.message ?? 'Failed to remove pusher')
    } finally {
      setBusy(false)
    }
  }

  const activePreset = PUSH_PRESETS.find(p => p.id === preset)

  return (
    <div className="settings-field-group">
      <div className="settings-subheading">Mobile Push</div>
      <p className="settings-description">
        Register a Matrix push gateway (Sygnal or UnifiedPush) so mobile devices on this account keep receiving notifications when the web app is closed.
      </p>

      {loading ? (
        <p className="settings-description" style={{ fontStyle: 'italic', marginTop: 8 }}>Loading pushers…</p>
      ) : pushers.length === 0 ? (
        <p className="settings-description" style={{ fontStyle: 'italic', marginTop: 8, marginBottom: 8 }}>
          No push gateways registered.
        </p>
      ) : (
        <div className="settings-pusher-list">
          {pushers.map(p => (
            <div key={`${p.app_id}:${p.pushkey}`} className="settings-pusher-row">
              <div className="settings-pusher-main">
                <div className="settings-pusher-title">{p.device_display_name || p.app_display_name || 'Unnamed pusher'}</div>
                <div className="settings-pusher-meta">
                  <span title="App ID">{p.app_id}</span>
                  {p.data?.url && <span title="Gateway URL"> • {p.data.url}</span>}
                </div>
                <div className="settings-pusher-key" title={p.pushkey}>
                  {p.pushkey.length > 68 ? `${p.pushkey.slice(0, 65)}…` : p.pushkey}
                </div>
              </div>
              <button
                className="settings-pusher-remove"
                onClick={() => remove(p)}
                disabled={busy}
                type="button"
              >
                Remove
              </button>
            </div>
          ))}
        </div>
      )}

      {!showForm ? (
        <button
          className="settings-save-btn"
          onClick={openForm}
          type="button"
          style={{ marginTop: 8 }}
          disabled={!client}
        >
          Register push gateway
        </button>
      ) : (
        <div className="settings-pusher-form">
          <div className="settings-pusher-presets">
            {PUSH_PRESETS.map(p => (
              <button
                key={p.id}
                type="button"
                className={`settings-pusher-preset${preset === p.id ? ' active' : ''}`}
                onClick={() => applyPreset(p.id)}
              >
                {p.label}
              </button>
            ))}
          </div>
          {activePreset && (
            <p className="settings-description" style={{ marginTop: 4 }}>{activePreset.desc}</p>
          )}

          <label className="settings-pusher-field">
            <span>Gateway URL</span>
            <input
              className="settings-edit-input"
              value={gatewayUrl}
              onChange={e => setGatewayUrl(e.target.value)}
              placeholder="https://sygnal.example.org/_matrix/push/v1/notify"
              autoComplete="off"
              spellCheck={false}
            />
          </label>

          <label className="settings-pusher-field">
            <span>Push Key</span>
            <input
              className="settings-edit-input"
              value={pushkey}
              onChange={e => setPushkey(e.target.value)}
              placeholder={preset === 'unifiedpush' ? 'https://distributor.example.org/UP?token=…' : 'Device push token / endpoint'}
              autoComplete="off"
              spellCheck={false}
            />
          </label>

          <label className="settings-pusher-field">
            <span>App ID</span>
            <input
              className="settings-edit-input"
              value={appId}
              onChange={e => setAppId(e.target.value)}
              placeholder="org.unifiedpush.default"
              autoComplete="off"
              spellCheck={false}
            />
          </label>

          <div className="settings-pusher-fields-row">
            <label className="settings-pusher-field">
              <span>App name</span>
              <input
                className="settings-edit-input"
                value={appDisplayName}
                onChange={e => setAppDisplayName(e.target.value)}
                placeholder="VirtualChat"
              />
            </label>
            <label className="settings-pusher-field">
              <span>Device name</span>
              <input
                className="settings-edit-input"
                value={deviceDisplayName}
                onChange={e => setDeviceDisplayName(e.target.value)}
                placeholder="My phone"
              />
            </label>
          </div>

          {error && <p className="settings-notif-warning" style={{ marginTop: 8 }}>{error}</p>}

          <div className="settings-pusher-actions">
            <button className="btn-secondary" type="button" onClick={closeForm} disabled={busy}>Cancel</button>
            <button
              className="settings-save-btn"
              type="button"
              onClick={submit}
              disabled={busy || !gatewayUrl.trim() || !pushkey.trim() || !appId.trim()}
            >
              {busy ? 'Registering…' : 'Register'}
            </button>
          </div>
        </div>
      )}

      {error && !showForm && (
        <p className="settings-notif-warning" style={{ marginTop: 8 }}>{error}</p>
      )}
    </div>
  )
}

// ---- Push Rules Tab ----
//
// Full server-side push rule editor. Groups rules by kind (override, content,
// room, sender, underride), lets the user toggle them on/off, tweak actions
// (notify / highlight / sound), delete user-defined ones, and create new rules.
//
// Default server rules (rule_id starting with ".") cannot be deleted — only
// toggled and retuned. User-defined rules are fully editable.

type RuleKind = 'override' | 'content' | 'room' | 'sender' | 'underride'

interface ActionsSummary {
  notify: boolean
  highlight: boolean
  sound: string | null
}

function readActions(actions: any[] | undefined): ActionsSummary {
  const list = actions ?? []
  const notify = list.includes('notify')
  const highlight = list.find((a: any) => a && a.set_tweak === 'highlight')
  const sound = list.find((a: any) => a && a.set_tweak === 'sound')
  return {
    notify,
    highlight: highlight ? highlight.value !== false : false,
    sound: sound ? (sound.value ?? 'default') : null,
  }
}

function buildActions(s: ActionsSummary): any[] {
  const out: any[] = [s.notify ? 'notify' : 'dont_notify']
  if (s.highlight) out.push({ set_tweak: 'highlight' })
  if (s.sound) out.push({ set_tweak: 'sound', value: s.sound })
  return out
}

function summariseRule(rule: any, kind: RuleKind): string {
  if (rule.pattern) return `matches "${rule.pattern}"`
  if (kind === 'room') return `room ${rule.rule_id}`
  if (kind === 'sender') return `sender ${rule.rule_id}`
  const conds: any[] = rule.conditions ?? []
  if (conds.length === 0) return '(no conditions)'
  return conds.map(c => {
    if (c.kind === 'event_match') return `${c.key} ~ "${c.pattern ?? c.value ?? ''}"`
    if (c.kind === 'event_property_is') return `${c.key} = ${JSON.stringify(c.value)}`
    if (c.kind === 'event_property_contains') return `${c.key} ∋ ${JSON.stringify(c.value)}`
    if (c.kind === 'contains_display_name') return 'mentions my display name'
    if (c.kind === 'room_member_count') return `members ${c.is}`
    if (c.kind === 'sender_notification_permission') return `sender can notify @${c.key}`
    if (c.kind === 'call_started' || c.kind === 'org.matrix.msc3914.call_started') return 'call started'
    return c.kind
  }).join(' & ')
}

function isUserRule(ruleId: string): boolean {
  return typeof ruleId === 'string' && !ruleId.startsWith('.')
}

function PushRulesTab() {
  const { client, state } = useMatrix()
  const [rules, setRules] = useState<any | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const reload = useCallback(() => {
    if (!client) { setRules(null); return }
    const r = (client as any).getPushRules?.() ?? null
    setRules(r)
  }, [client])

  useEffect(() => { reload() }, [reload])

  async function run(fn: () => Promise<void>) {
    setError(null); setBusy(true)
    try {
      await fn()
      reload()
    } catch (e: any) {
      setError(e?.message ?? 'Operation failed')
    } finally {
      setBusy(false)
    }
  }

  function toggleEnabled(kind: RuleKind, ruleId: string, enabled: boolean) {
    return run(() => (client as any).setPushRuleEnabled('global', kind, ruleId, enabled))
  }

  function updateActions(kind: RuleKind, ruleId: string, actions: ActionsSummary) {
    return run(() => (client as any).setPushRuleActions('global', kind, ruleId, buildActions(actions)))
  }

  function deleteRule(kind: RuleKind, ruleId: string) {
    return run(() => (client as any).deletePushRule('global', kind, ruleId))
  }

  function addRule(kind: RuleKind, ruleId: string, body: any) {
    return run(async () => {
      await (client as any).addPushRule('global', kind, ruleId, body)
      // Matrix sync may not surface the new rule immediately; merge it in.
      setRules((prev: any) => {
        if (!prev) return prev
        const list = prev.global?.[kind] ?? []
        if (list.some((r: any) => r.rule_id === ruleId)) return prev
        const next = { ...prev, global: { ...prev.global, [kind]: [...list, { ...body, rule_id: ruleId, enabled: true, default: false }] } }
        return next
      })
    })
  }

  const kinds: Array<{ kind: RuleKind; title: string; description: string }> = [
    { kind: 'override', title: 'Override', description: 'Highest priority. Applied before any other rule.' },
    { kind: 'content', title: 'Content (keywords)', description: 'Match against the message body.' },
    { kind: 'room', title: 'Per-room', description: 'Override notifications for a specific room.' },
    { kind: 'sender', title: 'Per-sender', description: 'Override notifications for messages from a specific user.' },
    { kind: 'underride', title: 'Underride', description: 'Lowest priority fallback rules.' },
  ]

  if (!client) {
    return <p className="settings-description" style={{ fontStyle: 'italic' }}>Not connected.</p>
  }

  return (
    <div>
      <p className="settings-description">
        The full server-side push rule set. Changes sync to every device on your account.
      </p>
      {error && <p className="settings-notif-warning" style={{ marginTop: 8 }}>{error}</p>}
      {kinds.map(({ kind, title, description }) => (
        <PushRuleSection
          key={kind}
          kind={kind}
          title={title}
          description={description}
          rules={rules?.global?.[kind] ?? []}
          busy={busy}
          joinedRooms={state.rooms}
          onToggleEnabled={toggleEnabled}
          onUpdateActions={updateActions}
          onDelete={deleteRule}
          onAdd={addRule}
        />
      ))}
    </div>
  )
}

interface PushRuleSectionProps {
  kind: RuleKind
  title: string
  description: string
  rules: any[]
  busy: boolean
  joinedRooms: any[]
  onToggleEnabled: (kind: RuleKind, ruleId: string, enabled: boolean) => Promise<void>
  onUpdateActions: (kind: RuleKind, ruleId: string, actions: ActionsSummary) => Promise<void>
  onDelete: (kind: RuleKind, ruleId: string) => Promise<void>
  onAdd: (kind: RuleKind, ruleId: string, body: any) => Promise<void>
}

function PushRuleSection(props: PushRuleSectionProps) {
  const { kind, title, description, rules, busy, joinedRooms, onToggleEnabled, onUpdateActions, onDelete, onAdd } = props
  const [adding, setAdding] = useState(false)

  return (
    <div className="settings-field-group">
      <div className="settings-subheading">{title}</div>
      <p className="settings-description">{description}</p>

      {rules.length === 0 ? (
        <p className="settings-description" style={{ fontStyle: 'italic', marginTop: 0 }}>No rules.</p>
      ) : (
        <div className="pushrule-list">
          {rules.map((rule: any) => (
            <PushRuleRow
              key={rule.rule_id}
              kind={kind}
              rule={rule}
              busy={busy}
              onToggleEnabled={onToggleEnabled}
              onUpdateActions={onUpdateActions}
              onDelete={onDelete}
            />
          ))}
        </div>
      )}

      {adding ? (
        <AddRuleForm
          kind={kind}
          joinedRooms={joinedRooms}
          busy={busy}
          onCancel={() => setAdding(false)}
          onSubmit={async (ruleId, body) => {
            await onAdd(kind, ruleId, body)
            setAdding(false)
          }}
        />
      ) : (
        <button
          className="settings-pushrule-add-btn"
          onClick={() => setAdding(true)}
          disabled={busy}
          type="button"
        >
          + Add {kind} rule
        </button>
      )}
    </div>
  )
}

interface PushRuleRowProps {
  kind: RuleKind
  rule: any
  busy: boolean
  onToggleEnabled: (kind: RuleKind, ruleId: string, enabled: boolean) => Promise<void>
  onUpdateActions: (kind: RuleKind, ruleId: string, actions: ActionsSummary) => Promise<void>
  onDelete: (kind: RuleKind, ruleId: string) => Promise<void>
}

function PushRuleRow({ kind, rule, busy, onToggleEnabled, onUpdateActions, onDelete }: PushRuleRowProps) {
  const summary = readActions(rule.actions)
  const userRule = isUserRule(rule.rule_id)

  function updateAction(patch: Partial<ActionsSummary>) {
    const next: ActionsSummary = { ...summary, ...patch }
    onUpdateActions(kind, rule.rule_id, next)
  }

  return (
    <div className={`pushrule-row${rule.enabled ? '' : ' disabled'}`}>
      <div className="pushrule-row-main">
        <div className="pushrule-row-id" title={rule.rule_id}>{rule.rule_id}</div>
        <div className="pushrule-row-summary">{summariseRule(rule, kind)}</div>
      </div>
      <div className="pushrule-row-controls">
        <label className="pushrule-checkbox" title="Notify">
          <input
            type="checkbox"
            checked={summary.notify}
            onChange={e => updateAction({ notify: e.target.checked })}
            disabled={busy || !rule.enabled}
          />
          <span>Notify</span>
        </label>
        <label className="pushrule-checkbox" title="Highlight">
          <input
            type="checkbox"
            checked={summary.highlight}
            onChange={e => updateAction({ highlight: e.target.checked })}
            disabled={busy || !rule.enabled}
          />
          <span>Highlight</span>
        </label>
        <label className="pushrule-checkbox" title="Sound">
          <input
            type="checkbox"
            checked={summary.sound !== null}
            onChange={e => updateAction({ sound: e.target.checked ? (summary.sound ?? 'default') : null })}
            disabled={busy || !rule.enabled}
          />
          <span>Sound</span>
        </label>
        <div
          className={`settings-toggle${rule.enabled ? ' on' : ''}`}
          onClick={() => !busy && onToggleEnabled(kind, rule.rule_id, !rule.enabled)}
          title={rule.enabled ? 'Disable rule' : 'Enable rule'}
        />
        {userRule && (
          <button
            className="pushrule-delete-btn"
            onClick={() => onDelete(kind, rule.rule_id)}
            disabled={busy}
            title="Delete rule"
            type="button"
          >
            ✕
          </button>
        )}
      </div>
    </div>
  )
}

interface AddRuleFormProps {
  kind: RuleKind
  joinedRooms: any[]
  busy: boolean
  onCancel: () => void
  onSubmit: (ruleId: string, body: any) => Promise<void>
}

function AddRuleForm({ kind, joinedRooms, busy, onCancel, onSubmit }: AddRuleFormProps) {
  const [pattern, setPattern] = useState('')
  const [roomId, setRoomId] = useState(joinedRooms[0]?.roomId ?? '')
  const [userId, setUserId] = useState('')
  const [matchKey, setMatchKey] = useState('content.body')
  const [notify, setNotify] = useState(true)
  const [formError, setFormError] = useState<string | null>(null)

  async function submit() {
    setFormError(null)
    const actions = buildActions({ notify, highlight: notify, sound: notify ? 'default' : null })

    try {
      if (kind === 'content') {
        const p = pattern.trim()
        if (!p) { setFormError('Keyword is required'); return }
        const ruleId = p.replace(/^\.+/, '') || `kw-${Date.now()}`
        await onSubmit(ruleId, { pattern: p, actions })
      } else if (kind === 'room') {
        if (!roomId) { setFormError('Pick a room'); return }
        await onSubmit(roomId, { actions })
      } else if (kind === 'sender') {
        const u = userId.trim()
        if (!u.startsWith('@') || !u.includes(':')) { setFormError('User ID must look like @name:server'); return }
        await onSubmit(u, { actions })
      } else {
        // override / underride: single event_match condition
        const p = pattern.trim()
        if (!matchKey.trim() || !p) { setFormError('Key and pattern are required'); return }
        const ruleId = `custom-${Date.now()}`
        await onSubmit(ruleId, {
          conditions: [{ kind: 'event_match', key: matchKey.trim(), pattern: p }],
          actions,
        })
      }
    } catch (e: any) {
      setFormError(e?.message ?? 'Failed to add rule')
    }
  }

  return (
    <div className="pushrule-add-form">
      {kind === 'content' && (
        <input
          type="text"
          className="settings-keyword-input"
          placeholder="Keyword pattern (e.g. stand-up or *urgent*)"
          value={pattern}
          onChange={e => setPattern(e.target.value)}
          disabled={busy}
          maxLength={256}
        />
      )}

      {kind === 'room' && (
        <select
          className="pushrule-select"
          value={roomId}
          onChange={e => setRoomId(e.target.value)}
          disabled={busy}
        >
          {joinedRooms.length === 0 && <option value="">(no joined rooms)</option>}
          {joinedRooms.map(r => (
            <option key={r.roomId} value={r.roomId}>
              {r.name || r.roomId}
            </option>
          ))}
        </select>
      )}

      {kind === 'sender' && (
        <input
          type="text"
          className="settings-keyword-input"
          placeholder="@user:server"
          value={userId}
          onChange={e => setUserId(e.target.value)}
          disabled={busy}
        />
      )}

      {(kind === 'override' || kind === 'underride') && (
        <div className="pushrule-add-condition">
          <select
            className="pushrule-select"
            value={matchKey}
            onChange={e => setMatchKey(e.target.value)}
            disabled={busy}
          >
            <option value="content.body">content.body</option>
            <option value="content.msgtype">content.msgtype</option>
            <option value="type">type</option>
            <option value="sender">sender</option>
            <option value="room_id">room_id</option>
          </select>
          <input
            type="text"
            className="settings-keyword-input"
            placeholder="Pattern (glob, e.g. *urgent*)"
            value={pattern}
            onChange={e => setPattern(e.target.value)}
            disabled={busy}
          />
        </div>
      )}

      <label className="pushrule-checkbox" style={{ marginTop: 8 }}>
        <input
          type="checkbox"
          checked={notify}
          onChange={e => setNotify(e.target.checked)}
          disabled={busy}
        />
        <span>Notify (unchecked = mute/suppress)</span>
      </label>

      {formError && <p className="settings-notif-warning" style={{ marginTop: 8 }}>{formError}</p>}

      <div className="pushrule-add-actions">
        <button className="btn-secondary" onClick={onCancel} disabled={busy} type="button">Cancel</button>
        <button className="btn-primary" onClick={submit} disabled={busy} type="button" style={{ width: 'auto', marginTop: 0 }}>
          {busy ? 'Adding…' : 'Add rule'}
        </button>
      </div>
    </div>
  )
}

// ---- Privacy Tab ----

function PrivacyTab() {
  const { t } = useTranslation()
  const [sendTyping, setSendTyping] = useState(() => localStorage.getItem('vc_send_typing') !== 'false')
  const [sendReceipts, setSendReceipts] = useState(() => localStorage.getItem('vc_send_read_receipts') !== 'false')
  const [urlPreviews, setUrlPreviews] = useState(() => localStorage.getItem('vc_url_previews') !== 'false')
  const [showJoin, setShowJoin] = useState(() => localStorage.getItem('vc_show_member_join') !== 'false')
  const [showLeave, setShowLeave] = useState(() => localStorage.getItem('vc_show_member_leave') !== 'false')
  const [showProfile, setShowProfile] = useState(() => localStorage.getItem('vc_show_profile_change') !== 'false')
  const [showRoom, setShowRoom] = useState(() => localStorage.getItem('vc_show_room_change') !== 'false')
  const [showDeleted, setShowDeleted] = useState(() => localStorage.getItem('vc_show_deleted_messages') !== 'false')

  function toggle(key: string, val: boolean, setter: (v: boolean) => void) {
    setter(val)
    localStorage.setItem(key, String(val))
    // Notify listeners in the same tab — the native `storage` event only fires for other tabs.
    window.dispatchEvent(new CustomEvent('vc:settings-changed', { detail: { key } }))
  }

  const toggleRows = [
    { key: 'vc_send_typing',       label: t('settings.privacy.sendTypingLabel'),     desc: t('settings.privacy.sendTypingDesc'),     val: sendTyping,   set: setSendTyping },
    { key: 'vc_send_read_receipts', label: t('settings.privacy.sendReceiptsLabel'), desc: t('settings.privacy.sendReceiptsDesc'),  val: sendReceipts, set: setSendReceipts },
    { key: 'vc_url_previews',      label: t('settings.privacy.urlPreviewsLabel'),    desc: t('settings.privacy.urlPreviewsDesc'),   val: urlPreviews,  set: setUrlPreviews },
  ]
  const sysRows = [
    { key: 'vc_show_member_join',     label: t('settings.privacy.memberJoinsLabel'),    desc: t('settings.privacy.memberJoinsDesc'),    val: showJoin,    set: setShowJoin },
    { key: 'vc_show_member_leave',    label: t('settings.privacy.memberLeavesLabel'),   desc: t('settings.privacy.memberLeavesDesc'),   val: showLeave,   set: setShowLeave },
    { key: 'vc_show_profile_change',  label: t('settings.privacy.profileChangesLabel'), desc: t('settings.privacy.profileChangesDesc'), val: showProfile, set: setShowProfile },
    { key: 'vc_show_room_change',     label: t('settings.privacy.roomChangesLabel'),    desc: t('settings.privacy.roomChangesDesc'),    val: showRoom,    set: setShowRoom },
    { key: 'vc_show_deleted_messages', label: t('settings.privacy.deletedMessagesLabel'), desc: t('settings.privacy.deletedMessagesDesc'), val: showDeleted, set: setShowDeleted },
  ]

  return (
    <div className="settings-privacy">
      <div className="settings-field-group">
        <div className="settings-subheading">{t('settings.privacy.readReceiptsSection')}</div>
        {toggleRows.map(({ key, label, desc, val, set }) => (
          <div key={key} className="settings-toggle-row">
            <div className="settings-toggle-label">
              <div>
                <div className="settings-toggle-title">{label}</div>
                <div className="settings-toggle-desc">{desc}</div>
              </div>
              <div className={`settings-toggle${val ? ' on' : ''}`} onClick={() => toggle(key, !val, set)} />
            </div>
          </div>
        ))}
      </div>
      <div className="settings-field-group">
        <div className="settings-subheading">{t('settings.privacy.systemMessagesSection')}</div>
        <p className="settings-description" style={{ marginBottom: 12 }}>{t('settings.privacy.systemMessagesDescription')}</p>
        {sysRows.map(({ key, label, desc, val, set }) => (
          <div key={key} className="settings-toggle-row">
            <div className="settings-toggle-label">
              <div>
                <div className="settings-toggle-title">{label}</div>
                <div className="settings-toggle-desc">{desc}</div>
              </div>
              <div className={`settings-toggle${val ? ' on' : ''}`} onClick={() => toggle(key, !val, set)} />
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

// ---- Expert Tab ----

function ExpertTab() {
  const [showToken, setShowToken] = useState(false)
  const [tokenCopied, setTokenCopied] = useState(false)
  const { t } = useTranslation()
  const [encryptByDefault, setEncryptByDefault] = useState(() => localStorage.getItem('vc_encrypt_rooms_default') === 'true')
  const [autoformatJson, setAutoformatJson] = useState(() => localStorage.getItem('vc_autoformat_json') === 'true')
  const token = localStorage.getItem('mx_access_token') ?? ''

  function copyToken() {
    navigator.clipboard.writeText(token)
    setTokenCopied(true)
    setTimeout(() => setTokenCopied(false), 2000)
  }

  return (
    <div className="settings-expert">
      <div className="settings-field-group">
        <div className="settings-subheading">{t('settings.expert.accessTokenSection')}</div>
        <p className="settings-description">{t('settings.expert.accessTokenWarning')}</p>
        <div className="settings-token-row">
          <input
            className="settings-token-input"
            type={showToken ? 'text' : 'password'}
            value={token}
            readOnly
          />
          <button className="settings-token-btn" onClick={() => setShowToken(v => !v)}>
            {showToken ? t('settings.expert.hideToken') : t('settings.expert.showToken')}
          </button>
          <button className="settings-token-btn" onClick={copyToken}>
            {tokenCopied ? t('settings.expert.tokenCopied') : t('settings.expert.copyTokenBtn')}
          </button>
        </div>
      </div>
      <div className="settings-field-group">
        <div className="settings-subheading">{t('settings.expert.roomCreationSection')}</div>
        <div className="settings-toggle-row">
          <div className="settings-toggle-label">
            <div>
              <div className="settings-toggle-title">{t('settings.expert.encryptByDefaultTitle')}</div>
              <div className="settings-toggle-desc">{t('settings.expert.encryptByDefaultDesc')}</div>
            </div>
            <div
              className={`settings-toggle${encryptByDefault ? ' on' : ''}`}
              onClick={() => {
                const next = !encryptByDefault
                setEncryptByDefault(next)
                localStorage.setItem('vc_encrypt_rooms_default', String(next))
              }}
            />
          </div>
        </div>
      </div>
      <div className="settings-field-group">
        <div className="settings-subheading">{t('settings.expert.composerSection')}</div>
        <div className="settings-toggle-row">
          <div className="settings-toggle-label">
            <div>
              <div className="settings-toggle-title">{t('settings.expert.autoformatJsonTitle')}</div>
              <div className="settings-toggle-desc">{t('settings.expert.autoformatJsonDesc')}</div>
            </div>
            <div
              className={`settings-toggle${autoformatJson ? ' on' : ''}`}
              onClick={() => {
                const next = !autoformatJson
                setAutoformatJson(next)
                localStorage.setItem('vc_autoformat_json', String(next))
              }}
            />
          </div>
        </div>
      </div>
    </div>
  )
}

// ---- Sticker Packs Tab ----

function MxcStickerThumb({ url }: { url: string; client?: any }) {
  // forceDownload preserves animation for GIF / animated WebP stickers.
  const blob = useMxcBlobUrl(url, 80, 80, 'scale', true)
  if (!blob) return <div className="sticker-thumb-placeholder" />
  return <img className="sticker-thumb-img" src={blob} alt="sticker" loading="lazy" />
}

function StickerPacksTab() {
  const { client, getStickerPacks, saveStickerPacks } = useMatrix()
  const [packs, setPacks] = useState<StickerPack[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [newPackName, setNewPackName] = useState('')
  const [saving, setSaving] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [expanded, setExpanded] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const uploadForPack = useRef<string | null>(null)

  useEffect(() => {
    getStickerPacks().then(p => { setPacks(p); setLoading(false) }).catch(e => { setError(e.message); setLoading(false) })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function saveAll(updated: StickerPack[]) {
    setSaving(true)
    try {
      await saveStickerPacks(updated)
      setPacks(updated)
    } catch (e: any) {
      setError(e.message)
    } finally {
      setSaving(false)
    }
  }

  async function createPack() {
    if (!newPackName.trim()) return
    const pack: StickerPack = { id: `${Date.now()}`, name: newPackName.trim(), stickers: [] }
    await saveAll([...packs, pack])
    setNewPackName('')
    setCreating(false)
    setExpanded(pack.id)
  }

  async function deletePack(packId: string) {
    if (!confirm('Delete this sticker pack?')) return
    await saveAll(packs.filter(p => p.id !== packId))
  }

  async function uploadSticker(packId: string, file: File) {
    if (!client) return
    setUploading(true)
    try {
      const resp = await (client as any).uploadContent(file, { type: file.type })
      const mxcUrl: string = resp.content_uri
      const newSticker: StickerItem = {
        id: `${Date.now()}`,
        body: file.name.replace(/\.[^.]+$/, ''),
        url: mxcUrl,
        mimetype: file.type,
      }
      await saveAll(packs.map(p => p.id === packId ? { ...p, stickers: [...p.stickers, newSticker] } : p))
    } catch (e: any) {
      setError(e.message)
    } finally {
      setUploading(false)
    }
  }

  async function deleteSticker(packId: string, stickerId: string) {
    await saveAll(packs.map(p => p.id === packId ? { ...p, stickers: p.stickers.filter(s => s.id !== stickerId) } : p))
  }

  if (loading) return <div className="settings-loading"><div className="spinner" style={{ width: 28, height: 28, borderWidth: 3 }} /></div>

  return (
    <div className="settings-stickers">
      {error && <p className="settings-field-error" style={{ marginBottom: 12 }}>{error}</p>}
      <p className="settings-description" style={{ marginBottom: 16 }}>
        Upload images to create custom sticker packs. Send them using the sticker button in the message input.
      </p>

      {packs.map(pack => (
        <div key={pack.id} className="sticker-pack-item">
          <div className="sticker-pack-header" onClick={() => setExpanded(expanded === pack.id ? null : pack.id)}>
            <span className="sticker-pack-name">{pack.name}</span>
            <span className="sticker-pack-count">{pack.stickers.length} sticker{pack.stickers.length !== 1 ? 's' : ''}</span>
            <button
              className="sticker-pack-delete"
              onClick={e => { e.stopPropagation(); deletePack(pack.id) }}
              title="Delete pack"
            >✕</button>
            <span className="sticker-pack-chevron">{expanded === pack.id ? '▲' : '▼'}</span>
          </div>
          {expanded === pack.id && (
            <div className="sticker-pack-body">
              <div className="sticker-pack-grid">
                {pack.stickers.map(s => (
                  <div key={s.id} className="sticker-pack-sticker">
                    <MxcStickerThumb url={s.url} client={client} />
                    <button
                      className="sticker-pack-sticker-delete"
                      onClick={() => deleteSticker(pack.id, s.id)}
                      title="Remove sticker"
                    >✕</button>
                  </div>
                ))}
                <button
                  className="sticker-pack-add-btn"
                  onClick={() => { uploadForPack.current = pack.id; fileRef.current?.click() }}
                  disabled={uploading || saving}
                  title="Add sticker image"
                >
                  {uploading ? '…' : '+'}
                </button>
              </div>
            </div>
          )}
        </div>
      ))}

      {creating ? (
        <div className="sticker-pack-create">
          <input
            className="settings-edit-input"
            style={{ flex: 1 }}
            value={newPackName}
            onChange={e => setNewPackName(e.target.value)}
            placeholder="Pack name"
            onKeyDown={e => { if (e.key === 'Enter') createPack(); if (e.key === 'Escape') setCreating(false) }}
            autoFocus
          />
          <button className="settings-save-btn" style={{ marginLeft: 8 }} onClick={createPack} disabled={!newPackName.trim() || saving}>Create</button>
          <button className="btn-secondary" style={{ marginLeft: 8 }} onClick={() => setCreating(false)}>Cancel</button>
        </div>
      ) : (
        <button className="settings-save-btn" style={{ marginTop: 16 }} onClick={() => setCreating(true)}>
          + New Pack
        </button>
      )}

      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        style={{ display: 'none' }}
        onChange={async e => {
          const file = e.target.files?.[0]
          const packId = uploadForPack.current
          if (!file || !packId) return
          await uploadSticker(packId, file)
          e.target.value = ''
        }}
      />
    </div>
  )
}

// ---- Security Tab ----

function SecurityTab() {
  const { setupKeyBackup, checkKeyBackupStatus } = useMatrix()
  const [status, setStatus] = useState<KeyBackupStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [settingUp, setSettingUp] = useState(false)
  const [recoveryKey, setRecoveryKey] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [restoreInput, setRestoreInput] = useState('')
  const [showRestore, setShowRestore] = useState(false)
  const [restoring, setRestoring] = useState(false)
  const { restoreFromBackup } = useMatrix()
  const [restoreResult, setRestoreResult] = useState<{ total: number; imported: number } | null>(null)

  useEffect(() => {
    checkKeyBackupStatus()
      .then(s => setStatus(s))
      .catch(() => {})
      .finally(() => setLoading(false))
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function handleSetup() {
    setSettingUp(true)
    setError(null)
    try {
      const key = await setupKeyBackup()
      setRecoveryKey(key)
      const s = await checkKeyBackupStatus()
      setStatus(s)
    } catch (e: any) {
      setError(e?.message ?? 'Failed to set up key backup')
    } finally {
      setSettingUp(false)
    }
  }

  function handleCopy() {
    if (!recoveryKey) return
    navigator.clipboard.writeText(recoveryKey).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    })
  }

  async function handleRestore() {
    if (!restoreInput.trim()) return
    setRestoring(true)
    setError(null)
    setRestoreResult(null)
    try {
      const result = await restoreFromBackup(restoreInput.trim())
      setRestoreResult(result)
      const s = await checkKeyBackupStatus()
      setStatus(s)
      setRestoreInput('')
    } catch (e: any) {
      setError(e?.message ?? 'Invalid recovery key')
    } finally {
      setRestoring(false)
    }
  }

  if (loading) {
    return (
      <div className="settings-security">
        <div className="spinner" style={{ margin: '24px auto' }} />
      </div>
    )
  }

  // After setup — show recovery key
  if (recoveryKey) {
    return (
      <div className="settings-security">
        <div className="settings-field-group">
          <div className="settings-subheading">Your Recovery Key</div>
          <p className="settings-description">
            Save this key somewhere safe. You will need it to recover your encrypted
            message history if you sign in on a new device.
          </p>
          <div className="recovery-key-display">
            <code className="recovery-key-code">{recoveryKey}</code>
            <button className="recovery-key-copy-btn" onClick={handleCopy}>
              {copied ? 'Copied' : 'Copy'}
            </button>
          </div>
          <button
            className="settings-save-btn"
            style={{ marginTop: 16 }}
            onClick={() => setRecoveryKey(null)}
          >
            I've saved my recovery key
          </button>
        </div>
      </div>
    )
  }

  const isBackedUp = status?.backupEnabled
  const hasServerBackup = status?.backupVersion !== null

  return (
    <div className="settings-security">
      {error && <p className="settings-notif-warning" style={{ marginBottom: 12 }}>{error}</p>}

      <div className="settings-field-group">
        <div className="settings-subheading">Key Backup</div>
        <p className="settings-description">
          Key backup encrypts your message keys and stores them on the server.
          If you sign in on a new device, you can restore them with your recovery key.
        </p>

        <div className="security-status-rows">
          <div className="security-status-row">
            <span className={`security-dot ${isBackedUp ? 'security-dot--ok' : 'security-dot--warn'}`} />
            <span>{isBackedUp ? 'Key backup is active' : 'Key backup is not active on this device'}</span>
          </div>
          <div className="security-status-row">
            <span className={`security-dot ${status?.crossSigningReady ? 'security-dot--ok' : 'security-dot--warn'}`} />
            <span>{status?.crossSigningReady ? 'Cross-signing is set up' : 'Cross-signing is not set up'}</span>
          </div>
          {status?.backupVersion && (
            <div className="security-status-row">
              <span className="security-dot security-dot--ok" />
              <span>Backup version: {status.backupVersion}</span>
            </div>
          )}
        </div>

        {!isBackedUp && !hasServerBackup && (
          <button
            className="settings-save-btn"
            style={{ marginTop: 16 }}
            onClick={handleSetup}
            disabled={settingUp}
          >
            {settingUp ? 'Setting up...' : 'Set up key backup'}
          </button>
        )}

        {!isBackedUp && hasServerBackup && (
          <button
            className="settings-save-btn"
            style={{ marginTop: 16 }}
            onClick={() => setShowRestore(true)}
          >
            Enter recovery key
          </button>
        )}

        {isBackedUp && (
          <button
            className="settings-save-btn"
            style={{ marginTop: 16 }}
            onClick={handleSetup}
            disabled={settingUp}
          >
            {settingUp ? 'Resetting...' : 'Reset key backup'}
          </button>
        )}
      </div>

      {showRestore && (
        <div className="settings-field-group">
          <div className="settings-subheading">Restore from Backup</div>
          <p className="settings-description">
            Enter the recovery key you saved when you first set up key backup.
          </p>
          <input
            className="settings-edit-input"
            style={{ width: '100%', fontFamily: 'monospace', fontSize: 13 }}
            value={restoreInput}
            onChange={e => setRestoreInput(e.target.value)}
            placeholder="EsXV gK7N 2pJR ..."
            autoFocus
          />
          <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
            <button
              className="settings-save-btn"
              onClick={handleRestore}
              disabled={restoring || !restoreInput.trim()}
            >
              {restoring ? 'Restoring...' : 'Restore'}
            </button>
            <button
              className="btn-secondary"
              onClick={() => { setShowRestore(false); setRestoreInput(''); setRestoreResult(null) }}
            >
              {restoreResult ? 'Close' : 'Cancel'}
            </button>
          </div>
          {restoreResult && (
            <p className="settings-description" style={{ marginTop: 12 }}>
              Restored {restoreResult.imported} of {restoreResult.total} keys from backup.
            </p>
          )}
        </div>
      )}
    </div>
  )
}

// ---- Modal shell ----

export default function SettingsModal({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation()
  const [tab, setTab] = useState<Tab>('account')
  const contentRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  function switchTab(t: Tab) {
    setTab(t)
    // Reset scroll so content is always visible at the top
    if (contentRef.current) contentRef.current.scrollTop = 0
  }

  const navItems: [Tab, string][] = [
    ['account', t('settings.tabs.account')],
    ['appearance', t('settings.tabs.appearance')],
    ['notifications', t('settings.tabs.notifications')],
    ['push-rules', t('settings.tabs.pushRules')],
    ['privacy', t('settings.tabs.privacy')],
    ['security', t('settings.tabs.security')],
    ['stickerpacks', t('settings.tabs.stickerPacks')],
    ['devices', t('settings.tabs.devices')],
    ['expert', t('settings.tabs.expert')],
  ]

  return createPortal(
    <div className="settings-overlay" onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <div className="settings-modal">

        {/* Sidebar nav */}
        <nav className="settings-nav">
          <div className="settings-nav-label">User Settings</div>
          {navItems.map(([t, label]) => (
            <button
              key={t}
              className={`settings-nav-item ${tab === t ? 'active' : ''}`}
              onClick={() => switchTab(t)}
            >
              {label}
            </button>
          ))}
        </nav>

        {/* Content */}
        <div className="settings-content" ref={contentRef}>
          <button className="settings-close-btn" onClick={onClose} aria-label="Close settings">✕</button>

          {tab === 'account' && (
            <>
              <h2 className="settings-heading">{t('settings.tabs.account')}</h2>
              <AccountTab />
            </>
          )}

          {tab === 'appearance' && (
            <>
              <h2 className="settings-heading">{t('settings.tabs.appearance')}</h2>
              <AppearanceTab />
            </>
          )}

          {tab === 'notifications' && (
            <>
              <h2 className="settings-heading">{t('settings.tabs.notifications')}</h2>
              <NotificationsTab />
            </>
          )}

          {tab === 'push-rules' && (
            <>
              <h2 className="settings-heading">{t('settings.tabs.pushRules')}</h2>
              <PushRulesTab />
            </>
          )}

          {tab === 'devices' && (
            <>
              <h2 className="settings-heading">{t('settings.tabs.devices')}</h2>
              <p className="settings-description">
                Your sessions on other devices. Verify them to confirm they belong to you and
                unlock end-to-end encrypted messages.
              </p>
              <DevicesTab />
            </>
          )}

          {tab === 'privacy' && (
            <>
              <h2 className="settings-heading">{t('settings.tabs.privacy')}</h2>
              <PrivacyTab />
            </>
          )}

          {tab === 'security' && (
            <>
              <h2 className="settings-heading">{t('settings.tabs.security')}</h2>
              <SecurityTab />
            </>
          )}

          {tab === 'stickerpacks' && (
            <>
              <h2 className="settings-heading">{t('settings.tabs.stickerPacks')}</h2>
              <StickerPacksTab />
            </>
          )}

          {tab === 'expert' && (
            <>
              <h2 className="settings-heading">{t('settings.tabs.expert')}</h2>
              <ExpertTab />
            </>
          )}
        </div>
      </div>
    </div>,
    document.body
  )
}

function PencilIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
      <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
    </svg>
  )
}
