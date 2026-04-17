import React, { useState, useEffect, useRef } from 'react'
import { useMatrix } from '../context/MatrixContext'
import type { StickerPack } from '../context/MatrixContext'
import { runtimeConfig } from '../runtimeConfig'

const API_KEY = runtimeConfig.KLIPY_API_KEY || undefined
const KLIPY_BASE = 'https://api.klipy.com/api/v1'

interface KlipyFile {
  url: string
}

interface KlipyItem {
  id: string | number
  title: string
  file: {
    xs?: { jpg?: KlipyFile; gif?: KlipyFile }
    sm?: { jpg?: KlipyFile; gif?: KlipyFile }
    hd?: { gif?: KlipyFile }
    gif?: KlipyFile
  }
}

interface GifFavorite {
  url: string
  title: string
  thumb: string
}

interface GifPickerProps {
  onSelect: (gifUrl: string, title: string) => void
  onClose: () => void
}

function loadFavorites(): GifFavorite[] {
  try { return JSON.parse(localStorage.getItem('vc_gif_favorites') ?? '[]') } catch { return [] }
}
function saveFavorites(favs: GifFavorite[]) {
  localStorage.setItem('vc_gif_favorites', JSON.stringify(favs))
}

const PER_PAGE = 30

export default function GifPicker({ onSelect, onClose }: GifPickerProps) {
  const { client, getStickerPacks, saveStickerPacks } = useMatrix()
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<KlipyItem[]>([])
  const [loading, setLoading] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [page, setPage] = useState(1)
  const [hasMore, setHasMore] = useState(true)
  const [activeTab, setActiveTab] = useState<'search' | 'favorites'>('search')
  const [favorites, setFavorites] = useState<GifFavorite[]>(loadFavorites)
  const [packMenuGif, setPackMenuGif] = useState<{ url: string; title: string; thumb: string } | null>(null)
  const [packs, setPacks] = useState<StickerPack[]>([])
  const [packsLoaded, setPacksLoaded] = useState(false)
  const [addedToPackId, setAddedToPackId] = useState<string | null>(null)
  const [addingToPackId, setAddingToPackId] = useState<string | null>(null)
  const [addError, setAddError] = useState<string | null>(null)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const sentinelRef = useRef<HTMLDivElement>(null)
  // Invalidates in-flight requests when the query changes mid-fetch.
  const fetchVersionRef = useRef(0)

  async function fetchGifs(q: string, p: number, append: boolean) {
    if (!API_KEY) return
    const version = ++fetchVersionRef.current
    if (append) setLoadingMore(true); else setLoading(true)
    try {
      const endpoint = q.trim()
        ? `${KLIPY_BASE}/${API_KEY}/gifs/search?q=${encodeURIComponent(q)}&per_page=${PER_PAGE}&page=${p}`
        : `${KLIPY_BASE}/${API_KEY}/gifs/trending?per_page=${PER_PAGE}&page=${p}`
      const res = await fetch(endpoint)
      const data = await res.json()
      // Stale: a newer fetch has been issued, drop these results.
      if (version !== fetchVersionRef.current) return
      const items: KlipyItem[] = data?.data?.data ?? []
      setResults(prev => append ? [...prev, ...items] : items)
      setPage(p)
      setHasMore(items.length === PER_PAGE)
    } catch {
      if (version !== fetchVersionRef.current) return
      if (!append) setResults([])
      setHasMore(false)
    } finally {
      if (version === fetchVersionRef.current) {
        setLoading(false)
        setLoadingMore(false)
      }
    }
  }

  // Load trending on mount
  useEffect(() => {
    if (API_KEY) fetchGifs('', 1, false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function handleQueryChange(e: React.ChangeEvent<HTMLInputElement>) {
    const val = e.target.value
    setQuery(val)
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => fetchGifs(val, 1, false), 400)
  }

  // Infinite scroll: fetch the next page when the sentinel comes into view.
  useEffect(() => {
    if (activeTab !== 'search') return
    if (!API_KEY) return
    if (!hasMore || loading || loadingMore) return
    const sentinel = sentinelRef.current
    if (!sentinel) return
    const obs = new IntersectionObserver(entries => {
      if (entries[0].isIntersecting) {
        fetchGifs(query, page + 1, true)
      }
    }, { rootMargin: '200px' })
    obs.observe(sentinel)
    return () => obs.disconnect()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab, hasMore, loading, loadingMore, page, query])

  // Close on Escape
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        if (packMenuGif) { setPackMenuGif(null); return }
        onClose()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, packMenuGif])

  function isFavorited(url: string) {
    return favorites.some(f => f.url === url)
  }

  function toggleFavorite(url: string, title: string, thumb: string) {
    const next = isFavorited(url)
      ? favorites.filter(f => f.url !== url)
      : [...favorites, { url, title, thumb }]
    setFavorites(next)
    saveFavorites(next)
  }

  async function openPackMenu(url: string, title: string, thumb: string) {
    setPackMenuGif({ url, title, thumb })
    if (!packsLoaded) {
      const loaded = await getStickerPacks()
      setPacks(loaded)
      setPacksLoaded(true)
    }
  }

  async function addToStickerPack(packId: string) {
    if (!packMenuGif || !client) return
    setAddError(null)
    setAddingToPackId(packId)
    try {
      // Klipy serves the GIF over HTTPS; we need an mxc:// URL on the
      // homeserver so other clients (and our own renderer) can display it.
      const resp = await fetch(packMenuGif.url)
      if (!resp.ok) throw new Error(`Fetch failed: ${resp.status}`)
      const blob = await resp.blob()
      const mimetype = blob.type || 'image/gif'
      const file = new File([blob], 'sticker.gif', { type: mimetype })
      const upload = await (client as any).uploadContent(file, { type: mimetype })
      const mxcUrl: string | undefined = upload?.content_uri
      if (!mxcUrl) throw new Error('Upload returned no content_uri')

      const currentPacks = await getStickerPacks()
      const pack = currentPacks.find(p => p.id === packId)
      if (!pack) throw new Error('Pack vanished')
      pack.stickers = [...pack.stickers, {
        id: `gif_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        body: packMenuGif.title,
        url: mxcUrl,
        mimetype,
      }]
      await saveStickerPacks(currentPacks)
      setAddingToPackId(null)
      setAddedToPackId(packId)
      setTimeout(() => {
        setAddedToPackId(null)
        setPackMenuGif(null)
      }, 800)
    } catch (err: any) {
      console.error('Add-to-pack failed:', err)
      setAddingToPackId(null)
      setAddError(err?.message ?? 'Failed to add sticker')
    }
  }

  // Build gif item list from API results
  const gifItems = results.map(gif => {
    const thumb = gif.file?.xs?.gif?.url ?? gif.file?.sm?.gif?.url ?? gif.file?.gif?.url
    const full = gif.file?.hd?.gif?.url ?? gif.file?.gif?.url
    if (!thumb || !full) return null
    return { id: gif.id, thumb, full, title: gif.title || 'GIF' }
  }).filter(Boolean) as { id: string | number; thumb: string; full: string; title: string }[]

  return (
    <div className="gif-picker">
      <div className="gif-picker-header">
        <div className="gif-picker-tabs-row">
          <button
            className={`gif-tab-btn${activeTab === 'search' ? ' active' : ''}`}
            onClick={() => setActiveTab('search')}
          >
            GIFs
          </button>
          <button
            className={`gif-tab-btn${activeTab === 'favorites' ? ' active' : ''}`}
            onClick={() => setActiveTab('favorites')}
          >
            Favorites
            {favorites.length > 0 && <span className="gif-tab-count">{favorites.length}</span>}
          </button>
        </div>
        {activeTab === 'search' && (
          <input
            className="gif-search-input"
            type="text"
            placeholder="Search GIFs…"
            value={query}
            onChange={handleQueryChange}
            autoFocus
          />
        )}
      </div>

      {/* Pack selection overlay */}
      {packMenuGif && (
        <div className="gif-pack-overlay">
          <div className="gif-pack-menu">
            <div className="gif-pack-menu-title">Add to sticker pack</div>
            {packs.length === 0 ? (
              <div className="gif-pack-menu-empty">
                No sticker packs yet.<br />Create one in Settings &gt; Sticker Packs.
              </div>
            ) : (
              packs.map(p => {
                const isAdding = addingToPackId === p.id
                const isAdded = addedToPackId === p.id
                const busy = addingToPackId !== null || addedToPackId !== null
                let label: string
                if (isAdded) label = '✓ Added!'
                else if (isAdding) label = 'Uploading…'
                else label = p.name
                return (
                  <button
                    key={p.id}
                    className={`gif-pack-menu-item${isAdded ? ' added' : ''}${isAdding ? ' adding' : ''}`}
                    onClick={() => addToStickerPack(p.id)}
                    disabled={busy}
                  >
                    {label}
                  </button>
                )
              })
            )}
            {addError && <div className="gif-pack-menu-error">{addError}</div>}
            <button className="gif-pack-menu-cancel" onClick={() => setPackMenuGif(null)}>
              Cancel
            </button>
          </div>
        </div>
      )}

      <div className="gif-grid">
        {activeTab === 'favorites' ? (
          favorites.length === 0 ? (
            <div className="gif-empty">
              <span>♡</span>
              <p>No favorites yet.<br />Click ♡ on any GIF to save it here.</p>
            </div>
          ) : (
            favorites.map(fav => (
              <div key={fav.url} className="gif-item gif-item--actions" title={fav.title}>
                <img
                  src={fav.thumb}
                  alt={fav.title}
                  loading="lazy"
                  onClick={() => { onSelect(fav.url, fav.title); onClose() }}
                />
                <div className="gif-item-btns">
                  <button
                    className="gif-item-btn gif-item-btn--fav active"
                    onClick={e => { e.stopPropagation(); toggleFavorite(fav.url, fav.title, fav.thumb) }}
                    title="Remove from favorites"
                  >♥</button>
                  <button
                    className="gif-item-btn gif-item-btn--pack"
                    onClick={e => { e.stopPropagation(); openPackMenu(fav.url, fav.title, fav.thumb) }}
                    title="Add to sticker pack"
                  >+</button>
                </div>
              </div>
            ))
          )
        ) : !API_KEY ? (
          <div className="gif-empty">
            <span>🔑</span>
            <p>
              Set <code>VITE_KLIPY_API_KEY</code> in your <code>.env</code> file to enable GIFs.
              <br />
              <a href="https://klipy.com/developers" target="_blank" rel="noreferrer">
                Get a free KLIPY API key
              </a>
            </p>
          </div>
        ) : loading ? (
          <div className="gif-empty">
            <div className="spinner" />
          </div>
        ) : gifItems.length === 0 ? (
          <div className="gif-empty">
            <span>🔍</span>
            <p>No GIFs found</p>
          </div>
        ) : (
          <>
            {gifItems.map(gif => {
              const favorited = isFavorited(gif.full)
              return (
                <div key={gif.id} className="gif-item gif-item--actions" title={gif.title}>
                  <img
                    src={gif.thumb}
                    alt={gif.title}
                    loading="lazy"
                    onClick={() => { onSelect(gif.full, gif.title); onClose() }}
                  />
                  <div className="gif-item-btns">
                    <button
                      className={`gif-item-btn gif-item-btn--fav${favorited ? ' active' : ''}`}
                      onClick={e => { e.stopPropagation(); toggleFavorite(gif.full, gif.title, gif.thumb) }}
                      title={favorited ? 'Remove from favorites' : 'Add to favorites'}
                    >{favorited ? '♥' : '♡'}</button>
                    <button
                      className="gif-item-btn gif-item-btn--pack"
                      onClick={e => { e.stopPropagation(); openPackMenu(gif.full, gif.title, gif.thumb) }}
                      title="Add to sticker pack"
                    >+</button>
                  </div>
                </div>
              )
            })}
            {hasMore && (
              <div ref={sentinelRef} className="gif-load-more">
                {loadingMore && <div className="spinner" />}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}
