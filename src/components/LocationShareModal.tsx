import React, { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { useMatrix } from '../context/MatrixContext'

interface Props {
  onClose: () => void
}

type Phase = 'idle' | 'locating' | 'ready' | 'sending' | 'error'

interface Coords {
  lat: number
  lon: number
  accuracy?: number
}

export default function LocationShareModal({ onClose }: Props) {
  const { state, client } = useMatrix()
  const [phase, setPhase] = useState<Phase>('idle')
  const [coords, setCoords] = useState<Coords | null>(null)
  const [description, setDescription] = useState('')
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  function locate() {
    if (!('geolocation' in navigator)) {
      setError('Geolocation is not supported by this browser.')
      setPhase('error')
      return
    }
    setPhase('locating')
    setError(null)
    navigator.geolocation.getCurrentPosition(
      pos => {
        setCoords({
          lat: pos.coords.latitude,
          lon: pos.coords.longitude,
          accuracy: pos.coords.accuracy,
        })
        setPhase('ready')
      },
      err => {
        const msg = err.code === err.PERMISSION_DENIED
          ? 'Location permission denied. Enable it in your browser settings to share.'
          : err.code === err.POSITION_UNAVAILABLE
            ? 'Location unavailable. Try again near a window or with GPS enabled.'
            : err.code === err.TIMEOUT
              ? 'Timed out getting your location.'
              : err.message || 'Failed to get location.'
        setError(msg)
        setPhase('error')
      },
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 },
    )
  }

  async function send() {
    if (!client || !coords || !state.activeRoomId) return
    setPhase('sending')
    setError(null)
    const geoUri = `geo:${coords.lat},${coords.lon}${coords.accuracy ? `;u=${Math.round(coords.accuracy)}` : ''}`
    const ts = Date.now()
    const trimmed = description.trim()
    const body = trimmed
      ? `${trimmed} (${coords.lat.toFixed(5)}, ${coords.lon.toFixed(5)})`
      : `Location: ${coords.lat.toFixed(5)}, ${coords.lon.toFixed(5)}`

    // MSC3488 — extensible location event (static)
    const content: any = {
      msgtype: 'm.location',
      body,
      geo_uri: geoUri,
      'org.matrix.msc3488.location': {
        uri: geoUri,
        ...(trimmed ? { description: trimmed } : {}),
      },
      'org.matrix.msc3488.asset': { type: 'm.self' },
      'org.matrix.msc3488.ts': ts,
    }

    try {
      await (client as any).sendEvent(state.activeRoomId, 'm.room.message', content)
      onClose()
    } catch (e: any) {
      setError(e?.message ?? 'Failed to send location')
      setPhase('ready')
    }
  }

  let body: React.ReactNode = null
  let actions: React.ReactNode = null

  if (phase === 'idle') {
    body = (
      <p className="location-modal-desc">
        Share your current location with <strong>{state.activeRoomId ? 'this room' : 'the room'}</strong>?
        Your device will ask your browser for your coordinates. Everyone in the room will see them.
      </p>
    )
    actions = (
      <>
        <button className="verification-btn verification-btn-ghost" onClick={onClose} type="button">
          Cancel
        </button>
        <button className="verification-btn verification-btn-primary" onClick={locate} type="button">
          Get my location
        </button>
      </>
    )
  } else if (phase === 'locating') {
    body = (
      <div className="verification-spinner"><div className="spinner" /></div>
    )
    actions = (
      <button className="verification-btn verification-btn-ghost" onClick={onClose} type="button">
        Cancel
      </button>
    )
  } else if (phase === 'ready' || phase === 'sending') {
    body = (
      <>
        <div className="location-preview">
          <div className="location-preview-coords">
            <span className="location-pin">📍</span>
            <div>
              <div className="location-preview-latlon">
                {coords!.lat.toFixed(5)}, {coords!.lon.toFixed(5)}
              </div>
              {coords!.accuracy !== undefined && (
                <div className="location-preview-accuracy">
                  Accurate to ~{Math.round(coords!.accuracy)} m
                </div>
              )}
            </div>
          </div>
        </div>
        <label className="location-desc-label">
          Description (optional)
          <input
            className="settings-keyword-input"
            type="text"
            value={description}
            onChange={e => setDescription(e.target.value)}
            placeholder="e.g. The café on the corner"
            maxLength={120}
            disabled={phase === 'sending'}
          />
        </label>
        {error && <p className="settings-notif-warning" style={{ marginTop: 8 }}>{error}</p>}
      </>
    )
    actions = (
      <>
        <button
          className="verification-btn verification-btn-ghost"
          onClick={onClose}
          disabled={phase === 'sending'}
          type="button"
        >
          Cancel
        </button>
        <button
          className="verification-btn verification-btn-primary"
          onClick={send}
          disabled={phase === 'sending'}
          type="button"
        >
          {phase === 'sending' ? 'Sending…' : 'Share location'}
        </button>
      </>
    )
  } else if (phase === 'error') {
    body = (
      <p className="verification-error-text">{error ?? 'Unknown error.'}</p>
    )
    actions = (
      <>
        <button className="verification-btn verification-btn-ghost" onClick={onClose} type="button">
          Close
        </button>
        <button className="verification-btn verification-btn-primary" onClick={locate} type="button">
          Try again
        </button>
      </>
    )
  }

  return createPortal(
    <div className="verification-overlay" onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <div className="verification-modal">
        <div className="verification-modal-header">
          <span className="verification-icon">📍</span>
          <span className="verification-title">Share location</span>
        </div>
        {body}
        <div className="verification-actions">{actions}</div>
      </div>
    </div>,
    document.body,
  )
}
