import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { MatrixProvider, useMatrix } from './context/MatrixContext'
import { initLocale } from './services/i18n'
import { getThemeMode } from './services/themes'
import Login from './components/Login'
import SpaceBar from './components/SpaceBar'
import ChannelSidebar from './components/ChannelSidebar'
import ChatArea from './components/ChatArea'
import MemberList from './components/MemberList'
import VerificationModal from './components/VerificationModal'
import CallOverlay from './components/CallOverlay'
import QuickSwitcher from './components/QuickSwitcher'
import { ImageViewerProvider } from './components/ImageLightbox'

function RecoveryKeyModal() {
  const { ssKeyRequest, provideRecoveryKey, cancelRecoveryKeyRequest } = useMatrix()
  const [input, setInput] = useState('')
  const [error, setError] = useState<string | null>(null)

  if (!ssKeyRequest) return null

  function handleSubmit() {
    if (!input.trim()) return
    setError(null)
    try {
      provideRecoveryKey(input.trim())
      setInput('')
    } catch (e: any) {
      setError(e?.message ?? 'Invalid recovery key')
    }
  }

  function handleCancel() {
    cancelRecoveryKeyRequest()
    setInput('')
    setError(null)
  }

  return createPortal(
    <div className="settings-overlay" onClick={e => { if (e.target === e.currentTarget) handleCancel() }}>
      <div className="recovery-modal">
        <h2 className="settings-heading">Recovery Key Required</h2>
        <p className="settings-description">
          Enter your recovery key to access your encrypted message history.
        </p>
        {error && <p className="settings-notif-warning">{error}</p>}
        <input
          className="settings-edit-input"
          style={{ width: '100%', fontFamily: 'monospace', fontSize: 13, marginTop: 12 }}
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') handleSubmit(); if (e.key === 'Escape') handleCancel() }}
          placeholder="EsXV gK7N 2pJR ..."
          autoFocus
        />
        <div style={{ display: 'flex', gap: 8, marginTop: 16, justifyContent: 'flex-end' }}>
          <button className="btn-secondary" onClick={handleCancel}>Cancel</button>
          <button className="settings-save-btn" onClick={handleSubmit} disabled={!input.trim()}>Confirm</button>
        </div>
      </div>
    </div>,
    document.body,
  )
}

function PanelResizer({ side }: { side: 'left' | 'right' }) {
  const storageKey = side === 'left' ? 'vc_sidebar_width' : 'vc_member_list_width'
  const cssVar = side === 'left' ? '--channel-sidebar-width' : '--member-list-width'
  const defaultWidth = 240
  const minWidth = 160
  const maxWidth = 500

  const [width, setWidth] = useState<number>(() => {
    const raw = parseInt(localStorage.getItem(storageKey) ?? '', 10)
    return Number.isFinite(raw) && raw > 0 ? raw : defaultWidth
  })

  useEffect(() => {
    document.documentElement.style.setProperty(cssVar, `${width}px`)
    localStorage.setItem(storageKey, String(width))
  }, [width, cssVar, storageKey])

  function onMouseDown(e: React.MouseEvent) {
    e.preventDefault()
    const startX = e.clientX
    const startWidth = width
    function onMove(ev: MouseEvent) {
      const delta = ev.clientX - startX
      const next = side === 'left' ? startWidth + delta : startWidth - delta
      setWidth(Math.max(minWidth, Math.min(maxWidth, next)))
    }
    function onUp() {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
  }

  function onDoubleClick() {
    setWidth(defaultWidth)
  }

  return (
    <div
      className={`panel-resizer panel-resizer--${side}`}
      onMouseDown={onMouseDown}
      onDoubleClick={onDoubleClick}
      role="separator"
      aria-orientation="vertical"
      title="Drag to resize (double-click to reset)"
    />
  )
}

function AppContent() {
  const { state, loginWithSsoToken } = useMatrix()
  const [ssoError, setSsoError] = useState<string | null>(null)
  const [ssoLoading, setSsoLoading] = useState(false)

  const [isMobile, setIsMobile] = useState(() =>
    typeof window !== 'undefined' && window.matchMedia('(max-width: 768px)').matches,
  )
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 768px)')
    const handler = (e: MediaQueryListEvent) => setIsMobile(e.matches)
    mq.addEventListener('change', handler)
    return () => mq.removeEventListener('change', handler)
  }, [])

  // Desktop collapse preference (persisted). Ignored on mobile.
  const [desktopSidebarOpen, setDesktopSidebarOpen] = useState(
    () => localStorage.getItem('vc_sidebar_open') !== 'false',
  )
  useEffect(() => {
    localStorage.setItem('vc_sidebar_open', String(desktopSidebarOpen))
  }, [desktopSidebarOpen])

  // Mobile drawers are transient — always start closed, never persisted.
  const [mobileDrawerOpen, setMobileDrawerOpen] = useState(false)
  const [mobileMemberDrawerOpen, setMobileMemberDrawerOpen] = useState(false)

  const sidebarOpen = isMobile ? mobileDrawerOpen : desktopSidebarOpen
  const toggleSidebar = () => {
    if (isMobile) {
      setMobileDrawerOpen(v => !v)
      setMobileMemberDrawerOpen(false)
    } else setDesktopSidebarOpen(v => !v)
  }
  const toggleMembers = () => {
    if (!isMobile) return
    setMobileMemberDrawerOpen(v => !v)
    setMobileDrawerOpen(false)
  }

  // Auto-close mobile drawers when a room is selected
  useEffect(() => {
    if (state.activeRoomId && isMobile) {
      setMobileDrawerOpen(false)
      setMobileMemberDrawerOpen(false)
    }
  }, [state.activeRoomId, isMobile])

  // Reset mobile drawers when switching viewports so state stays predictable
  useEffect(() => {
    if (!isMobile) {
      setMobileDrawerOpen(false)
      setMobileMemberDrawerOpen(false)
    }
  }, [isMobile])

  // Escape closes whichever mobile drawer is open
  useEffect(() => {
    if (!isMobile || (!mobileDrawerOpen && !mobileMemberDrawerOpen)) return
    function onKey(e: KeyboardEvent) {
      if (e.key !== 'Escape') return
      setMobileDrawerOpen(false)
      setMobileMemberDrawerOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [isMobile, mobileDrawerOpen, mobileMemberDrawerOpen])

  // Handle SSO redirect callback: ?loginToken=<token>
  // The homeserver is only read from localStorage (set at SSO initiation);
  // trusting a URL-supplied homeserver would let an attacker redirect the
  // loginToken exchange to a server they control.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const token = params.get('loginToken')
    const homeserver = localStorage.getItem('mx_sso_homeserver')
    if (!token || !homeserver) return

    setSsoLoading(true)
    // Clean the URL immediately so a refresh doesn't re-attempt
    window.history.replaceState({}, '', window.location.pathname)
    localStorage.removeItem('mx_sso_homeserver')

    loginWithSsoToken(homeserver, token)
      .catch(err => {
        setSsoError(err?.message ?? 'SSO login failed')
      })
      .finally(() => setSsoLoading(false))
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  if (ssoLoading) {
    return (
      <div className="login-page">
        <div className="login-card">
          <div className="spinner" style={{ margin: '0 auto 1rem' }} />
          <p className="subtitle" style={{ textAlign: 'center' }}>Completing sign-in…</p>
        </div>
      </div>
    )
  }

  if (!state.isLoggedIn) {
    return <Login ssoError={ssoError} />
  }

  return (
    <ImageViewerProvider>
      <div
        className="app-layout"
        data-sidebar-open={sidebarOpen ? 'true' : 'false'}
        data-member-drawer-open={mobileMemberDrawerOpen ? 'true' : 'false'}
      >
        <div
          className="mobile-drawer-backdrop"
          onClick={() => {
            setMobileDrawerOpen(false)
            setMobileMemberDrawerOpen(false)
          }}
          aria-hidden="true"
        />
        <SpaceBar />
        <ChannelSidebar />
        {!isMobile && sidebarOpen && <PanelResizer side="left" />}
        <ChatArea
          sidebarOpen={sidebarOpen}
          onToggleSidebar={toggleSidebar}
          onToggleMembers={toggleMembers}
        />
        {!isMobile && state.activeRoomId && <PanelResizer side="right" />}
        <MemberList />
        <VerificationModal />
        <RecoveryKeyModal />
        <CallOverlay />
        <QuickSwitcher />
      </div>
    </ImageViewerProvider>
  )
}

export default function App() {
  useEffect(() => {
    const theme = localStorage.getItem('vc_theme') ?? 'dark'
    document.documentElement.setAttribute('data-theme', theme)
    document.documentElement.setAttribute('data-theme-mode', getThemeMode(theme))
    const fontSize = localStorage.getItem('vc_font_size')
    if (fontSize) {
      document.documentElement.style.setProperty('--app-font-size', `${fontSize}px`)
    }
    const layout = localStorage.getItem('vc_layout') ?? 'default'
    document.documentElement.setAttribute('data-layout', layout)
    const sidenav = localStorage.getItem('vc_sidenav') ?? 'floating'
    document.documentElement.setAttribute('data-sidenav', sidenav)
    const glass = localStorage.getItem('vc_glass') ?? 'on'
    document.documentElement.setAttribute('data-glass', glass)
    initLocale()
  }, [])

  return (
    <MatrixProvider>
      <AppContent />
    </MatrixProvider>
  )
}
