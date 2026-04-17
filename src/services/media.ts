// Fetch Matrix media (mxc://) as an object URL.
//
// Matrix 1.11 requires authenticated media endpoints; older homeservers still
// serve the legacy unauthenticated URL. We try authenticated first and fall
// back to legacy on 4xx / network failure.
//
// Pass resize params to request a thumbnail; omit them for original.
export interface FetchMediaOpts {
  width?: number
  height?: number
  method?: 'crop' | 'scale'
}

export async function fetchMediaBlobUrl(
  mxcUrl: string,
  client: any,
  opts: FetchMediaOpts = {},
): Promise<string | null> {
  if (!mxcUrl?.startsWith('mxc://') || !client) return null
  const token = localStorage.getItem('mx_access_token')

  const { width, height, method } = opts
  const hasThumbParams = width != null && height != null

  let primaryUrl: string | null
  let legacyUrl: string | null
  if (hasThumbParams) {
    primaryUrl = token
      ? (client.mxcUrlToHttp(mxcUrl, width, height, method ?? 'scale', false, undefined, true) ?? null)
      : (client.mxcUrlToHttp(mxcUrl, width, height, method ?? 'scale') ?? null)
    legacyUrl = client.mxcUrlToHttp(mxcUrl, width, height, method ?? 'scale') ?? null
  } else {
    primaryUrl = token
      ? (client.mxcUrlToHttp(mxcUrl, undefined, undefined, undefined, false, undefined, true) ?? null)
      : (client.mxcUrlToHttp(mxcUrl) ?? null)
    legacyUrl = client.mxcUrlToHttp(mxcUrl) ?? null
  }
  if (!primaryUrl) return null

  try {
    const r = await fetch(primaryUrl, token ? { headers: { Authorization: `Bearer ${token}` } } : undefined)
    if (r.ok) return URL.createObjectURL(await r.blob())
    // If server returns a hard error (not a not-implemented), give up rather than retrying legacy
    if (r.status !== 404 && r.status !== 405 && r.status !== 400) return null
  } catch { /* try legacy below */ }

  if (!legacyUrl || legacyUrl === primaryUrl) return null
  try {
    const r2 = await fetch(legacyUrl)
    if (r2.ok) return URL.createObjectURL(await r2.blob())
  } catch { /* fall through */ }
  return null
}
