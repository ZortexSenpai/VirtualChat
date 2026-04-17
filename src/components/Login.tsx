import React, { useEffect, useState } from 'react'
import { createClient } from 'matrix-js-sdk'
import { useMatrix } from '../context/MatrixContext'
import { useTranslation } from '../services/i18n'
import { runtimeConfig } from '../runtimeConfig'

interface LoginProps {
  ssoError?: string | null
}

const DEFAULT_HOMESERVER = runtimeConfig.DEFAULT_HOMESERVER
const LOCK_HOMESERVER = /^(1|true|yes)$/i.test(runtimeConfig.LOCK_HOMESERVER)

export default function Login({ ssoError }: LoginProps) {
  const { t } = useTranslation()
  const { login } = useMatrix()
  const [homeserver, setHomeserver] = useState(DEFAULT_HOMESERVER)
  const [userId, setUserId] = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [ssoLoading, setSsoLoading] = useState(false)
  const [authFlows, setAuthFlows] = useState<string[] | null>(null)
  const [flowsLoading, setFlowsLoading] = useState(false)
  const [flowsDetectionFailed, setFlowsDetectionFailed] = useState(false)

  // Detect supported auth flows when homeserver URL changes
  useEffect(() => {
    const hs = homeserver.trim().replace(/\/$/, '')
    if (!hs.startsWith('http')) {
      setAuthFlows(null)
      setFlowsLoading(false)
      setFlowsDetectionFailed(false)
      return
    }

    setAuthFlows(null)
    setFlowsDetectionFailed(false)
    setFlowsLoading(true)
    const controller = new AbortController()
    let cancelled = false

    const timer = setTimeout(async () => {
      try {
        const res = await fetch(`${hs}/_matrix/client/v3/login`, { signal: controller.signal })
        if (!res.ok) throw new Error('HTTP ' + res.status)
        const data = await res.json()
        if (!cancelled) setAuthFlows((data.flows ?? []).map((f: any) => f.type as string))
      } catch (err: any) {
        if (!cancelled && err.name !== 'AbortError') {
          setAuthFlows(null)
          setFlowsDetectionFailed(true)
        }
      } finally {
        if (!cancelled) setFlowsLoading(false)
      }
    }, 600)

    return () => {
      cancelled = true
      clearTimeout(timer)
      controller.abort()
    }
  }, [homeserver])

  const hasPassword = authFlows !== null && authFlows.includes('m.login.password')
  const hasSso = authFlows !== null && authFlows.includes('m.login.sso')
  // Show SSO fallback when flows detection failed — server may still support SSO redirect
  const showSsoFallback = flowsDetectionFailed && !hasSso

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!userId.trim() || !password) return
    setLoading(true)
    setError(null)
    try {
      await login(homeserver, userId, password)
    } catch (err: any) {
      const msg =
        err?.data?.error ||
        err?.message ||
        t('login.loginFailed')
      setError(msg)
    } finally {
      setLoading(false)
    }
  }

  async function handleSsoLogin() {
    if (!homeserver.trim()) return
    setSsoLoading(true)
    setError(null)
    try {
      const hs = await resolveHomeserver(homeserver)
      const tempClient = createClient({ baseUrl: hs })
      const redirectUrl = window.location.origin + window.location.pathname
      const ssoUrl = tempClient.getSsoLoginUrl(redirectUrl, 'sso')
      tempClient.stopClient()

      // Verify the SSO redirect endpoint exists before navigating away
      try {
        const probe = await fetch(ssoUrl, { method: 'HEAD', redirect: 'manual' })
        if (probe.status === 404) {
          throw new Error(t('login.ssoError', { hs }))
        }
      } catch (probeErr: any) {
        // Only treat it as a hard error if we got a 404; network/CORS errors are fine —
        // the server may redirect (3xx) or block HEAD requests cross-origin.
        if (probeErr.message?.includes("doesn't support SSO")) throw probeErr
      }

      localStorage.setItem('mx_sso_homeserver', hs)
      window.location.href = ssoUrl
    } catch (err: any) {
      setError(err?.message ?? 'Could not initiate SSO login')
      setSsoLoading(false)
    }
  }

  /** Attempt autodiscovery to find the real homeserver base URL. */
  async function resolveHomeserver(input: string): Promise<string> {
    const hs = input.trim().replace(/\/$/, '')
    try {
      const res = await fetch(`${hs}/.well-known/matrix/client`)
      if (res.ok) {
        const data = await res.json()
        const discovered = data?.['m.homeserver']?.base_url as string | undefined
        if (discovered) return discovered.replace(/\/$/, '')
      }
    } catch {
      // Ignore — fall back to the URL the user typed
    }
    return hs
  }

  const displayError = ssoError ?? error

  return (
    <div className="login-page">
      <div className="login-card">
        <h1>{t('login.welcome')}</h1>
        <p className="subtitle">{t('login.subtitle')}</p>

        {displayError && <div className="login-error">{displayError}</div>}

        {!LOCK_HOMESERVER && (
          <div className="form-group">
            <label>{t('login.homeserver')}</label>
            <input
              type="url"
              value={homeserver}
              onChange={e => setHomeserver(e.target.value)}
              placeholder={t('login.homeserverPlaceholder')}
            />
            {flowsLoading && (
              <span className="flows-detecting">{t('login.detectingSso')}</span>
            )}
          </div>
        )}

        {(hasSso || showSsoFallback) && (
          <button
            type="button"
            className="btn-sso"
            onClick={handleSsoLogin}
            disabled={ssoLoading || loading || flowsLoading}
          >
            {ssoLoading ? t('login.redirecting') : t('login.signInSso')}
          </button>
        )}

        {hasPassword && hasSso && <div className="login-divider"><span>{t('login.or')}</span></div>}

        {hasPassword && (
          <form onSubmit={handleSubmit}>
            <div className="form-group">
              <label>{t('login.username')}</label>
              <input
                type="text"
                value={userId}
                onChange={e => setUserId(e.target.value)}
                placeholder={t('login.usernamePlaceholder')}
                autoFocus
              />
            </div>

            <div className="form-group">
              <label>{t('login.password')}</label>
              <input
                type="password"
                value={password}
                onChange={e => setPassword(e.target.value)}
                placeholder="••••••••"
              />
            </div>

            <button type="submit" className="btn-primary" disabled={loading || ssoLoading}>
              {loading ? t('login.signingIn') : t('login.signInPassword')}
            </button>
          </form>
        )}
      </div>
    </div>
  )
}
