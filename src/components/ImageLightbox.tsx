import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useMatrix } from '../context/MatrixContext'
import { fetchMediaBlobUrl } from '../services/media'

export interface LightboxSource {
  mxcUrl: string
  alt?: string
  // Optional already-resolved blob URL (used as a placeholder while the
  // full-size image is being fetched, so clicks feel instant).
  placeholderSrc?: string
}

interface ImageViewerContextValue {
  open: (source: LightboxSource) => void
}

const ImageViewerContext = createContext<ImageViewerContextValue | null>(null)

export function useImageViewer() {
  const ctx = useContext(ImageViewerContext)
  if (!ctx) throw new Error('useImageViewer must be used within ImageViewerProvider')
  return ctx
}

export function ImageViewerProvider({ children }: { children: React.ReactNode }) {
  const [source, setSource] = useState<LightboxSource | null>(null)
  const open = useCallback((s: LightboxSource) => setSource(s), [])

  return (
    <ImageViewerContext.Provider value={{ open }}>
      {children}
      {source && <ImageLightbox source={source} onClose={() => setSource(null)} />}
    </ImageViewerContext.Provider>
  )
}

const MIN_ZOOM = 1
const MAX_ZOOM = 8
const ZOOM_STEP = 0.25

function ImageLightbox({ source, onClose }: { source: LightboxSource; onClose: () => void }) {
  const { client } = useMatrix()
  const [fullSrc, setFullSrc] = useState<string | null>(source.placeholderSrc ?? null)
  const [fetchingFull, setFetchingFull] = useState(true)
  const [scale, setScale] = useState(1)
  const [tx, setTx] = useState(0)
  const [ty, setTy] = useState(0)
  const containerRef = useRef<HTMLDivElement>(null)
  const imgRef = useRef<HTMLImageElement>(null)
  const draggingRef = useRef<{ startX: number; startY: number; origTx: number; origTy: number } | null>(null)

  // Fetch the full-resolution original (no scale params)
  useEffect(() => {
    let cancelled = false
    let createdHere: string | null = null
    fetchMediaBlobUrl(source.mxcUrl, client).then(blobUrl => {
      if (cancelled) {
        if (blobUrl) URL.revokeObjectURL(blobUrl)
        return
      }
      if (blobUrl) {
        createdHere = blobUrl
        setFullSrc(blobUrl)
      }
      setFetchingFull(false)
    })
    return () => {
      cancelled = true
      // Revoke only the URL we created here — not the caller's placeholder.
      if (createdHere) URL.revokeObjectURL(createdHere)
    }
  }, [source.mxcUrl, client])

  // Close on Escape / zoom shortcuts
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') { e.preventDefault(); onClose() }
      else if (e.key === '+' || e.key === '=') { e.preventDefault(); zoomBy(ZOOM_STEP) }
      else if (e.key === '-' || e.key === '_') { e.preventDefault(); zoomBy(-ZOOM_STEP) }
      else if (e.key === '0') { e.preventDefault(); reset() }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scale, tx, ty])

  // Prevent body scroll while open
  useEffect(() => {
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = prev }
  }, [])

  function reset() {
    setScale(1)
    setTx(0)
    setTy(0)
  }

  // Scale around a point in viewport coordinates so the pixel under the cursor
  // stays under the cursor. Math: to keep point P fixed while scaling from s1
  // to s2, the new translate is: new_t = P - (P - t) * (s2/s1).
  function zoomAt(clientX: number, clientY: number, newScale: number) {
    const rect = containerRef.current?.getBoundingClientRect()
    if (!rect) return
    const centerX = rect.left + rect.width / 2
    const centerY = rect.top + rect.height / 2
    const px = clientX - centerX
    const py = clientY - centerY
    const ratio = newScale / scale
    const newTx = px - (px - tx) * ratio
    const newTy = py - (py - ty) * ratio
    const clamped = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, newScale))
    setScale(clamped)
    if (clamped === 1) {
      setTx(0); setTy(0)
    } else {
      setTx(newTx); setTy(newTy)
    }
  }

  function zoomBy(delta: number) {
    const rect = containerRef.current?.getBoundingClientRect()
    if (!rect) { setScale(s => Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, s + delta))); return }
    zoomAt(rect.left + rect.width / 2, rect.top + rect.height / 2, scale + delta)
  }

  function onWheel(e: React.WheelEvent) {
    e.preventDefault()
    // Deltas vary wildly between trackpads and wheels — normalise to ZOOM_STEP.
    const direction = e.deltaY < 0 ? 1 : -1
    const magnitude = Math.min(3, Math.max(1, Math.abs(e.deltaY) / 100))
    const delta = direction * ZOOM_STEP * magnitude
    zoomAt(e.clientX, e.clientY, scale + delta)
  }

  function onDoubleClick(e: React.MouseEvent) {
    if (scale > 1.01) {
      reset()
    } else {
      zoomAt(e.clientX, e.clientY, 2.5)
    }
  }

  function onPointerDown(e: React.PointerEvent) {
    if (scale <= 1) return
    if (e.button !== 0) return
    draggingRef.current = { startX: e.clientX, startY: e.clientY, origTx: tx, origTy: ty }
    imgRef.current?.setPointerCapture(e.pointerId)
    e.preventDefault()
  }
  function onPointerMove(e: React.PointerEvent) {
    const drag = draggingRef.current
    if (!drag) return
    setTx(drag.origTx + (e.clientX - drag.startX))
    setTy(drag.origTy + (e.clientY - drag.startY))
  }
  function onPointerUp(e: React.PointerEvent) {
    if (!draggingRef.current) return
    draggingRef.current = null
    imgRef.current?.releasePointerCapture(e.pointerId)
  }

  function onBackgroundClick(e: React.MouseEvent) {
    // Only close when clicking outside the image itself
    if (e.target === e.currentTarget) onClose()
  }

  async function handleDownload() {
    if (!fullSrc) return
    const a = document.createElement('a')
    a.href = fullSrc
    a.download = source.alt || 'image'
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
  }

  const zoomedIn = scale > 1.01
  const pct = Math.round(scale * 100)

  return createPortal(
    <div className="lightbox-overlay" onClick={onBackgroundClick} role="dialog" aria-modal="true" aria-label="Image preview">
      <div className="lightbox-toolbar">
        <button className="lightbox-btn" onClick={() => zoomBy(-ZOOM_STEP)} title="Zoom out (−)" aria-label="Zoom out" type="button">−</button>
        <button className="lightbox-btn lightbox-pct" onClick={reset} title="Reset zoom (0)" aria-label="Reset zoom" type="button">{pct}%</button>
        <button className="lightbox-btn" onClick={() => zoomBy(ZOOM_STEP)} title="Zoom in (+)" aria-label="Zoom in" type="button">+</button>
        <button className="lightbox-btn" onClick={handleDownload} title="Download" aria-label="Download" type="button" disabled={!fullSrc}>
          <DownloadIcon />
        </button>
        <button className="lightbox-btn lightbox-close" onClick={onClose} title="Close (Esc)" aria-label="Close" type="button">✕</button>
      </div>

      <div
        ref={containerRef}
        className="lightbox-stage"
        onWheel={onWheel}
        onDoubleClick={onDoubleClick}
        onClick={onBackgroundClick}
      >
        {!fullSrc && fetchingFull && <div className="lightbox-spinner"><div className="spinner" /></div>}
        {fullSrc && (
          <img
            ref={imgRef}
            className="lightbox-img"
            src={fullSrc}
            alt={source.alt ?? ''}
            draggable={false}
            style={{
              transform: `translate(${tx}px, ${ty}px) scale(${scale})`,
              cursor: zoomedIn ? (draggingRef.current ? 'grabbing' : 'grab') : 'zoom-in',
            }}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
            onClick={e => e.stopPropagation()}
          />
        )}
      </div>

      <div className="lightbox-hint">
        <kbd>scroll</kbd> zoom · <kbd>dbl-click</kbd> toggle · <kbd>esc</kbd> close
      </div>
    </div>,
    document.body,
  )
}

function DownloadIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="7 10 12 15 17 10" />
      <line x1="12" y1="15" x2="12" y2="3" />
    </svg>
  )
}
