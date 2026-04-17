import React, { useEffect, useRef, useState } from 'react'
import { useMatrix } from '../context/MatrixContext'

export default function CallOverlay() {
  const { activeCall, answerCall, rejectCall, hangupCall, toggleCallMute, toggleCallCamera } = useMatrix()
  const [elapsed, setElapsed] = useState(0)
  const localVideoRef = useRef<HTMLVideoElement>(null)
  const remoteVideoRef = useRef<HTMLVideoElement>(null)

  // Call timer
  useEffect(() => {
    if (!activeCall || activeCall.state !== 'connected') {
      setElapsed(0)
      return
    }
    const t0 = Date.now()
    const iv = setInterval(() => setElapsed(Math.floor((Date.now() - t0) / 1000)), 1000)
    return () => clearInterval(iv)
  }, [activeCall?.state])

  // Attach streams to video elements
  useEffect(() => {
    if (remoteVideoRef.current && activeCall?.remoteStream) {
      remoteVideoRef.current.srcObject = activeCall.remoteStream
    }
  }, [activeCall?.remoteStream])

  useEffect(() => {
    if (localVideoRef.current && activeCall?.localStream) {
      localVideoRef.current.srcObject = activeCall.localStream
    }
  }, [activeCall?.localStream])

  if (!activeCall) return null

  const isRinging = activeCall.state === 'ringing' && activeCall.direction === 'inbound'
  const isConnecting = activeCall.state === 'connecting' || activeCall.state === 'invite_sent' ||
    activeCall.state === 'wait_local_media' || activeCall.state === 'create_offer' || activeCall.state === 'create_answer'
  const isConnected = activeCall.state === 'connected'
  const isVideo = activeCall.video

  const mins = Math.floor(elapsed / 60)
  const secs = elapsed % 60
  const timeStr = `${mins}:${secs.toString().padStart(2, '0')}`

  if (isVideo && (isConnecting || isConnected)) {
    return (
      <div className="call-video-overlay">
        <div className="call-video-main">
          <video ref={remoteVideoRef} autoPlay playsInline />
          {!activeCall.remoteStream && (
            <div className="call-video-placeholder">
              <div className="call-video-name">{activeCall.peerName}</div>
              <div className="call-video-status">{isConnecting ? 'Connecting…' : timeStr}</div>
            </div>
          )}
        </div>
        <div className="call-video-pip">
          <video ref={localVideoRef} autoPlay playsInline muted />
          {activeCall.cameraMuted && <div className="call-video-camera-off">Camera off</div>}
        </div>
        <div className="call-video-hud">
          <div className="call-video-info">
            <div className="call-video-name-small">{activeCall.peerName}</div>
            <div className="call-video-status-small">{isConnected ? timeStr : 'Connecting…'}</div>
          </div>
          <div className="call-video-actions">
            <button
              className={`call-btn call-btn--mute${activeCall.micMuted ? ' active' : ''}`}
              onClick={toggleCallMute}
              title={activeCall.micMuted ? 'Unmute' : 'Mute'}
            >
              {activeCall.micMuted ? <MicOffIcon /> : <MicIcon />}
            </button>
            <button
              className={`call-btn call-btn--mute${activeCall.cameraMuted ? ' active' : ''}`}
              onClick={toggleCallCamera}
              title={activeCall.cameraMuted ? 'Turn camera on' : 'Turn camera off'}
            >
              {activeCall.cameraMuted ? <VideoOffIcon /> : <VideoOnIcon />}
            </button>
            <button className="call-btn call-btn--hangup" onClick={hangupCall} title="End call">
              <HangupIcon />
            </button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="call-overlay">
      <div className="call-overlay-info">
        <div className="call-overlay-icon">
          {isVideo ? <VideoOnIcon /> : <PhoneIcon />}
        </div>
        <div className="call-overlay-details">
          <div className="call-overlay-name">{activeCall.peerName}</div>
          <div className="call-overlay-status">
            {isRinging && (isVideo ? 'Incoming video call...' : 'Incoming call...')}
            {isConnecting && 'Connecting...'}
            {isConnected && timeStr}
            {activeCall.state === 'ended' && 'Call ended'}
          </div>
        </div>
      </div>

      <div className="call-overlay-actions">
        {isRinging && (
          <>
            {isVideo && (
              <button className="call-btn call-btn--accept" onClick={() => answerCall(true)} title="Answer with video">
                <VideoOnIcon />
              </button>
            )}
            <button className="call-btn call-btn--accept" onClick={() => answerCall(isVideo ? false : undefined)} title={isVideo ? 'Answer with audio only' : 'Answer'}>
              <PhoneIcon />
            </button>
            <button className="call-btn call-btn--reject" onClick={rejectCall} title="Decline">
              <HangupIcon />
            </button>
          </>
        )}

        {(isConnecting || isConnected) && (
          <>
            <button
              className={`call-btn call-btn--mute${activeCall.micMuted ? ' active' : ''}`}
              onClick={toggleCallMute}
              title={activeCall.micMuted ? 'Unmute' : 'Mute'}
            >
              {activeCall.micMuted ? <MicOffIcon /> : <MicIcon />}
            </button>
            <button className="call-btn call-btn--hangup" onClick={hangupCall} title="End call">
              <HangupIcon />
            </button>
          </>
        )}
      </div>
    </div>
  )
}

function PhoneIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M15.5 10.5c.5 1.2 1.8 2.5 3 3" />
      <path d="M20.2 15.6a2 2 0 0 1 .8 1.6v2a2 2 0 0 1-2.2 2c-3.3-.3-6.3-1.7-8.7-3.8a14.5 14.5 0 0 1-4.8-7.1 15 15 0 0 1-.5-3.2A2 2 0 0 1 6.7 5h2a2 2 0 0 1 2 1.7 10 10 0 0 0 .7 2.4 2 2 0 0 1-.4 2.1l-.9.9a12 12 0 0 0 4.9 4.9l.9-.9a2 2 0 0 1 2.1-.4 10 10 0 0 0 2.3.7z" />
    </svg>
  )
}

function HangupIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 11c2.4-2 5.6-3 9-3s6.6 1 9 3l-1.5 2.5a1.5 1.5 0 0 1-2 .5l-2.4-1.2a1.5 1.5 0 0 1-.8-1.3V10a10 10 0 0 0-4.6 0v1.5a1.5 1.5 0 0 1-.8 1.3L6.5 14a1.5 1.5 0 0 1-2-.5z" />
    </svg>
  )
}

function MicIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="9" y="2.5" width="6" height="12" rx="3" />
      <path d="M5.5 11.5a6.5 6.5 0 0 0 13 0" />
      <line x1="12" y1="18" x2="12" y2="21.5" />
      <line x1="8.5" y1="21.5" x2="15.5" y2="21.5" />
    </svg>
  )
}

function MicOffIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="9" y="2.5" width="6" height="12" rx="3" />
      <path d="M5.5 11.5a6.5 6.5 0 0 0 13 0" />
      <line x1="12" y1="18" x2="12" y2="21.5" />
      <line x1="8.5" y1="21.5" x2="15.5" y2="21.5" />
      <line x1="3.5" y1="3.5" x2="20.5" y2="20.5" />
    </svg>
  )
}

function VideoOnIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="6" width="13" height="12" rx="2.5" ry="2.5" />
      <path d="M15 10.5l6-3.5v10l-6-3.5z" />
    </svg>
  )
}

function VideoOffIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="6" width="13" height="12" rx="2.5" ry="2.5" />
      <path d="M15 10.5l6-3.5v10l-6-3.5z" />
      <line x1="3.5" y1="3.5" x2="20.5" y2="20.5" />
    </svg>
  )
}
