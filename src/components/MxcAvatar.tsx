import React, { useState, useEffect } from 'react'
import { useMatrix } from '../context/MatrixContext'

// Session-scoped cache shared with useMxcBlobUrl.
const blobCache = new Map<string, string | null>()

/**
 * Resolve an mxc:// URL to a blob URL via the authenticated media endpoint.
 * Returns null while loading or on failure.
 *
 * Pass `forceDownload: true` to skip the thumbnail endpoint and go straight to
 * download — required for animated formats (GIF / animated WebP / APNG), since
 * the server-side thumbnailer flattens animations to a single frame.
 */
export function useMxcBlobUrl(
  mxcUrl: string | null,
  width: number,
  height: number,
  method: 'scale' | 'crop' = 'scale',
  forceDownload = false,
): string | null {
  const { client } = useMatrix()
  const cacheKey = mxcUrl ? `${mxcUrl}@${forceDownload ? 'orig' : `${width}x${height}@${method}`}` : null
  const [url, setUrl] = useState<string | null>(() => (cacheKey ? blobCache.get(cacheKey) ?? null : null))

  useEffect(() => {
    if (!mxcUrl || !client) { setUrl(null); return }
    const key = `${mxcUrl}@${forceDownload ? 'orig' : `${width}x${height}@${method}`}`
    if (blobCache.has(key)) { setUrl(blobCache.get(key) ?? null); return }

    const token = localStorage.getItem('mx_access_token')
    const headers = token ? { Authorization: `Bearer ${token}` } : undefined

    const thumbUrl = forceDownload
      ? null
      : (token
          ? (client.mxcUrlToHttp(mxcUrl, width, height, method, false, undefined, true) || null)
          : (client.mxcUrlToHttp(mxcUrl, width, height, method) || null))

    // Download endpoint: primary path for animated formats, fallback otherwise.
    const match = mxcUrl.match(/^mxc:\/\/([^/]+)\/(.+)$/)
    const downloadUrl = match
      ? `${client.baseUrl.replace(/\/$/, '')}${
          token
            ? `/_matrix/client/v1/media/download/${encodeURIComponent(match[1])}/${encodeURIComponent(match[2])}`
            : `/_matrix/media/v3/download/${encodeURIComponent(match[1])}/${encodeURIComponent(match[2])}`
        }`
      : null

    let cancelled = false
    const tryFetch = async (u: string | null): Promise<Blob | null> => {
      if (!u) return null
      try {
        const r = await fetch(u, headers ? { headers } : undefined)
        return r.ok ? await r.blob() : null
      } catch { return null }
    }

    ;(async () => {
      let blob = forceDownload ? null : await tryFetch(thumbUrl)
      if (!blob) blob = await tryFetch(downloadUrl)
      if (cancelled) return
      if (!blob) { blobCache.set(key, null); setUrl(null); return }
      const blobUrl = URL.createObjectURL(blob)
      blobCache.set(key, blobUrl)
      setUrl(blobUrl)
    })()

    return () => { cancelled = true }
  }, [mxcUrl, client, width, height, method, forceDownload])

  return url
}

function avatarColor(name: string): string {
  const colors = [
    '#5865f2', '#57f287', '#fee75c', '#eb459e',
    '#ed4245', '#3ba55c', '#faa61a', '#9b59b6',
  ]
  let hash = 0
  for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash)
  return colors[Math.abs(hash) % colors.length]
}

// Session-scoped cache: mxcUrl@size → blob URL or null (failed)
const cache = new Map<string, string | null>()

interface Props {
  mxcUrl: string | null
  size: number
  name: string
  style?: React.CSSProperties
}

export default function MxcAvatar({ mxcUrl, size, name, style }: Props) {
  const { client } = useMatrix()
  const cacheKey = mxcUrl ? `${mxcUrl}@${size}` : null

  const [imgSrc, setImgSrc] = useState<string | null>(() => {
    if (!cacheKey || !cache.has(cacheKey)) return null
    return cache.get(cacheKey) ?? null
  })

  useEffect(() => {
    if (!mxcUrl || !client) { setImgSrc(null); return }

    const key = `${mxcUrl}@${size}`
    if (cache.has(key)) {
      setImgSrc(cache.get(key) ?? null)
      return
    }

    const token = localStorage.getItem('mx_access_token')

    // Authenticated endpoint (/_matrix/client/v1/media/thumbnail/…) — required on modern servers.
    // Falls back to unauthenticated endpoint when token is absent.
    const url = token
      ? (client.mxcUrlToHttp(mxcUrl, size, size, 'crop', false, undefined, true) || null)
      : (client.mxcUrlToHttp(mxcUrl, size, size, 'crop') || null)

    if (!url) {
      cache.set(key, null)
      setImgSrc(null)
      return
    }

    let cancelled = false
    fetch(url, token ? { headers: { Authorization: `Bearer ${token}` } } : undefined)
      .then(r => (r.ok ? r.blob() : Promise.reject(new Error(String(r.status)))))
      .then(blob => {
        if (cancelled) return
        const blobUrl = URL.createObjectURL(blob)
        cache.set(key, blobUrl)
        setImgSrc(blobUrl)
      })
      .catch(() => {
        if (cancelled) return
        cache.set(key, null)
        setImgSrc(null)
      })

    return () => { cancelled = true }
  }, [mxcUrl, client, size])

  const initial = (name || '?').charAt(0).toUpperCase()

  if (!imgSrc) {
    return (
      <div
        className="avatar-placeholder"
        style={{ width: size, height: size, background: avatarColor(name), ...style }}
      >
        {initial}
      </div>
    )
  }

  // Force the image into a centred square that exactly fills its wrapper. This
  // guards against homeservers that return non-square thumbnails (ignoring the
  // crop param), which otherwise caused the top-left corner to show through a
  // circular wrapper.
  return (
    <img
      src={imgSrc}
      alt={name}
      width={size}
      height={size}
      style={{ width: size, height: size, objectFit: 'cover', display: 'block', ...style }}
    />
  )
}
