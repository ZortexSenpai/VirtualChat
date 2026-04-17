import React, { useEffect, useRef, useState } from 'react'
import QRCode from 'qrcode'
import { useMatrix } from '../context/MatrixContext'
import {
  VerificationPhase,
  VerificationRequestEvent,
  VerifierEvent,
} from 'matrix-js-sdk/lib/crypto-api/verification'
import type {
  VerificationRequest,
  Verifier,
  ShowSasCallbacks,
  ShowQrCodeCallbacks,
} from 'matrix-js-sdk/lib/crypto-api/verification'

export default function VerificationModal() {
  const { state, dismissVerification } = useMatrix()
  const request = state.verificationRequest as VerificationRequest | null

  const [phase, setPhase] = useState<VerificationPhase | null>(null)
  const [sasCallbacks, setSasCallbacks] = useState<ShowSasCallbacks | null>(null)
  const [qrCallbacks, setQrCallbacks] = useState<ShowQrCodeCallbacks | null>(null)
  const [qrBytes, setQrBytes] = useState<Uint8ClampedArray | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const verifierSetupRef = useRef(false)
  const qrAttemptedRef = useRef(false)
  const qrCanvasRef = useRef<HTMLCanvasElement | null>(null)

  // Reset local state when the request changes
  useEffect(() => {
    if (!request) {
      setPhase(null)
      setSasCallbacks(null)
      setQrCallbacks(null)
      setQrBytes(null)
      setBusy(false)
      setError(null)
      verifierSetupRef.current = false
      qrAttemptedRef.current = false
      return
    }

    setPhase(request.phase)

    // If the verifier is already available (e.g. other side started it), set it up
    if (request.verifier) {
      setupVerifier(request.verifier)
    }

    if (request.phase === VerificationPhase.Ready && request.initiatedByMe) {
      tryShowQrCode(request)
    }

    function handleChange() {
      const p = request!.phase
      setPhase(p)

      // When the request becomes Ready and we're the initiator, offer QR first
      // (falls back to SAS if the other side can't scan).
      if (p === VerificationPhase.Ready && request!.initiatedByMe && !verifierSetupRef.current) {
        tryShowQrCode(request!)
      }

      // Other side started verification — pick up their verifier
      if (p === VerificationPhase.Started && request!.verifier && !verifierSetupRef.current) {
        setupVerifier(request!.verifier)
      }
    }

    request.on(VerificationRequestEvent.Change, handleChange)
    return () => {
      request.off(VerificationRequestEvent.Change, handleChange)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request])

  // Render QR code into the canvas once bytes are available and the canvas is mounted
  useEffect(() => {
    if (!qrBytes || !qrCanvasRef.current) return
    const bytes = new Uint8Array(qrBytes.buffer, qrBytes.byteOffset, qrBytes.byteLength)
    QRCode.toCanvas(
      qrCanvasRef.current,
      [{ data: bytes, mode: 'byte' }],
      { errorCorrectionLevel: 'L', width: 240, margin: 2 },
    ).catch(err => setError(err?.message ?? 'Failed to render QR code'))
  }, [qrBytes])

  async function tryShowQrCode(req: VerificationRequest) {
    if (qrAttemptedRef.current) return
    qrAttemptedRef.current = true
    try {
      const bytes = await req.generateQRCode()
      if (bytes) {
        setQrBytes(bytes)
        return
      }
    } catch {
      // fall through to SAS
    }
    // Other device can't scan — fall back to SAS
    startSas(req)
  }

  function startSas(req: VerificationRequest) {
    req.startVerification('m.sas.v1')
      .then(v => setupVerifier(v))
      .catch(e => setError(e.message ?? 'Failed to start verification'))
  }

  function setupVerifier(verifier: Verifier) {
    if (verifierSetupRef.current) return
    verifierSetupRef.current = true

    // Other side scanned our QR — we need to confirm
    const existingQr = verifier.getReciprocateQrCodeCallbacks()
    if (existingQr) { setQrCallbacks(existingQr); return }

    // May already have SAS data (rare but possible)
    const existingSas = verifier.getShowSasCallbacks()
    if (existingSas) { setSasCallbacks(existingSas); return }

    verifier.on(VerifierEvent.ShowSas, (callbacks: ShowSasCallbacks) => {
      setSasCallbacks(callbacks)
    })

    verifier.on(VerifierEvent.ShowReciprocateQr, (callbacks: ShowQrCodeCallbacks) => {
      setQrCallbacks(callbacks)
    })

    verifier.verify().catch(err => {
      if (!verifier.hasBeenCancelled) {
        setError(err?.message ?? 'Verification failed')
      }
    })
  }

  async function handleAccept() {
    if (!request) return
    setBusy(true)
    try {
      await request.accept()
      // The initiating device starts SAS after receiving our `ready`.
      // handleChange will pick up the verifier once the phase moves to Started.
    } catch (e: any) {
      setError(e?.message ?? 'Accept failed')
    } finally {
      setBusy(false)
    }
  }

  async function handleCancel() {
    if (request) {
      try { await request.cancel() } catch { /* ignore */ }
    }
    dismissVerification()
  }

  async function handleConfirm() {
    if (!sasCallbacks) return
    setBusy(true)
    try {
      await sasCallbacks.confirm()
    } catch (e: any) {
      setError(e?.message ?? 'Confirm failed')
    } finally {
      setBusy(false)
    }
  }

  async function handleQrConfirm() {
    if (!qrCallbacks) return
    setBusy(true)
    try {
      qrCallbacks.confirm()
    } catch (e: any) {
      setError(e?.message ?? 'Confirm failed')
    } finally {
      setBusy(false)
    }
  }

  function handleMismatch() {
    if (sasCallbacks) sasCallbacks.mismatch()
    dismissVerification()
  }

  function handleUseEmojiInstead() {
    if (!request) return
    setQrBytes(null)
    startSas(request)
  }

  if (!request) return null

  const otherUser = request.otherUserId.replace(/^@/, '').split(':')[0]

  // ---- Render by phase ----

  let title = ''
  let subtitle: React.ReactNode = null
  let body: React.ReactNode = null
  let actions: React.ReactNode = null

  if (error) {
    title = 'Verification error'
    subtitle = <span className="verification-error-text">{error}</span>
    actions = (
      <button className="verification-btn verification-btn-ghost" onClick={dismissVerification}>
        Close
      </button>
    )
  } else if (phase === VerificationPhase.Done) {
    title = 'Verified!'
    body = (
      <div className="verification-success">
        <div className="verification-success-icon">✅</div>
        <p className="verification-success-msg">
          You have successfully verified <strong>{otherUser}</strong>.
        </p>
      </div>
    )
    actions = (
      <button className="verification-btn verification-btn-primary" onClick={dismissVerification}>
        Done
      </button>
    )
  } else if (phase === VerificationPhase.Cancelled) {
    title = 'Verification cancelled'
    subtitle = (
      <span className="verification-error-text">
        {request.cancellationCode
          ? `Reason: ${request.cancellationCode}`
          : 'The verification was cancelled.'}
      </span>
    )
    actions = (
      <button className="verification-btn verification-btn-ghost" onClick={dismissVerification}>
        Close
      </button>
    )
  } else if (qrCallbacks) {
    // Other side scanned our QR — ask the user to confirm
    title = 'Scan successful'
    subtitle = (
      <span>
        The other device scanned your QR code. Confirm the scan was from <strong>{otherUser}</strong>.
      </span>
    )
    actions = (
      <>
        <button
          className="verification-btn verification-btn-danger"
          onClick={handleCancel}
          disabled={busy}
        >
          Cancel
        </button>
        <button
          className="verification-btn verification-btn-primary"
          onClick={handleQrConfirm}
          disabled={busy}
        >
          {busy ? 'Confirming…' : 'Confirm'}
        </button>
      </>
    )
  } else if (sasCallbacks) {
    // SAS emoji comparison
    const emojis = sasCallbacks.sas.emoji ?? []
    const decimals = sasCallbacks.sas.decimal

    title = 'Verify by emoji'
    subtitle = (
      <span>
        Compare these emojis with <strong>{otherUser}</strong>. If they match, confirm below.
      </span>
    )
    body = (
      <>
        {emojis.length > 0 && (
          <div className="verification-emoji-grid">
            {emojis.map(([emoji, name], i) => (
              <div key={i} className="verification-emoji-box">
                <span className="verification-emoji-icon">{emoji}</span>
                <span className="verification-emoji-name">{name}</span>
              </div>
            ))}
          </div>
        )}
        {decimals && emojis.length === 0 && (
          <div className="verification-decimals">
            {decimals.join(' — ')}
          </div>
        )}
      </>
    )
    actions = (
      <>
        <button
          className="verification-btn verification-btn-danger"
          onClick={handleMismatch}
          disabled={busy}
        >
          They don't match
        </button>
        <button
          className="verification-btn verification-btn-primary"
          onClick={handleConfirm}
          disabled={busy}
        >
          {busy ? 'Confirming…' : 'They match'}
        </button>
      </>
    )
  } else if (qrBytes) {
    // We're the initiator and the other device can scan — show our QR code
    title = 'Scan with your other device'
    subtitle = (
      <span>
        Open the verification prompt on your other device and scan this code.
      </span>
    )
    body = (
      <div className="verification-qr">
        <canvas ref={qrCanvasRef} className="verification-qr-canvas" />
      </div>
    )
    actions = (
      <>
        <button
          className="verification-btn verification-btn-ghost"
          onClick={handleUseEmojiInstead}
          disabled={busy}
        >
          Use emoji instead
        </button>
        <button
          className="verification-btn verification-btn-ghost"
          onClick={handleCancel}
          disabled={busy}
        >
          Cancel
        </button>
      </>
    )
  } else if (phase === VerificationPhase.Requested && !request.initiatedByMe) {
    // Incoming request, waiting for user to accept
    title = 'Verification request'
    subtitle = (
      <span>
        <strong>{otherUser}</strong> wants to verify your identity.
      </span>
    )
    actions = (
      <>
        <button
          className="verification-btn verification-btn-ghost"
          onClick={handleCancel}
          disabled={busy}
        >
          Decline
        </button>
        <button
          className="verification-btn verification-btn-primary"
          onClick={handleAccept}
          disabled={busy}
        >
          {busy ? 'Accepting…' : 'Accept'}
        </button>
      </>
    )
  } else {
    // Outgoing request or intermediate phase — show a spinner
    const phaseLabel =
      phase === VerificationPhase.Requested ? `Waiting for ${otherUser} to accept…`
      : phase === VerificationPhase.Ready ? 'Starting verification…'
      : phase === VerificationPhase.Started ? 'Exchanging keys…'
      : 'Verifying…'

    title = 'Verifying device'
    subtitle = <span>{phaseLabel}</span>
    body = <div className="verification-spinner"><div className="spinner" /></div>
    actions = (
      <button
        className="verification-btn verification-btn-ghost"
        onClick={handleCancel}
        disabled={busy}
      >
        Cancel
      </button>
    )
  }

  return (
    <div className="verification-overlay" onClick={e => { if (e.target === e.currentTarget) handleCancel() }}>
      <div className="verification-modal">
        <div className="verification-modal-header">
          <span className="verification-icon">🔐</span>
          <span className="verification-title">{title}</span>
        </div>
        {subtitle && <p className="verification-subtitle">{subtitle}</p>}
        {body}
        <div className="verification-actions">{actions}</div>
      </div>
    </div>
  )
}
