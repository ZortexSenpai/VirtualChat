type RuntimeConfig = {
  KLIPY_API_KEY: string
  DEFAULT_HOMESERVER: string
  LOCK_HOMESERVER: string
}

declare global {
  interface Window {
    __CONFIG__?: Partial<RuntimeConfig>
  }
}

const pick = (runtime: string | undefined, build: unknown): string => {
  const r = (runtime ?? '').trim()
  if (r) return r
  return String(build ?? '').trim()
}

const rc = typeof window !== 'undefined' ? window.__CONFIG__ : undefined

export const runtimeConfig: RuntimeConfig = {
  KLIPY_API_KEY: pick(rc?.KLIPY_API_KEY, import.meta.env.VITE_KLIPY_API_KEY),
  DEFAULT_HOMESERVER: pick(rc?.DEFAULT_HOMESERVER, import.meta.env.VITE_DEFAULT_HOMESERVER),
  LOCK_HOMESERVER: pick(rc?.LOCK_HOMESERVER, import.meta.env.VITE_LOCK_HOMESERVER),
}
