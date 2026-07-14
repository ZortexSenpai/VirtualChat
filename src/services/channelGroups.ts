// User-defined channel groups (Discord-style categories) for the channel
// sidebar. Groups are scoped per view — one list for Home, one per space —
// and persisted the same way as the space order: optimistic local state,
// localStorage fallback, and a custom account-data key so they sync across
// devices.

export const CHANNEL_GROUPS_EVENT = 'vc.channel_groups'
export const CHANNEL_ORDER_EVENT = 'vc.channel_order'
const LOCAL_STORAGE_KEY = 'vc_channel_groups'
const ORDER_STORAGE_KEY = 'vc_channel_order'
const COLLAPSED_STORAGE_KEY = 'vc_collapsed_groups'

export interface ChannelGroup {
  id: string
  name: string
  roomIds: string[]
}

/** Group lists keyed by scope: a space room ID, or 'home' for the Home view. */
export type ChannelGroupsByScope = Record<string, ChannelGroup[]>

/** Ungrouped-channel display order (room IDs) keyed by the same scopes. */
export type ChannelOrderByScope = Record<string, string[]>

export function channelGroupScope(spaceId: string | null): string {
  return spaceId ?? 'home'
}

export function newGroupId(): string {
  return `grp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

function isValidGroup(g: unknown): g is ChannelGroup {
  if (!g || typeof g !== 'object') return false
  const c = g as Record<string, unknown>
  return typeof c.id === 'string'
    && typeof c.name === 'string'
    && Array.isArray(c.roomIds)
    && c.roomIds.every(id => typeof id === 'string')
}

/**
 * Validate account-data / localStorage content into a groups map.
 * Returns null if the shape is unusable (so callers keep their current state).
 */
export function parseChannelGroups(content: unknown): ChannelGroupsByScope | null {
  const scopes = (content as { scopes?: unknown } | undefined)?.scopes
  if (!scopes || typeof scopes !== 'object' || Array.isArray(scopes)) return null
  const result: ChannelGroupsByScope = {}
  for (const [scope, groups] of Object.entries(scopes as Record<string, unknown>)) {
    if (!Array.isArray(groups)) return null
    if (!groups.every(isValidGroup)) return null
    result[scope] = groups
  }
  return result
}

export function readLocalChannelGroups(): ChannelGroupsByScope {
  try {
    const raw = localStorage.getItem(LOCAL_STORAGE_KEY)
    if (!raw) return {}
    return parseChannelGroups(JSON.parse(raw)) ?? {}
  } catch { /* ignore */ }
  return {}
}

export function saveLocalChannelGroups(groups: ChannelGroupsByScope) {
  try { localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify({ scopes: groups })) } catch { /* ignore quota */ }
}

/**
 * Validate account-data / localStorage content into an order map.
 * Returns null if the shape is unusable (so callers keep their current state).
 */
export function parseChannelOrder(content: unknown): ChannelOrderByScope | null {
  const scopes = (content as { scopes?: unknown } | undefined)?.scopes
  if (!scopes || typeof scopes !== 'object' || Array.isArray(scopes)) return null
  const result: ChannelOrderByScope = {}
  for (const [scope, ids] of Object.entries(scopes as Record<string, unknown>)) {
    if (!Array.isArray(ids) || !ids.every(id => typeof id === 'string')) return null
    result[scope] = ids
  }
  return result
}

export function readLocalChannelOrder(): ChannelOrderByScope {
  try {
    const raw = localStorage.getItem(ORDER_STORAGE_KEY)
    if (!raw) return {}
    return parseChannelOrder(JSON.parse(raw)) ?? {}
  } catch { /* ignore */ }
  return {}
}

export function saveLocalChannelOrder(order: ChannelOrderByScope) {
  try { localStorage.setItem(ORDER_STORAGE_KEY, JSON.stringify({ scopes: order })) } catch { /* ignore quota */ }
}

/**
 * Apply a saved order: known ids first (in saved order), then any remaining
 * rooms in their default order — same semantics as the space bar's ordering.
 */
export function applyRoomOrder<T extends { roomId: string }>(rooms: T[], order: string[]): T[] {
  if (order.length === 0) return rooms
  const byId = new Map(rooms.map(r => [r.roomId, r]))
  const ordered: T[] = []
  const seen = new Set<string>()
  for (const id of order) {
    const r = byId.get(id)
    if (r && !seen.has(id)) {
      ordered.push(r)
      seen.add(id)
    }
  }
  for (const r of rooms) {
    if (!seen.has(r.roomId)) ordered.push(r)
  }
  return ordered
}

// Collapse state is a per-device UI preference, so it stays in localStorage only.

export function readCollapsedGroups(): Set<string> {
  try {
    const parsed = JSON.parse(localStorage.getItem(COLLAPSED_STORAGE_KEY) ?? '[]')
    if (Array.isArray(parsed)) return new Set(parsed.filter(x => typeof x === 'string'))
  } catch { /* ignore */ }
  return new Set()
}

export function saveCollapsedGroups(ids: Set<string>) {
  try { localStorage.setItem(COLLAPSED_STORAGE_KEY, JSON.stringify([...ids])) } catch { /* ignore quota */ }
}
