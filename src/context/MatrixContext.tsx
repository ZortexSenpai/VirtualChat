import React, {
  createContext,
  useContext,
  useReducer,
  useEffect,
  useRef,
  useState,
  useCallback,
} from 'react'
import {
  createClient,
  MatrixClient,
  MatrixEvent,
  Room,
  RoomMember,
  ClientEvent,
  RoomEvent,
  RoomMemberEvent,
  RoomStateEvent,
  SyncState,
  EventType,
  MsgType,
  SetPresence,
  MemoryStore,
} from 'matrix-js-sdk'
import { CryptoEvent } from 'matrix-js-sdk/lib/crypto-api/CryptoEvent'
import { VerificationPhase } from 'matrix-js-sdk/lib/crypto-api/verification'
import type { VerificationRequest } from 'matrix-js-sdk/lib/crypto-api/verification'
import { decodeRecoveryKey } from 'matrix-js-sdk/lib/crypto-api'
import { MatrixCall, CallEvent, CallState, CallErrorCode, CallDirection } from 'matrix-js-sdk/lib/webrtc/call'
import { CallEventHandlerEvent } from 'matrix-js-sdk/lib/webrtc/callEventHandler'
import { handleIncomingEvent, startCallRingtone, stopCallRingtone } from '../services/notifications'

// ---- Types ----

export interface StickerItem {
  id: string
  body: string
  url: string  // mxc://
  w?: number
  h?: number
  mimetype?: string
}

export interface StickerPack {
  id: string
  name: string
  stickers: StickerItem[]
}

/**
 * MSC2545 image-pack format (used by Element, Cinny, FluffyChat).
 * Items inherit `usage` from the pack if not set; we treat anything
 * declared as "sticker" (or with no usage at all) as a sticker.
 */
interface Msc2545Image {
  url?: string
  body?: string
  info?: { w?: number; h?: number; mimetype?: string }
  usage?: string[]
}
interface Msc2545Pack {
  pack?: { display_name?: string; usage?: string[] }
  images?: Record<string, Msc2545Image>
}

function msc2545ToStickerPack(content: Msc2545Pack, id: string, fallbackName: string): StickerPack | null {
  const packUsage = content.pack?.usage
  // If pack-level usage is declared and excludes "sticker", skip it entirely.
  if (Array.isArray(packUsage) && packUsage.length > 0 && !packUsage.includes('sticker')) return null
  const stickers: StickerItem[] = []
  for (const [shortcode, img] of Object.entries(content.images ?? {})) {
    if (!img?.url || !img.url.startsWith('mxc://')) continue
    const usage = img.usage ?? packUsage
    // Per-image usage filter: include if it allows "sticker" or isn't restricted.
    if (Array.isArray(usage) && usage.length > 0 && !usage.includes('sticker')) continue
    stickers.push({
      id: `${id}:${shortcode}`,
      body: img.body || shortcode,
      url: img.url,
      w: img.info?.w,
      h: img.info?.h,
      mimetype: img.info?.mimetype,
    })
  }
  if (stickers.length === 0) return null
  return { id, name: content.pack?.display_name || fallbackName, stickers }
}

export interface ReactionGroup {
  key: string
  count: number
  myReacted: boolean
  myReactionEventId: string | null
}

export interface KeyBackupStatus {
  crossSigningReady: boolean
  secretStorageReady: boolean
  backupEnabled: boolean
  backupVersion: string | null
}

export interface SsKeyRequest {
  keyId: string
}

export interface ActiveCall {
  call: MatrixCall
  roomId: string
  state: CallState
  direction: 'inbound' | 'outbound'
  peerName: string
  micMuted: boolean
  video: boolean
  cameraMuted: boolean
  localStream: MediaStream | null
  remoteStream: MediaStream | null
}

export interface PollAnswer {
  id: string
  text: string
}

export interface PollData {
  question: string
  answers: PollAnswer[]
  kind: 'm.poll.disclosed' | 'm.poll.undisclosed'
  maxSelections: number
}

export interface MatrixState {
  isLoggedIn: boolean
  userId: string | null
  syncState: SyncState | null
  spaces: Room[]
  spaceOrder: string[]
  rooms: Room[]
  directRooms: Room[]
  activeSpaceId: string | null
  activeRoomId: string | null
  messages: MatrixEvent[]
  members: RoomMember[]
  reactions: Record<string, ReactionGroup[]>
  processedReactionIds: Record<string, true>
  replyTo: MatrixEvent | null
  verificationRequest: VerificationRequest | null
  gifPickerOpen: boolean
  statusModalOpen: boolean
  avatarUploadOpen: boolean
  typingUserIds: string[]
  pendingInvites: Room[]
  readMarkerEventId: string | null
  ignoredUserIds: string[]
  myBannerMxc: string | null
}

type Action =
  | { type: 'LOGIN'; userId: string }
  | { type: 'SYNC_STATE'; state: SyncState }
  | { type: 'SET_SPACES'; spaces: Room[] }
  | { type: 'SET_SPACE_ORDER'; order: string[] }
  | { type: 'SET_ROOMS'; rooms: Room[] }
  | { type: 'SET_DIRECT_ROOMS'; rooms: Room[] }
  | { type: 'SET_ACTIVE_SPACE'; spaceId: string | null }
  | { type: 'SET_ACTIVE_ROOM'; roomId: string | null }
  | { type: 'SET_MESSAGES'; messages: MatrixEvent[] }
  | { type: 'APPEND_MESSAGE'; message: MatrixEvent; roomId: string }
  | { type: 'SET_MEMBERS'; members: RoomMember[] }
  | { type: 'SET_REACTIONS'; reactions: Record<string, ReactionGroup[]>; processedIds: Record<string, true> }
  | { type: 'APPEND_REACTION'; reactionEventId: string; eventId: string; key: string; senderId: string; myUserId: string }
  | { type: 'SET_REPLY_TO'; event: MatrixEvent | null }
  | { type: 'SET_VERIFICATION_REQUEST'; request: VerificationRequest | null }
  | { type: 'TOGGLE_GIF_PICKER' }
  | { type: 'TOGGLE_STATUS_MODAL' }
  | { type: 'TOGGLE_AVATAR_UPLOAD' }
  | { type: 'LOGOUT' }
  | { type: 'SET_TYPING'; userIds: string[] }
  | { type: 'SET_INVITES'; rooms: Room[] }
  | { type: 'SET_READ_MARKER'; eventId: string | null }
  | { type: 'SET_IGNORED_USERS'; userIds: string[] }
  | { type: 'SET_MY_BANNER'; mxc: string | null }

function readLocalSpaceOrder(): string[] {
  try {
    const raw = localStorage.getItem('vc_space_order')
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (Array.isArray(parsed) && parsed.every(x => typeof x === 'string')) return parsed
  } catch { /* ignore */ }
  return []
}

const initialState: MatrixState = {
  isLoggedIn: false,
  userId: null,
  syncState: null,
  spaces: [],
  spaceOrder: readLocalSpaceOrder(),
  rooms: [],
  directRooms: [],
  activeSpaceId: null,
  activeRoomId: null,
  messages: [],
  members: [],
  reactions: {},
  processedReactionIds: {},
  replyTo: null,
  verificationRequest: null,
  gifPickerOpen: false,
  statusModalOpen: false,
  avatarUploadOpen: false,
  typingUserIds: [],
  pendingInvites: [],
  readMarkerEventId: null,
  ignoredUserIds: [],
  myBannerMxc: null,
}

function reducer(state: MatrixState, action: Action): MatrixState {
  switch (action.type) {
    case 'LOGIN':
      return { ...state, isLoggedIn: true, userId: action.userId }
    case 'SYNC_STATE':
      return { ...state, syncState: action.state }
    case 'SET_SPACES':
      return { ...state, spaces: action.spaces }
    case 'SET_SPACE_ORDER':
      return { ...state, spaceOrder: action.order }
    case 'SET_ROOMS':
      return { ...state, rooms: action.rooms }
    case 'SET_DIRECT_ROOMS':
      return { ...state, directRooms: action.rooms }
    case 'SET_ACTIVE_SPACE':
      return { ...state, activeSpaceId: action.spaceId }
    case 'SET_ACTIVE_ROOM':
      return { ...state, activeRoomId: action.roomId, messages: [], members: [], typingUserIds: [], readMarkerEventId: null }
    case 'SET_READ_MARKER':
      return { ...state, readMarkerEventId: action.eventId }
    case 'SET_MESSAGES':
      return { ...state, messages: action.messages }
    case 'APPEND_MESSAGE':
      if (action.roomId !== state.activeRoomId) return state
      if (state.messages.some(m => m.getId() === action.message.getId())) return state
      return { ...state, messages: [...state.messages, action.message] }
    case 'SET_MEMBERS':
      return { ...state, members: action.members }
    case 'SET_REACTIONS':
      return { ...state, reactions: action.reactions, processedReactionIds: action.processedIds }
    case 'APPEND_REACTION': {
      // Deduplicate: skip if we've already processed this reaction event
      if (state.processedReactionIds[action.reactionEventId]) return state
      const groups = [...(state.reactions[action.eventId] ?? [])]
      const idx = groups.findIndex(g => g.key === action.key)
      const isMe = action.senderId === action.myUserId
      if (idx >= 0) {
        groups[idx] = {
          ...groups[idx],
          count: groups[idx].count + 1,
          myReacted: groups[idx].myReacted || isMe,
          myReactionEventId: isMe ? action.reactionEventId : groups[idx].myReactionEventId,
        }
      } else {
        groups.push({ key: action.key, count: 1, myReacted: isMe, myReactionEventId: isMe ? action.reactionEventId : null })
      }
      return {
        ...state,
        reactions: { ...state.reactions, [action.eventId]: groups },
        processedReactionIds: { ...state.processedReactionIds, [action.reactionEventId]: true },
      }
    }
    case 'SET_REPLY_TO':
      return { ...state, replyTo: action.event }
    case 'SET_VERIFICATION_REQUEST':
      return { ...state, verificationRequest: action.request }
    case 'TOGGLE_GIF_PICKER':
      return { ...state, gifPickerOpen: !state.gifPickerOpen }
    case 'TOGGLE_STATUS_MODAL':
      return { ...state, statusModalOpen: !state.statusModalOpen }
    case 'TOGGLE_AVATAR_UPLOAD':
      return { ...state, avatarUploadOpen: !state.avatarUploadOpen }
    case 'SET_TYPING':
      return { ...state, typingUserIds: action.userIds }
    case 'SET_INVITES':
      return { ...state, pendingInvites: action.rooms }
    case 'SET_IGNORED_USERS':
      return { ...state, ignoredUserIds: action.userIds }
    case 'SET_MY_BANNER':
      return { ...state, myBannerMxc: action.mxc }
    case 'LOGOUT':
      return { ...initialState }
    default:
      return state
  }
}

// ---- Context interface ----

interface MatrixContextValue {
  state: MatrixState
  client: MatrixClient | null
  login: (homeserver: string, userId: string, password: string) => Promise<void>
  loginWithSsoToken: (homeserver: string, token: string) => Promise<void>
  logout: () => Promise<void>
  setActiveSpace: (spaceId: string | null) => void
  reorderSpaces: (orderedIds: string[]) => Promise<void>
  setActiveRoom: (roomId: string) => Promise<void>
  loadMoreMessages: () => Promise<void>
  sendMessage: (text: string, replyTo?: MatrixEvent | null) => Promise<void>
  sendReaction: (eventId: string, key: string) => Promise<void>
  sendGif: (gifUrl: string, title: string) => Promise<void>
  updateAvatar: (file: File) => Promise<void>
  updateBanner: (file: File) => Promise<void>
  removeBanner: () => Promise<void>
  fetchUserBanner: (userId: string) => Promise<string | null>
  setStatus: (presence: SetPresence, statusMsg?: string) => Promise<void>
  setReplyTo: (event: MatrixEvent | null) => void
  requestVerification: (userId: string, deviceId: string) => Promise<void>
  dismissVerification: () => void
  toggleGifPicker: () => void
  toggleStatusModal: () => void
  toggleAvatarUpload: () => void
  createDM: (userId: string) => Promise<string>
  kickMember: (roomId: string, userId: string, reason?: string) => Promise<void>
  setPowerLevel: (roomId: string, userId: string, powerLevel: number) => Promise<void>
  banMember: (roomId: string, userId: string, reason?: string) => Promise<void>
  redactMessage: (roomId: string, eventId: string) => Promise<void>
  editMessage: (roomId: string, eventId: string, newBody: string) => Promise<void>
  forwardMessage: (event: MatrixEvent, targetRoomId: string) => Promise<void>
  inviteUser: (roomId: string, userId: string) => Promise<void>
  joinRoom: (roomId: string) => Promise<string>
  declineInvite: (roomId: string) => Promise<void>
  sendFile: (file: File) => Promise<void>
  sendTypingNotification: (isTyping: boolean) => Promise<void>
  sendReadReceipt: (event: MatrixEvent) => Promise<void>
  clearReadMarker: () => void
  pinMessage: (roomId: string, eventId: string) => Promise<void>
  unpinMessage: (roomId: string, eventId: string) => Promise<void>
  sendSticker: (url: string, body: string, info: { w?: number; h?: number; mimetype?: string }) => Promise<void>
  getStickerPacks: () => Promise<StickerPack[]>
  saveStickerPacks: (packs: StickerPack[]) => Promise<void>
  sendThreadMessage: (text: string, threadRootId: string) => Promise<void>
  createRoom: (name: string, topic?: string, isPrivate?: boolean, enableEncryption?: boolean) => Promise<string>
  setupKeyBackup: (passphrase?: string) => Promise<string>
  checkKeyBackupStatus: () => Promise<KeyBackupStatus>
  unlockCrossSigning: () => Promise<void>
  restoreFromBackup: (encodedKey: string) => Promise<{ total: number; imported: number }>
  ssKeyRequest: SsKeyRequest | null
  provideRecoveryKey: (encodedKey: string) => void
  cancelRecoveryKeyRequest: () => void
  ignoreUser: (userId: string) => Promise<void>
  unignoreUser: (userId: string) => Promise<void>
  knockRoom: (roomIdOrAlias: string, reason?: string) => Promise<void>
  upgradeRoom: (roomId: string, newVersion: string) => Promise<string>
  activeCall: ActiveCall | null
  placeVoiceCall: (roomId: string) => void
  placeVideoCall: (roomId: string) => void
  answerCall: (withVideo?: boolean) => void
  rejectCall: () => void
  hangupCall: () => void
  toggleCallMute: () => void
  toggleCallCamera: () => void
  sendVoiceMessage: (blob: Blob, durationMs: number, waveform: number[]) => Promise<void>
  sendPoll: (data: PollData) => Promise<void>
  sendPollResponse: (pollId: string, answerIds: string[]) => Promise<void>
  endPoll: (pollId: string) => Promise<void>
}

export const MatrixContext = createContext<MatrixContextValue | null>(null)

export function useMatrix() {
  const ctx = useContext(MatrixContext)
  if (!ctx) throw new Error('useMatrix must be used within MatrixProvider')
  return ctx
}

// ---- Helpers ----

function getDirectRoomIds(client: MatrixClient): Set<string> {
  const dmContent = (client.getAccountData('m.direct' as any)?.getContent() ?? {}) as Record<string, string[]>
  return new Set(Object.values(dmContent).flat())
}

function buildReactionsMap(
  events: MatrixEvent[],
  myUserId: string,
): { reactions: Record<string, ReactionGroup[]>; processedIds: Record<string, true> } {
  const reactions: Record<string, ReactionGroup[]> = {}
  const processedIds: Record<string, true> = {}
  for (const e of events) {
    if (e.getType() !== 'm.reaction') continue
    const rel = e.getContent()['m.relates_to']
    if (rel?.rel_type !== 'm.annotation' || !rel.event_id || !rel.key) continue
    const id = e.getId()
    if (id) processedIds[id] = true
    const evId: string = rel.event_id
    const key: string = rel.key
    if (!reactions[evId]) reactions[evId] = []
    const group = reactions[evId].find(g => g.key === key)
    const isMe = e.getSender() === myUserId
    if (group) {
      group.count++
      if (isMe) { group.myReacted = true; group.myReactionEventId = e.getId() ?? null }
    } else {
      reactions[evId].push({ key, count: 1, myReacted: isMe, myReactionEventId: isMe ? (e.getId() ?? null) : null })
    }
  }
  return { reactions, processedIds }
}

/**
 * Convert markdown formatting to Matrix-spec HTML (formatted_body).
 * Returns null if the text contains no formatting — avoids sending
 * unnecessary formatted_body for plain messages.
 */
const FORMAT_PATTERNS: [RegExp, string][] = [
  [/\|\|(.+?)\|\|/g, '<span data-mx-spoiler>$1</span>'],
  [/```(\w*)\n([\s\S]*?)```/g, '<pre><code>$2</code></pre>'],
  [/`([^`]+)`/g, '<code>$1</code>'],
  [/\*\*(.+?)\*\*/g, '<strong>$1</strong>'],
  [/\*(.+?)\*/g, '<em>$1</em>'],
  [/~~(.+?)~~/g, '<del>$1</del>'],
  [/<u>(.+?)<\/u>/g, '<u>$1</u>'],
]

function formatFields(text: string): { format?: string; formatted_body?: string } | null {
  let html = text
  let changed = false
  for (const [re, replacement] of FORMAT_PATTERNS) {
    re.lastIndex = 0
    if (re.test(html)) {
      changed = true
      re.lastIndex = 0
      html = html.replace(re, replacement)
    }
  }
  if (!changed) return null
  // Convert newlines to <br> for HTML
  html = html.replace(/\n/g, '<br>')
  return { format: 'org.matrix.custom.html', formatted_body: html }
}

// ---- Provider ----

export function MatrixProvider({ children }: { children: React.ReactNode }) {
  // Pre-load saved space/room from localStorage so the first render already has the
  // correct values. This prevents the persist-space effect (which runs in definition
  // order before the mount/restore effect) from deleting the saved space key before
  // the restore effect can read it.
  const [state, dispatch] = useReducer(reducer, undefined, () => {
    const token = localStorage.getItem('mx_access_token')
    if (!token) return { ...initialState }
    return {
      ...initialState,
      activeSpaceId: localStorage.getItem('mx_active_space'),
      activeRoomId: localStorage.getItem('mx_active_room'),
    }
  })
  const clientRef = useRef<MatrixClient | null>(null)
  // Keep refs to activeRoomId and activeSpaceId to use inside event listeners without stale closure
  const activeRoomIdRef = useRef<string | null>(null)
  const activeSpaceIdRef = useRef<string | null>(null)
  const hasRestoredSession = useRef(false)
  const hasCompletedInitialSyncRef = useRef(false)
  const paginatingRef = useRef(false)
  const hasMoreOlderRef = useRef(true)

  // Secret storage key callback coordination
  const [ssKeyRequest, setSsKeyRequest] = useState<SsKeyRequest | null>(null)
  const ssKeyResolverRef = useRef<((value: [string, Uint8Array] | null) => void) | null>(null)
  const ssKeyCacheRef = useRef<{ keyId: string; key: Uint8Array } | null>(null)

  // Voice/video call state
  const [activeCall, setActiveCall] = useState<ActiveCall | null>(null)
  const activeCallRef = useRef<MatrixCall | null>(null)
  const remoteAudioRef = useRef<HTMLAudioElement | null>(null)

  // Track verification requests the user has already dismissed so a reconnect
  // / re-sync doesn't re-surface them from the crypto SDK's in-progress list.
  const dismissedVerificationIdsRef = useRef<Set<string>>(new Set())

  useEffect(() => {
    activeRoomIdRef.current = state.activeRoomId
  }, [state.activeRoomId])

  useEffect(() => {
    activeSpaceIdRef.current = state.activeSpaceId
  }, [state.activeSpaceId])

  // Persist active room and space to localStorage
  useEffect(() => {
    if (state.activeRoomId) localStorage.setItem('mx_active_room', state.activeRoomId)
  }, [state.activeRoomId])

  useEffect(() => {
    if (state.activeSpaceId !== null) {
      localStorage.setItem('mx_active_space', state.activeSpaceId)
    } else {
      localStorage.removeItem('mx_active_space')
    }
  }, [state.activeSpaceId])

  // Remember the last visited room for each space (home is stored under '__home__')
  useEffect(() => {
    if (!state.activeRoomId) return
    const key = state.activeSpaceId ?? '__home__'
    try {
      const raw = localStorage.getItem('mx_last_room_per_space')
      const map = raw ? JSON.parse(raw) : {}
      if (map[key] === state.activeRoomId) return
      map[key] = state.activeRoomId
      localStorage.setItem('mx_last_room_per_space', JSON.stringify(map))
    } catch {
      // ignore quota/parse errors
    }
  }, [state.activeRoomId, state.activeSpaceId])

  // Auto-away: flip presence to "unavailable" after 20 min of no user input,
  // restore to the user's intended presence on the next activity. Only kicks
  // in for users who appear to be intentionally online — an explicit Invisible
  // (offline) or Idle (unavailable) choice is left alone.
  useEffect(() => {
    if (!state.userId) return

    const INACTIVITY_MS = 20 * 60 * 1000
    let timer: ReturnType<typeof setTimeout> | null = null
    let autoAway = false

    const goAway = () => {
      const client = clientRef.current
      if (!client || autoAway) return
      const intended = localStorage.getItem('vc_presence')
      if (intended === 'offline' || intended === 'unavailable') return
      autoAway = true
      client.setPresence({ presence: SetPresence.Unavailable }).catch(() => {/* presence may be disabled */})
    }

    const comeBack = () => {
      const client = clientRef.current
      if (!client || !autoAway) return
      autoAway = false
      const intended = (localStorage.getItem('vc_presence') as SetPresence) || SetPresence.Online
      client.setPresence({ presence: intended }).catch(() => {/* presence may be disabled */})
    }

    const onActivity = () => {
      if (autoAway) comeBack()
      if (timer !== null) clearTimeout(timer)
      timer = setTimeout(goAway, INACTIVITY_MS)
    }

    const onVisibility = () => {
      // Only treat "becoming visible" as activity — hidden tabs keep the timer
      // running so we actually go away while the user is elsewhere.
      if (!document.hidden) onActivity()
    }

    const events: Array<keyof WindowEventMap> = ['mousemove', 'mousedown', 'keydown', 'touchstart', 'scroll', 'wheel']
    for (const e of events) window.addEventListener(e, onActivity, { passive: true })
    document.addEventListener('visibilitychange', onVisibility)

    onActivity()

    return () => {
      for (const e of events) window.removeEventListener(e, onActivity)
      document.removeEventListener('visibilitychange', onVisibility)
      if (timer !== null) clearTimeout(timer)
    }
  }, [state.userId])

  const reorderSpaces = useCallback(async (orderedIds: string[]) => {
    // Optimistic local update + localStorage fallback for offline / no-sync cases.
    dispatch({ type: 'SET_SPACE_ORDER', order: orderedIds })
    try { localStorage.setItem('vc_space_order', JSON.stringify(orderedIds)) } catch { /* ignore quota */ }
    const client = clientRef.current
    if (!client) return
    try {
      await client.setAccountData('vc.space_order' as any, { order: orderedIds } as any)
    } catch (err) {
      console.warn('Failed to persist space order to account data', err)
    }
  }, [])

  const refreshRooms = useCallback(() => {
    const client = clientRef.current
    if (!client) return
    const allRooms = client.getRooms()
    const spaces = allRooms.filter(r => r.isSpaceRoom())
    dispatch({ type: 'SET_SPACES', spaces })

    const invitedRooms = allRooms.filter(r => r.getMyMembership() === 'invite')
    dispatch({ type: 'SET_INVITES', rooms: invitedRooms })

    const directIds = getDirectRoomIds(client)
    dispatch({ type: 'SET_DIRECT_ROOMS', rooms: allRooms.filter(r => !r.isSpaceRoom() && directIds.has(r.roomId) && r.getMyMembership() === 'join') })

    const activeSpaceId = activeSpaceIdRef.current
    if (!activeSpaceId) {
      // Home view: show all non-space, non-DM rooms regardless of space membership
      dispatch({ type: 'SET_ROOMS', rooms: allRooms.filter(r => !r.isSpaceRoom() && !directIds.has(r.roomId) && r.getMyMembership() === 'join') })
      return
    }

    const space = client.getRoom(activeSpaceId)
    if (!space) {
      dispatch({ type: 'SET_ROOMS', rooms: allRooms.filter(r => !r.isSpaceRoom() && !directIds.has(r.roomId) && r.getMyMembership() === 'join') })
      return
    }

    const childEvents = space.currentState.getStateEvents(EventType.SpaceChild as string)
    const childIds = new Set(
      (Array.isArray(childEvents) ? childEvents : [childEvents])
        .filter(Boolean)
        .map((e: MatrixEvent) => e.getStateKey())
        .filter((id): id is string => Boolean(id)),
    )
    dispatch({ type: 'SET_ROOMS', rooms: allRooms.filter(r => childIds.has(r.roomId) && !r.isSpaceRoom() && !directIds.has(r.roomId) && r.getMyMembership() === 'join') })
  }, [])

  // Restore session from localStorage on mount.
  // Space and room IDs are already in state (pre-loaded by the useReducer initializer).
  // All we need to do here is reconnect the Matrix client.
  // Messages for the restored room are loaded once the SDK has room data
  // (handled inside the ClientEvent.Sync handler).
  useEffect(() => {
    const token = localStorage.getItem('mx_access_token')
    const userId = localStorage.getItem('mx_user_id')
    const deviceId = localStorage.getItem('mx_device_id')
    const homeserver = localStorage.getItem('mx_homeserver')
    if (token && userId && homeserver) {
      initClient(homeserver, userId, token, deviceId || undefined).catch(console.error)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function initClient(
    homeserver: string,
    userId: string,
    accessToken: string,
    deviceId?: string,
  ) {
    const client = createClient({
      baseUrl: homeserver,
      userId,
      accessToken,
      deviceId,
      store: new MemoryStore(),
      verificationMethods: ['m.sas.v1', 'm.qr_code.show.v1', 'm.reciprocate.v1'],
      cryptoCallbacks: {
        getSecretStorageKey: async ({ keys }, _name) => {
          const keyId = Object.keys(keys)[0]
          if (!keyId) return null
          // Return cached key if available
          if (ssKeyCacheRef.current?.keyId === keyId) {
            return [keyId, ssKeyCacheRef.current.key] as [string, Uint8Array<ArrayBuffer>]
          }
          // Prompt user for recovery key
          return new Promise<[string, Uint8Array<ArrayBuffer>] | null>((resolve) => {
            ssKeyResolverRef.current = resolve as any
            setSsKeyRequest({ keyId })
          })
        },
        cacheSecretStorageKey: (keyId, _keyInfo, key) => {
          ssKeyCacheRef.current = { keyId, key }
        },
      },
    })

    clientRef.current = client
    dispatch({ type: 'LOGIN', userId })

    // ---- Event subscriptions ----

    client.on(ClientEvent.Sync, (syncState: SyncState) => {
      dispatch({ type: 'SYNC_STATE', state: syncState })
      if (syncState === SyncState.Prepared || syncState === SyncState.Syncing) {
        refreshRooms()
        // Load messages for the pre-restored room once the Matrix client has the room data.
        // We retry on every Prepared/Syncing until the room appears in the client store.
        if (!hasRestoredSession.current) {
          const roomId = activeRoomIdRef.current
          if (!roomId || client.getRoom(roomId)) {
            hasRestoredSession.current = true
            if (roomId) setActiveRoom(roomId).catch(console.error)
          }
        }
      }
      if (syncState === SyncState.Prepared) {
        fetchUserBanner(userId).then(mxc => dispatch({ type: 'SET_MY_BANNER', mxc })).catch(() => {})
        hasCompletedInitialSyncRef.current = true
      }
      // After the initial sync, pick up any verification request that arrived
      // during startup (the CryptoEvent may have fired before React was ready).
      if (syncState === SyncState.Prepared) {
        const crypto = client.getCrypto()
        const myUserId = client.getUserId()
        if (crypto && myUserId) {
          const pending = crypto
            .getVerificationRequestsToDeviceInProgress(myUserId)
            .filter(r =>
              r.phase !== VerificationPhase.Done &&
              r.phase !== VerificationPhase.Cancelled &&
              !dismissedVerificationIdsRef.current.has(r.transactionId),
            )
          if (pending.length > 0) {
            dispatch({ type: 'SET_VERIFICATION_REQUEST', request: pending[0] })
          }
        }
        // Auto-enable key backup if the backup key is already in the crypto store
        if (crypto) {
          crypto.checkKeyBackupAndEnable().catch(() => {})
        }
        // Load ignored users list
        dispatch({ type: 'SET_IGNORED_USERS', userIds: client.getIgnoredUsers() })
        // Load saved space order from account data (syncs across devices)
        try {
          const evt = client.getAccountData('vc.space_order' as any)
          const content = evt?.getContent() as { order?: unknown } | undefined
          if (content && Array.isArray(content.order) && content.order.every(x => typeof x === 'string')) {
            dispatch({ type: 'SET_SPACE_ORDER', order: content.order as string[] })
          }
        } catch { /* ignore */ }
      }
    })

    client.on(
      RoomEvent.Timeline,
      (event: MatrixEvent, room: Room | undefined, toStartOfTimeline: boolean | undefined) => {
        if (toStartOfTimeline) return
        if (!room) return
        if (event.status !== null) return // skip local echoes; only process server-confirmed events
        if (event.getType() === EventType.RoomMessage || event.getType() === EventType.Sticker || event.getType() === 'm.poll.start' || event.getType() === 'org.matrix.msc3381.poll.start') {
          if (event.getContent()['m.relates_to']?.rel_type !== 'm.replace') {
            dispatch({ type: 'APPEND_MESSAGE', message: event, roomId: room.roomId })
            // Only notify for genuinely live events — not initial-sync backlog
            // (otherwise a page reload replays sounds for every recent message)
            // and not sync gaps / paginated fills where old events re-enter the
            // timeline. Event age of 10s matches Element's threshold.
            const isLive =
              hasCompletedInitialSyncRef.current &&
              Date.now() - event.getTs() < 10_000
            if (isLive) {
              handleIncomingEvent(event, room, client, activeRoomIdRef.current, (roomId) => {
                if (activeRoomIdRef.current === roomId) return
                setActiveRoom(roomId).catch(console.error)
              })
            }
          }
        }
        // Re-render the poll that a response/end relates to
        if (event.getType() === 'm.poll.response' || event.getType() === 'm.poll.end' || event.getType() === 'org.matrix.msc3381.poll.response' || event.getType() === 'org.matrix.msc3381.poll.end') {
          if (activeRoomIdRef.current === room.roomId) {
            const activeRoom = client.getRoom(room.roomId)
            if (activeRoom) {
              const allEvents = activeRoom.getLiveTimeline().getEvents()
              const msgEvents = allEvents.filter(e => {
                const t = e.getType()
                if (t !== EventType.RoomMessage && t !== EventType.Sticker && t !== 'm.poll.start' && t !== 'org.matrix.msc3381.poll.start') return false
                return e.getContent()['m.relates_to']?.rel_type !== 'm.replace'
              })
              dispatch({ type: 'SET_MESSAGES', messages: msgEvents })
            }
          }
        }
        if (event.getType() === 'm.reaction') {
          const rel = event.getContent()['m.relates_to']
          if (rel?.rel_type === 'm.annotation' && rel.event_id && rel.key) {
            dispatch({
              type: 'APPEND_REACTION',
              reactionEventId: event.getId() ?? '',
              eventId: rel.event_id,
              key: rel.key,
              senderId: event.getSender() ?? '',
              myUserId: client.getUserId() ?? '',
            })
          }
        }
        if (event.getType() === EventType.RoomRedaction) {
          // Rebuild reactions map so redacted reactions are removed
          if (activeRoomIdRef.current === room.roomId) {
            const activeRoom = client.getRoom(room.roomId)
            if (activeRoom) {
              const allEvents = activeRoom.getLiveTimeline().getEvents()
              const { reactions, processedIds } = buildReactionsMap(allEvents, client.getUserId() ?? '')
              dispatch({ type: 'SET_REACTIONS', reactions, processedIds })
              const msgEvents = allEvents.filter(e => {
                const t = e.getType()
                if (t !== EventType.RoomMessage && t !== EventType.Sticker && t !== 'm.poll.start' && t !== 'org.matrix.msc3381.poll.start') return false
                return e.getContent()['m.relates_to']?.rel_type !== 'm.replace'
              })
              dispatch({ type: 'SET_MESSAGES', messages: msgEvents })
            }
          }
        }
        refreshRooms()
      },
    )

    client.on(RoomEvent.Name, () => refreshRooms())
    client.on(RoomEvent.MyMembership, () => refreshRooms())

    // Space order updated from another device → apply here too.
    client.on(ClientEvent.AccountData, (event: MatrixEvent) => {
      if (event.getType() !== 'vc.space_order') return
      const content = event.getContent() as { order?: unknown }
      if (Array.isArray(content.order) && content.order.every(x => typeof x === 'string')) {
        dispatch({ type: 'SET_SPACE_ORDER', order: content.order as string[] })
        try { localStorage.setItem('vc_space_order', JSON.stringify(content.order)) } catch { /* ignore */ }
      }
    })
    client.on(RoomMemberEvent.Membership, (_event: MatrixEvent, member: RoomMember) => {
      refreshRooms()
      // Refresh the member list if the event is for the currently active room
      if (member.roomId === activeRoomIdRef.current) {
        const room = client.getRoom(member.roomId)
        if (room) {
          dispatch({ type: 'SET_MEMBERS', members: room.getJoinedMembers() })
        }
      }
    })

    // Lazy-loaded members: on page reload, `loadMembersIfNeeded()` may
    // short-circuit before all member state events have been synced, leaving
    // `getJoinedMembers()` incomplete. When additional m.room.member events
    // land in the active room's state later, refresh the list.
    const refreshActiveRoomMembers = (roomId: string) => {
      if (roomId !== activeRoomIdRef.current) return
      const room = client.getRoom(roomId)
      if (!room) return
      dispatch({ type: 'SET_MEMBERS', members: room.getJoinedMembers() })
    }
    client.on(RoomStateEvent.NewMember, (_event: MatrixEvent, _state: any, member: RoomMember) => {
      refreshActiveRoomMembers(member.roomId)
    })
    client.on(RoomStateEvent.Members, (_event: MatrixEvent, _state: any, member: RoomMember) => {
      refreshActiveRoomMembers(member.roomId)
    })

    client.on(RoomMemberEvent.Typing, (_event: MatrixEvent, member: RoomMember) => {
      if (member.roomId !== activeRoomIdRef.current) return
      const room = client.getRoom(member.roomId)
      if (!room) return
      const myId = client.getUserId() ?? ''
      const typingIds = room.getJoinedMembers()
        .filter(m => (m as any).typing && m.userId !== myId)
        .map(m => m.userId)
      dispatch({ type: 'SET_TYPING', userIds: typingIds })
    })

    // Re-render when the current user's avatar changes (e.g. after uploading a new one)
    client.on('RoomMember.avatarUrl' as any, () => refreshRooms())

    client.on(CryptoEvent.VerificationRequestReceived as any, (request: VerificationRequest) => {
      if (dismissedVerificationIdsRef.current.has(request.transactionId)) return
      dispatch({ type: 'SET_VERIFICATION_REQUEST', request })
    })

    // ---- Incoming voice/video call ----
    client.on(CallEventHandlerEvent.Incoming, (call: MatrixCall) => {
      if (activeCallRef.current) {
        call.reject()
        return
      }
      setupCallListeners(call, client)
    })

    try {
      // Namespace the rust-crypto IndexedDB store by user+device. Without this,
      // every login shares one store, so re-logging-in (new device_id) hits
      // "the account in the store doesn't match the account in the constructor"
      // and crypto never initialises. Per-device prefix means fresh devices
      // get fresh stores and old ones can be cleaned up separately.
      const effectiveDeviceId = deviceId ?? client.getDeviceId() ?? 'unknown'
      const cryptoDatabasePrefix = `matrix-js-sdk:crypto:${userId}:${effectiveDeviceId}`
      await client.initRustCrypto({ cryptoDatabasePrefix })
    } catch (err) {
      // Loud error — if this fires, every device will fall through to the
      // HTTP-only device list and render as "Not verified" regardless of
      // actual cross-signing state.
      console.error('[crypto] initRustCrypto FAILED:', err)
    }

    try {
      await client.startClient({ initialSyncLimit: 30 })
    } catch (err) {
      console.error('Failed to start Matrix client:', err)
      throw err
    }
  }

  async function login(homeserver: string, userId: string, password: string) {
    // Normalize userId
    let fullUserId = userId.trim()
    if (!fullUserId.startsWith('@')) {
      const hs = homeserver.replace(/\/$/, '')
      const domain = new URL(hs).hostname
      fullUserId = `@${fullUserId}:${domain}`
    }

    // Create temporary client for login only
    const tempClient = createClient({ baseUrl: homeserver.replace(/\/$/, '') })
    let response: any
    try {
      response = await tempClient.loginRequest({
        type: 'm.login.password',
        user: fullUserId,
        password,
        initial_device_display_name: 'VirtualChat Web',
      })
    } finally {
      tempClient.stopClient()
    }

    localStorage.setItem('mx_access_token', response.access_token)
    localStorage.setItem('mx_user_id', response.user_id)
    localStorage.setItem('mx_device_id', response.device_id ?? '')
    localStorage.setItem('mx_homeserver', homeserver.replace(/\/$/, ''))

    await initClient(
      homeserver.replace(/\/$/, ''),
      response.user_id,
      response.access_token,
      response.device_id,
    )
  }

  async function loginWithSsoToken(homeserver: string, token: string) {
    const hs = homeserver.replace(/\/$/, '')
    const tempClient = createClient({ baseUrl: hs })
    let response: any
    try {
      response = await tempClient.loginRequest({
        type: 'm.login.token',
        token,
        initial_device_display_name: 'VirtualChat Web',
      })
    } finally {
      tempClient.stopClient()
    }
    localStorage.setItem('mx_access_token', response.access_token)
    localStorage.setItem('mx_user_id', response.user_id)
    localStorage.setItem('mx_device_id', response.device_id ?? '')
    localStorage.setItem('mx_homeserver', hs)
    await initClient(hs, response.user_id, response.access_token, response.device_id)
  }

  async function logout() {
    const client = clientRef.current
    if (client) {
      try {
        await client.logout(true)
      } catch {
        // Ignore logout errors (token already invalid, etc.)
      }
      client.stopClient()
    }
    localStorage.removeItem('mx_access_token')
    localStorage.removeItem('mx_user_id')
    localStorage.removeItem('mx_device_id')
    localStorage.removeItem('mx_homeserver')
    localStorage.removeItem('mx_active_space')
    localStorage.removeItem('mx_active_room')
    localStorage.removeItem('mx_last_room_per_space')
    clientRef.current = null
    dispatch({ type: 'LOGOUT' })
  }

  function setActiveSpace(spaceId: string | null) {
    dispatch({ type: 'SET_ACTIVE_SPACE', spaceId })
    const client = clientRef.current
    if (!client) return
    const allRooms = client.getRooms()
    const directIds = getDirectRoomIds(client)
    let spaceRooms: Room[]
    if (!spaceId) {
      // Home view: show all non-space, non-DM rooms
      spaceRooms = allRooms.filter(r => !r.isSpaceRoom() && !directIds.has(r.roomId))
    } else {
      const space = client.getRoom(spaceId)
      if (!space) return
      const childEvents = space.currentState.getStateEvents(EventType.SpaceChild as string)
      const childIds = new Set(
        (Array.isArray(childEvents) ? childEvents : [childEvents])
          .filter(Boolean)
          .map((e: MatrixEvent) => e.getStateKey())
          .filter((id): id is string => Boolean(id)),
      )
      spaceRooms = allRooms.filter(r => childIds.has(r.roomId) && !r.isSpaceRoom() && !directIds.has(r.roomId))
    }
    dispatch({ type: 'SET_ROOMS', rooms: spaceRooms })

    // Restore last visited room for this space, if it still belongs to the space
    try {
      const raw = localStorage.getItem('mx_last_room_per_space')
      if (!raw) return
      const map = JSON.parse(raw)
      const key = spaceId ?? '__home__'
      const lastRoomId = map?.[key]
      if (!lastRoomId || lastRoomId === activeRoomIdRef.current) return
      if (spaceRooms.some(r => r.roomId === lastRoomId)) {
        setActiveRoom(lastRoomId).catch(console.error)
      }
    } catch {
      // ignore parse errors
    }
  }

  async function loadMoreMessages(): Promise<void> {
    const client = clientRef.current
    const roomId = activeRoomIdRef.current
    if (!client || !roomId || paginatingRef.current || !hasMoreOlderRef.current) return
    const room = client.getRoom(roomId)
    if (!room) return
    paginatingRef.current = true
    try {
      const hasMore = await client.paginateEventTimeline(room.getLiveTimeline(), { backwards: true, limit: 30 })
      hasMoreOlderRef.current = hasMore
      const allEvents = room.getLiveTimeline().getEvents()
      const messages = allEvents.filter(e => {
        const t = e.getType()
        if (t !== EventType.RoomMessage && t !== EventType.Sticker && t !== 'm.poll.start' && t !== 'org.matrix.msc3381.poll.start') return false
        return e.getContent()['m.relates_to']?.rel_type !== 'm.replace'
      })
      dispatch({ type: 'SET_MESSAGES', messages })
      const { reactions, processedIds } = buildReactionsMap(allEvents, client.getUserId() ?? '')
      dispatch({ type: 'SET_REACTIONS', reactions, processedIds })
    } catch (err) {
      console.warn('Failed to load older messages:', err)
    } finally {
      paginatingRef.current = false
    }
  }

  async function setActiveRoom(roomId: string) {
    hasMoreOlderRef.current = true
    const client = clientRef.current

    // Capture the read marker BEFORE clearing state — this is the last event the
    // user has confirmed reading, used to render the "NEW MESSAGES" divider.
    let readMarkerEventId: string | null = null
    if (client) {
      const room = client.getRoom(roomId)
      const myUserId = client.getUserId() ?? ''
      if (room && myUserId) {
        readMarkerEventId = room.getEventReadUpTo(myUserId) ?? null
      }
    }

    dispatch({ type: 'SET_ACTIVE_ROOM', roomId })
    dispatch({ type: 'SET_READ_MARKER', eventId: readMarkerEventId })

    if (!client) return
    const room = client.getRoom(roomId)
    if (!room) return

    // Load existing timeline events; paginate backwards if none were included in initial sync
    let allEvents = room.getLiveTimeline().getEvents()
    if (!allEvents.some(e => e.getType() === EventType.RoomMessage)) {
      try {
        await client.paginateEventTimeline(room.getLiveTimeline(), { backwards: true, limit: 30 })
        allEvents = room.getLiveTimeline().getEvents()
      } catch {
        // best-effort; ignore pagination errors
      }
    }

    const messages = allEvents.filter(e => {
      const t = e.getType()
      if (t !== EventType.RoomMessage && t !== EventType.Sticker && t !== 'm.poll.start' && t !== 'org.matrix.msc3381.poll.start') return false
      return e.getContent()['m.relates_to']?.rel_type !== 'm.replace'
    })
    dispatch({ type: 'SET_MESSAGES', messages })

    // For E2EE rooms: when the SDK decrypts pending encrypted events, re-read the timeline.
    // Decryption is async and events may still be m.room.encrypted at the time of initial load.
    const encryptedEvents = allEvents.filter(e => e.getType() === 'm.room.encrypted')
    if (encryptedEvents.length > 0) {
      let refreshPending = false
      const scheduleRefresh = () => {
        if (activeRoomIdRef.current !== roomId || refreshPending) return
        refreshPending = true
        // Batch rapid decryptions into a single state update
        Promise.resolve().then(() => {
          refreshPending = false
          if (activeRoomIdRef.current !== roomId) return
          const updated = room.getLiveTimeline().getEvents()
            .filter(e => {
              const t = e.getType()
              if (t !== EventType.RoomMessage && t !== EventType.Sticker && t !== 'm.poll.start' && t !== 'org.matrix.msc3381.poll.start') return false
              return e.getContent()['m.relates_to']?.rel_type !== 'm.replace'
            })
          dispatch({ type: 'SET_MESSAGES', messages: updated })
        })
      }
      for (const event of encryptedEvents) {
        event.once('Event.decrypted' as any, scheduleRefresh)
      }
    }

    // Build reactions map from existing timeline
    const { reactions, processedIds } = buildReactionsMap(allEvents, client.getUserId() ?? '')
    dispatch({ type: 'SET_REACTIONS', reactions, processedIds })
    // Load members lazily. On page reload the SDK may mark lazy-loaded
    // members as "already loaded" based on a partial initial-sync state,
    // leaving getJoinedMembers() with only the current user. If that
    // happens, force a server-side fetch via /rooms/{roomId}/members.
    try {
      await room.loadMembersIfNeeded()
      let members = room.getJoinedMembers()
      const myId = client.getUserId() ?? ''
      const looksIncomplete = members.length <= 1 && members.every(m => m.userId === myId)
      if (looksIncomplete) {
        try {
          await (client as any).members?.(roomId)
          members = room.getJoinedMembers()
        } catch { /* fall through with whatever we have */ }
      }
      dispatch({ type: 'SET_MEMBERS', members })
    } catch (err) {
      console.warn('Could not load members:', err)
    }
  }

  async function sendMessage(text: string, replyTo?: MatrixEvent | null) {
    const client = clientRef.current
    const roomId = activeRoomIdRef.current
    if (!client || !roomId || !text.trim()) return
    const trimmed = text.trim()
    const content: any = {
      msgtype: MsgType.Text,
      body: trimmed,
      ...formatFields(trimmed),
    }
    if (replyTo) {
      const replyId = replyTo.getId() ?? ''
      const replySender = replyTo.getSender() ?? ''
      const rawReplyBody = (replyTo.getContent().body ?? '') as string
      // Strip any existing reply fallback so chained replies don't nest quoted text
      const cleanReplyBody = rawReplyBody.replace(/^(>[^\n]*\n)+\n/, '')
      // Matrix reply fallback body format
      content.body = `> <${replySender}> ${cleanReplyBody}\n\n${trimmed}`
      content['m.relates_to'] = { 'm.in_reply_to': { event_id: replyId } }
    }
    await client.sendEvent(roomId, EventType.RoomMessage, content)
    if (replyTo) dispatch({ type: 'SET_REPLY_TO', event: null })
  }

  function setReplyTo(event: MatrixEvent | null) {
    dispatch({ type: 'SET_REPLY_TO', event })
  }

  async function requestVerification(userId: string, deviceId: string) {
    const client = clientRef.current
    if (!client) return
    const crypto = client.getCrypto()
    if (!crypto) { console.warn('Crypto not initialized'); return }
    const request = await crypto.requestDeviceVerification(userId, deviceId)
    dispatch({ type: 'SET_VERIFICATION_REQUEST', request })
  }

  function dismissVerification() {
    const current = state.verificationRequest as VerificationRequest | null
    if (current) dismissedVerificationIdsRef.current.add(current.transactionId)
    dispatch({ type: 'SET_VERIFICATION_REQUEST', request: null })
  }

  async function sendReaction(eventId: string, key: string) {
    const client = clientRef.current
    const roomId = activeRoomIdRef.current
    if (!client || !roomId) return
    // If the user already reacted with this key, redact (toggle off)
    const groups = state.reactions[eventId] ?? []
    const existing = groups.find(g => g.key === key)
    if (existing?.myReacted && existing.myReactionEventId) {
      await client.redactEvent(roomId, existing.myReactionEventId)
      return
    }
    await client.sendEvent(roomId, 'm.reaction' as any, {
      'm.relates_to': { rel_type: 'm.annotation', event_id: eventId, key },
    })
  }

  async function sendGif(gifUrl: string, title: string) {
    const client = clientRef.current
    const roomId = activeRoomIdRef.current
    if (!client || !roomId) return
    try {
      const resp = await fetch(gifUrl)
      if (!resp.ok) throw new Error(`Failed to fetch GIF: ${resp.status}`)
      const blob = await resp.blob()
      const file = new File([blob], 'image.gif', { type: 'image/gif' })
      const uploadResp = await client.uploadContent(file, { type: 'image/gif' }) as any
      await client.sendEvent(roomId, EventType.RoomMessage, {
        msgtype: MsgType.Image,
        body: title || 'GIF',
        url: uploadResp.content_uri,
        info: { mimetype: 'image/gif' },
      })
    } catch (err) {
      console.error('GIF upload failed, sending fallback text:', err)
      await client.sendEvent(roomId, EventType.RoomMessage, {
        msgtype: MsgType.Text,
        body: gifUrl,
      })
    }
  }

  async function updateAvatar(file: File) {
    const client = clientRef.current
    if (!client) return
    const uploadResp = await client.uploadContent(file, { type: file.type }) as any
    await client.setAvatarUrl(uploadResp.content_uri)
  }

  // ---- Profile banner (MSC4133 extended profile / MSC4427) ----
  // Primary key "chat.commet.profile_banner" — what Commet and Sable write.
  // Also checks "m.banner_uri" (MSC4427 proposed stable) and legacy "com.commet.banner_url".
  // Homeservers without custom profile field support will reject writes.
  const BANNER_KEYS = ['chat.commet.profile_banner', 'm.banner_uri', 'com.commet.banner_url'] as const
  const BANNER_WRITE_KEY = 'chat.commet.profile_banner'

  async function putBannerMxc(mxc: string | null): Promise<void> {
    const client = clientRef.current
    if (!client) throw new Error('Not connected')
    const userId = client.getUserId()
    if (!userId) throw new Error('Not connected')
    const base = client.baseUrl.replace(/\/$/, '')
    const token = client.getAccessToken()
    const path = `/_matrix/client/v3/profile/${encodeURIComponent(userId)}/${BANNER_WRITE_KEY}`
    const res = await fetch(`${base}${path}`, {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ [BANNER_WRITE_KEY]: mxc ?? '' }),
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`Server rejected banner update (${res.status}): ${text || 'homeserver may not support custom profile fields'}`)
    }
  }

  async function updateBanner(file: File) {
    const client = clientRef.current
    if (!client) return
    const uploadResp = await client.uploadContent(file, { type: file.type }) as any
    const mxc: string = uploadResp.content_uri
    await putBannerMxc(mxc)
    dispatch({ type: 'SET_MY_BANNER', mxc })
  }

  async function removeBanner() {
    await putBannerMxc(null)
    dispatch({ type: 'SET_MY_BANNER', mxc: null })
  }

  async function fetchUserBanner(userId: string): Promise<string | null> {
    const client = clientRef.current
    if (!client) return null
    const base = client.baseUrl.replace(/\/$/, '')
    const token = client.getAccessToken()
    // Fetch the entire profile once and scan for any recognised banner key.
    // This avoids three sequential 404s on servers that support MSC4133 but
    // don't have the specific key set.
    try {
      const res = await fetch(`${base}/_matrix/client/v3/profile/${encodeURIComponent(userId)}`, {
        headers: { 'Authorization': `Bearer ${token}` },
      })
      if (!res.ok) return null
      const json = await res.json()
      for (const key of BANNER_KEYS) {
        let val = json?.[key]
        if (typeof val !== 'string') continue
        // Some homeservers wrap the value in literal quotes — Commet strips these.
        if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1)
        if (val.startsWith('mxc://')) return val
      }
      return null
    } catch {
      return null
    }
  }

  async function createDM(targetUserId: string): Promise<string> {
    const client = clientRef.current
    if (!client) throw new Error('Not connected')
    // Check if a DM with this user already exists
    const dmContent = (client.getAccountData('m.direct' as any)?.getContent() ?? {}) as Record<string, string[]>
    const existingRoomId = dmContent[targetUserId]?.[0]
    if (existingRoomId && client.getRoom(existingRoomId)) {
      return existingRoomId
    }
    const response = await client.createRoom({
      invite: [targetUserId],
      is_direct: true,
      preset: 'trusted_private_chat' as any,
    })
    const roomId = response.room_id
    // Register the new room as a DM in account data
    const updated: Record<string, string[]> = { ...dmContent, [targetUserId]: [...(dmContent[targetUserId] ?? []), roomId] }
    await client.setAccountData('m.direct' as any, updated as any)
    refreshRooms()
    return roomId
  }

  async function kickMember(roomId: string, userId: string, reason?: string) {
    const client = clientRef.current
    if (!client) return
    await client.kick(roomId, userId, reason)
  }

  async function setPowerLevel(roomId: string, userId: string, powerLevel: number) {
    const client = clientRef.current
    if (!client) return
    await client.setPowerLevel(roomId, userId, powerLevel)
  }

  async function banMember(roomId: string, userId: string, reason?: string) {
    const client = clientRef.current
    if (!client) return
    await client.ban(roomId, userId, reason)
  }

  async function redactMessage(roomId: string, eventId: string) {
    const client = clientRef.current
    if (!client) return
    await client.redactEvent(roomId, eventId)
  }

  async function editMessage(roomId: string, eventId: string, newBody: string) {
    const client = clientRef.current
    if (!client) return
    await client.sendMessage(roomId, {
      msgtype: 'm.text',
      body: `* ${newBody}`,
      'm.new_content': { msgtype: 'm.text', body: newBody, ...formatFields(newBody) },
      'm.relates_to': { rel_type: 'm.replace', event_id: eventId },
    } as any)
  }

  /**
   * Forward a message to another room by re-sending its content as a new event.
   *
   * We copy the original content but strip any `m.relates_to` (reply/edit/thread
   * relations would otherwise point at an event in a different room and render
   * incorrectly). The Matrix reply fallback prefix in the body is also stripped.
   *
   * Returns the new event type we sent so callers can log/verify.
   */
  async function forwardMessage(event: MatrixEvent, targetRoomId: string): Promise<void> {
    const client = clientRef.current
    if (!client) throw new Error('Not connected')
    if (event.isRedacted()) throw new Error('Cannot forward a redacted message')

    // Use the replacement content if the original was edited, so the forward
    // reflects the latest state the user sees.
    const replacement = event.replacingEvent() as MatrixEvent | null
    const effective = replacement?.getContent()?.['m.new_content'] ?? event.getContent()
    const content: any = { ...effective }

    // Strip relations — forwards shouldn't carry reply/edit/thread links from
    // the source room (the related events don't exist in the target room).
    delete content['m.relates_to']
    delete content['m.new_content']

    // Strip the Matrix reply fallback ("> <@user> text\n\n…") from the body so
    // forwarding a reply doesn't carry the quoted prefix into the target room.
    if (typeof content.body === 'string') {
      content.body = content.body.replace(/^(>[^\n]*\n)+\n/, '')
    }
    if (typeof content.formatted_body === 'string') {
      content.formatted_body = content.formatted_body.replace(/<mx-reply>[\s\S]*?<\/mx-reply>/, '')
    }

    // Send with the original event type so stickers stay stickers, polls stay polls, etc.
    const type = event.getType()
    await client.sendEvent(targetRoomId, type as any, content)
  }

  async function inviteUser(roomId: string, userId: string) {
    const client = clientRef.current
    if (!client) return
    await client.invite(roomId, userId)
  }

  async function createRoom(name: string, topic?: string, isPrivate = true, enableEncryption = false): Promise<string> {
    const client = clientRef.current
    if (!client) throw new Error('Not connected')
    const opts: any = {
      name,
      preset: isPrivate ? 'private_chat' : 'public_chat',
    }
    if (topic) opts.topic = topic
    if (enableEncryption) {
      opts.initial_state = [{ type: 'm.room.encryption', state_key: '', content: { algorithm: 'm.megolm.v1.aes-sha2' } }]
    }
    const resp = await client.createRoom(opts)
    refreshRooms()
    return resp.room_id
  }

  async function joinRoom(roomId: string): Promise<string> {
    const client = clientRef.current
    if (!client) throw new Error('Not connected')
    const room = await client.joinRoom(roomId)
    refreshRooms()
    return room.roomId
  }

  async function knockRoom(roomIdOrAlias: string, reason?: string): Promise<void> {
    const client = clientRef.current
    if (!client) throw new Error('Not connected')
    await client.knockRoom(roomIdOrAlias, { reason })
    refreshRooms()
  }

  async function upgradeRoom(roomId: string, newVersion: string): Promise<string> {
    const client = clientRef.current
    if (!client) throw new Error('Not connected')
    const resp = await client.upgradeRoom(roomId, newVersion)
    refreshRooms()
    return resp.replacement_room
  }

  async function declineInvite(roomId: string) {
    const client = clientRef.current
    if (!client) return
    await client.leave(roomId)
    refreshRooms()
  }

  async function sendFile(file: File) {
    const client = clientRef.current
    const roomId = activeRoomIdRef.current
    if (!client || !roomId) return
    const uploadResp = await client.uploadContent(file, { type: file.type }) as any
    const mxcUrl = uploadResp.content_uri

    let msgtype: 'm.image' | 'm.video' | 'm.audio' | 'm.file' = 'm.file'
    if (file.type.startsWith('image/')) msgtype = 'm.image'
    else if (file.type.startsWith('video/')) msgtype = 'm.video'
    else if (file.type.startsWith('audio/')) msgtype = 'm.audio'

    const info: any = { mimetype: file.type, size: file.size }

    // Probe width/height/duration for images and videos so remote clients can
    // render correct aspect ratios without fetching the media first.
    if (msgtype === 'm.image') {
      try {
        const dims = await probeImageDimensions(file)
        if (dims) { info.w = dims.w; info.h = dims.h }
      } catch { /* ignore */ }
    } else if (msgtype === 'm.video') {
      try {
        const meta = await probeVideoMetadata(file)
        if (meta) {
          if (meta.w) info.w = meta.w
          if (meta.h) info.h = meta.h
          if (meta.durationMs) info.duration = meta.durationMs
        }
      } catch { /* ignore */ }
    } else if (msgtype === 'm.audio') {
      try {
        const durationMs = await probeAudioDuration(file)
        if (durationMs) info.duration = durationMs
      } catch { /* ignore */ }
    }

    await client.sendMessage(roomId, { msgtype, url: mxcUrl, body: file.name, info } as any)
  }

  function probeImageDimensions(file: File): Promise<{ w: number; h: number } | null> {
    return new Promise(resolve => {
      const url = URL.createObjectURL(file)
      const img = new Image()
      img.onload = () => { URL.revokeObjectURL(url); resolve({ w: img.naturalWidth, h: img.naturalHeight }) }
      img.onerror = () => { URL.revokeObjectURL(url); resolve(null) }
      img.src = url
    })
  }

  function probeVideoMetadata(file: File): Promise<{ w: number; h: number; durationMs: number } | null> {
    return new Promise(resolve => {
      const url = URL.createObjectURL(file)
      const video = document.createElement('video')
      video.preload = 'metadata'
      video.onloadedmetadata = () => {
        const meta = {
          w: video.videoWidth,
          h: video.videoHeight,
          durationMs: Number.isFinite(video.duration) ? Math.round(video.duration * 1000) : 0,
        }
        URL.revokeObjectURL(url)
        resolve(meta)
      }
      video.onerror = () => { URL.revokeObjectURL(url); resolve(null) }
      video.src = url
    })
  }

  function probeAudioDuration(file: File): Promise<number | null> {
    return new Promise(resolve => {
      const url = URL.createObjectURL(file)
      const audio = document.createElement('audio')
      audio.preload = 'metadata'
      audio.onloadedmetadata = () => {
        URL.revokeObjectURL(url)
        resolve(Number.isFinite(audio.duration) ? Math.round(audio.duration * 1000) : null)
      }
      audio.onerror = () => { URL.revokeObjectURL(url); resolve(null) }
      audio.src = url
    })
  }

  async function sendTypingNotification(isTyping: boolean) {
    if (localStorage.getItem('vc_send_typing') === 'false') return
    const client = clientRef.current
    const roomId = activeRoomIdRef.current
    if (!client || !roomId) return
    try {
      await client.sendTyping(roomId, isTyping, isTyping ? 4000 : 0)
    } catch { /* ignore */ }
  }

  async function sendReadReceipt(event: MatrixEvent) {
    if (localStorage.getItem('vc_send_read_receipts') === 'false') return
    const client = clientRef.current
    if (!client) return
    try {
      await client.sendReadReceipt(event)
    } catch { /* ignore */ }
  }

  function clearReadMarker() {
    dispatch({ type: 'SET_READ_MARKER', eventId: null })
  }

  async function pinMessage(roomId: string, eventId: string) {
    const client = clientRef.current
    if (!client) return
    const room = client.getRoom(roomId)
    if (!room) return
    const current = (room.currentState.getStateEvents('m.room.pinned_events', '')?.getContent()?.pinned ?? []) as string[]
    if (current.includes(eventId)) return
    await client.sendStateEvent(roomId, 'm.room.pinned_events' as any, { pinned: [...current, eventId] }, '')
  }

  async function sendSticker(url: string, body: string, info: { w?: number; h?: number; mimetype?: string }) {
    const client = clientRef.current
    const roomId = activeRoomIdRef.current
    if (!client || !roomId) return
    await client.sendEvent(roomId, 'm.sticker' as any, { body, url, info })
  }

  async function getStickerPacks(): Promise<StickerPack[]> {
    const client = clientRef.current
    if (!client) return []
    const out: StickerPack[] = []
    const seenIds = new Set<string>()

    function pushPack(pack: StickerPack) {
      if (seenIds.has(pack.id) || pack.stickers.length === 0) return
      seenIds.add(pack.id)
      out.push(pack)
    }

    // Native VirtualChat packs
    try {
      const data = client.getAccountData('vc.sticker_packs' as any)?.getContent() as { packs?: StickerPack[] } | undefined
      for (const p of data?.packs ?? []) pushPack(p)
    } catch { /* ignore */ }

    // MSC2545 image packs from Element / Cinny / FluffyChat etc.
    // - User-level pack: account data `im.ponies.user_emotes`
    // - Shared room packs: state events `im.ponies.room_emotes` in rooms the
    //   user opted into via `im.ponies.emote_rooms` account data.
    try {
      const userPack = client.getAccountData('im.ponies.user_emotes' as any)?.getContent() as Msc2545Pack | undefined
      if (userPack) {
        const conv = msc2545ToStickerPack(userPack, 'im.ponies.user_emotes', 'My stickers')
        if (conv) pushPack(conv)
      }
    } catch { /* ignore */ }

    try {
      const emoteRooms = client.getAccountData('im.ponies.emote_rooms' as any)?.getContent() as
        | { rooms?: Record<string, Record<string, unknown>> }
        | undefined
      const roomEntries = Object.entries(emoteRooms?.rooms ?? {})
      for (const [roomId, packsByKey] of roomEntries) {
        const room = client.getRoom(roomId)
        if (!room) continue
        for (const stateKey of Object.keys(packsByKey ?? {})) {
          try {
            const evt = room.currentState.getStateEvents('im.ponies.room_emotes' as any, stateKey)
            const content = evt?.getContent() as Msc2545Pack | undefined
            if (!content) continue
            const fallbackName = room.name || roomId
            const id = `im.ponies.room_emotes:${roomId}:${stateKey}`
            const conv = msc2545ToStickerPack(content, id, fallbackName)
            if (conv) pushPack(conv)
          } catch { /* skip pack */ }
        }
      }
    } catch { /* ignore */ }

    return out
  }

  async function saveStickerPacks(packs: StickerPack[]): Promise<void> {
    const client = clientRef.current
    if (!client) throw new Error('Not connected')

    // Route each pack back to its origin so cross-client clients see updates:
    //   - vc.sticker_packs : VirtualChat-native packs
    //   - im.ponies.user_emotes : per-user MSC2545 pack (Element / Cinny / etc.)
    //   - im.ponies.room_emotes : per-room MSC2545 pack (state event)
    const native: StickerPack[] = []
    let userPack: StickerPack | null = null
    const roomPacks: StickerPack[] = []

    for (const p of packs) {
      if (p.id === 'im.ponies.user_emotes') userPack = p
      else if (p.id.startsWith('im.ponies.room_emotes:')) roomPacks.push(p)
      else native.push(p)
    }

    await client.setAccountData('vc.sticker_packs' as any, { packs: native } as any)

    if (userPack) {
      const existing = client.getAccountData('im.ponies.user_emotes' as any)?.getContent() as Msc2545Pack | undefined
      const merged = stickerPackToMsc2545(userPack, existing)
      await client.setAccountData('im.ponies.user_emotes' as any, merged as any)
    }

    // Room packs: writing requires permission to send the
    // im.ponies.room_emotes state event in that room. Best-effort; failures
    // (typically 403 for non-mods) are logged and the pack edit just won't
    // propagate to other clients.
    for (const p of roomPacks) {
      // id format: 'im.ponies.room_emotes:<roomId>:<stateKey>'
      // roomId itself contains a ':' (e.g. !abc:server.com), so match it.
      const m = p.id.match(/^im\.ponies\.room_emotes:(![^:]+:[^:]+):(.*)$/)
      if (!m) { console.warn('Unparseable room pack id:', p.id); continue }
      const roomId = m[1]
      const stateKey = m[2]
      try {
        const existing = client.getRoom(roomId)?.currentState
          .getStateEvents('im.ponies.room_emotes' as any, stateKey)
          ?.getContent() as Msc2545Pack | undefined
        const merged = stickerPackToMsc2545(p, existing)
        await client.sendStateEvent(roomId, 'im.ponies.room_emotes' as any, merged as any, stateKey)
      } catch (err) {
        console.warn(`Could not update shared sticker pack in ${roomId}:`, err)
      }
    }
  }

  /**
   * Convert our flat StickerPack model into MSC2545 image-pack format,
   * preserving any pre-existing per-image metadata (so we don't blow away
   * shortcodes a sister client wrote).
   */
  function stickerPackToMsc2545(pack: StickerPack, existing?: Msc2545Pack): Msc2545Pack {
    const images: Record<string, Msc2545Image> = {}
    for (const s of pack.stickers) {
      // Recover the original MSC2545 shortcode for stickers we read from
      // account data (we encoded `<id>:<shortcode>` in StickerItem.id).
      const fromMsc = s.id.match(/^im\.ponies\.[^:]+(?::!?[^:]+:[^:]+)?(?::[^:]+)?:(.+)$/)
      const shortcode = fromMsc?.[1] ?? s.id
      const prev = existing?.images?.[shortcode]
      images[shortcode] = {
        url: s.url,
        body: s.body || prev?.body,
        info: (s.w || s.h || s.mimetype)
          ? { w: s.w, h: s.h, mimetype: s.mimetype }
          : prev?.info,
        usage: prev?.usage ?? ['sticker'],
      }
    }
    return {
      pack: {
        display_name: pack.name,
        usage: existing?.pack?.usage ?? ['sticker'],
      },
      images,
    }
  }

  async function sendThreadMessage(text: string, threadRootId: string) {
    const client = clientRef.current
    const roomId = activeRoomIdRef.current
    if (!client || !roomId || !text.trim()) return
    const trimmed = text.trim()
    await client.sendEvent(roomId, EventType.RoomMessage, {
      msgtype: MsgType.Text,
      body: trimmed,
      ...formatFields(trimmed),
      'm.relates_to': {
        rel_type: 'm.thread',
        event_id: threadRootId,
        is_falling_back: true,
        'm.in_reply_to': { event_id: threadRootId },
      },
    } as any)
  }

  async function unpinMessage(roomId: string, eventId: string) {
    const client = clientRef.current
    if (!client) return
    const room = client.getRoom(roomId)
    if (!room) return
    const current = (room.currentState.getStateEvents('m.room.pinned_events', '')?.getContent()?.pinned ?? []) as string[]
    await client.sendStateEvent(roomId, 'm.room.pinned_events' as any, { pinned: current.filter(id => id !== eventId) }, '')
  }

  async function setStatus(presence: SetPresence, statusMsg?: string) {
    const client = clientRef.current
    if (!client) return
    localStorage.setItem('vc_presence', presence)
    localStorage.setItem('vc_status_msg', statusMsg ?? '')
    try {
      await client.setPresence({ presence: presence as any, status_msg: statusMsg })
    } catch (err) {
      console.warn('setPresence failed (server may have presence disabled):', err)
    }
  }

  // ---- Key Backup & Recovery ----

  async function setupKeyBackup(passphrase?: string): Promise<string> {
    const client = clientRef.current
    if (!client) throw new Error('Not connected')
    const crypto = client.getCrypto()
    if (!crypto) throw new Error('Crypto not initialized')

    // Generate recovery key
    const recoveryKey = await crypto.createRecoveryKeyFromPassphrase(passphrase || undefined)

    // Cache it so the SSSS callback doesn't prompt the user during bootstrap
    if (recoveryKey.encodedPrivateKey) {
      ssKeyCacheRef.current = { keyId: '__pending__', key: recoveryKey.privateKey }
    }

    // Bootstrap cross-signing (try empty auth — works for fresh sessions)
    try {
      await crypto.bootstrapCrossSigning({
        authUploadDeviceSigningKeys: async (makeRequest) => { await makeRequest(null) },
      })
    } catch (e) {
      console.warn('Cross-signing bootstrap skipped (may already be set up):', e)
    }

    // Bootstrap secret storage + key backup
    await crypto.bootstrapSecretStorage({
      createSecretStorageKey: async () => recoveryKey,
      setupNewSecretStorage: true,
      setupNewKeyBackup: true,
    })

    // Enable key backup
    await crypto.checkKeyBackupAndEnable().catch(() => {})

    return recoveryKey.encodedPrivateKey ?? ''
  }

  async function checkKeyBackupStatus(): Promise<KeyBackupStatus> {
    const client = clientRef.current
    const empty: KeyBackupStatus = { crossSigningReady: false, secretStorageReady: false, backupEnabled: false, backupVersion: null }
    if (!client) return empty
    const crypto = client.getCrypto()
    if (!crypto) return empty

    const [crossSigningReady, secretStorageReady, backupInfo, activeVersion] = await Promise.all([
      crypto.isCrossSigningReady().catch(() => false),
      crypto.isSecretStorageReady().catch(() => false),
      crypto.getKeyBackupInfo().catch(() => null),
      crypto.getActiveSessionBackupVersion().catch(() => null),
    ])

    return {
      crossSigningReady: crossSigningReady as boolean,
      secretStorageReady: secretStorageReady as boolean,
      backupEnabled: activeVersion !== null,
      backupVersion: (backupInfo as any)?.version ?? null,
    }
  }

  // Import cross-signing private keys from 4S into this session's olm machine
  // and cross-sign this device. After this, getUserVerificationStatus() will
  // report the identity as verified, which is what flips every other device's
  // isVerified() from false to true when trustCrossSignedDevices is on.
  //
  // Triggers the getSecretStorageKey callback if 4S isn't unlocked — which
  // surfaces the existing recovery-key modal.
  async function unlockCrossSigning(): Promise<void> {
    const client = clientRef.current
    if (!client) throw new Error('Not connected')
    const crypto = client.getCrypto()
    if (!crypto) throw new Error('Crypto not initialized')

    // Bootstrap cross-signing — triggers the getSecretStorageKey callback so the
    // user enters their recovery key once via the recovery-key modal. The key
    // then lands in ssKeyCacheRef and is reused by the next calls below.
    await crypto.bootstrapCrossSigning({})

    // Also pull the backup decryption key into the local store and restore
    // backed-up room keys so historical encrypted messages (and encrypted
    // images/files) decrypt going forward. Failures here are non-fatal — the
    // cross-signing unlock may still be useful on its own.
    await crypto.loadSessionBackupPrivateKeyFromSecretStorage().catch(err => {
      console.warn('Failed to load session backup key from 4S:', err)
    })
    await crypto.checkKeyBackupAndEnable().catch(err => {
      console.warn('Failed to enable key backup:', err)
    })
    await crypto.restoreKeyBackup().catch(err => {
      console.warn('Failed to restore key backup:', err)
    })
  }

  // Restore E2EE message history using a recovery key entered in settings.
  // Unlike provideRecoveryKey (which only resolves a pending getSecretStorageKey
  // prompt), this function actively kicks off the restore flow.
  async function restoreFromBackup(encodedKey: string): Promise<{ total: number; imported: number }> {
    const client = clientRef.current
    if (!client) throw new Error('Not connected')
    const crypto = client.getCrypto()
    if (!crypto) throw new Error('Crypto not initialized')

    const decoded = decodeRecoveryKey(encodedKey.trim())

    // Cache the decoded key against the default secret-storage key ID so the
    // getSecretStorageKey callback returns it without prompting.
    const defaultKeyId = await client.secretStorage.getDefaultKeyId()
    if (!defaultKeyId) throw new Error('No secret storage is configured on this account')
    ssKeyCacheRef.current = { keyId: defaultKeyId, key: decoded }

    // Pull the backup decryption key out of 4S into the local crypto store,
    // then import cross-signing keys and download + decrypt backed-up room keys.
    await crypto.loadSessionBackupPrivateKeyFromSecretStorage()
    await crypto.bootstrapCrossSigning({}).catch(() => {})
    await crypto.checkKeyBackupAndEnable().catch(() => {})
    const result = await crypto.restoreKeyBackup()
    return { total: result.total, imported: result.imported }
  }

  function provideRecoveryKey(encodedKey: string) {
    const resolver = ssKeyResolverRef.current
    const request = ssKeyRequest
    if (!resolver || !request) return
    const decoded = decodeRecoveryKey(encodedKey)
    ssKeyCacheRef.current = { keyId: request.keyId, key: decoded }
    resolver([request.keyId, decoded])
    ssKeyResolverRef.current = null
    setSsKeyRequest(null)
  }

  function cancelRecoveryKeyRequest() {
    if (ssKeyResolverRef.current) {
      ssKeyResolverRef.current(null)
      ssKeyResolverRef.current = null
    }
    setSsKeyRequest(null)
  }

  // ---- Ignore / Block users ----

  async function ignoreUser(userId: string) {
    const client = clientRef.current
    if (!client) return
    const current = client.getIgnoredUsers()
    if (current.includes(userId)) return
    await client.setIgnoredUsers([...current, userId])
    dispatch({ type: 'SET_IGNORED_USERS', userIds: [...current, userId] })
  }

  async function unignoreUser(userId: string) {
    const client = clientRef.current
    if (!client) return
    const updated = client.getIgnoredUsers().filter(id => id !== userId)
    await client.setIgnoredUsers(updated)
    dispatch({ type: 'SET_IGNORED_USERS', userIds: updated })
  }

  // ---- Voice/video calls ----

  function detectVideoCall(call: MatrixCall): boolean {
    // For inbound: check the invite offer's SDP. For outbound: check local feeds.
    if ((call as any).type === 'video') return true
    if (call.hasLocalUserMediaVideoTrack) return true
    if (call.hasRemoteUserMediaVideoTrack) return true
    return false
  }

  function setupCallListeners(call: MatrixCall, client: MatrixClient, isVideo = false) {
    activeCallRef.current = call
    const room = client.getRoom(call.roomId)
    const peerId = call.getOpponentMember()?.userId ?? ''
    const peerName = room?.getMember(peerId)?.name ?? (peerId || room?.name || 'Unknown')
    const isInbound = call.direction === CallDirection.Inbound

    setActiveCall({
      call,
      roomId: call.roomId,
      state: call.state,
      direction: isInbound ? 'inbound' : 'outbound',
      peerName,
      micMuted: call.isMicrophoneMuted(),
      video: isVideo || detectVideoCall(call),
      cameraMuted: false,
      localStream: null,
      remoteStream: null,
    })

    // Start the ringtone on inbound calls while the call is ringing.
    if (isInbound) startCallRingtone()

    call.on(CallEvent.State, (newState: CallState) => {
      setActiveCall(prev => prev ? { ...prev, state: newState } : null)
      // Once the call leaves the ringing state (answered/connecting/ended), stop the ring.
      if (newState !== CallState.Ringing && newState !== CallState.InviteSent) {
        stopCallRingtone()
      }
      if (newState === CallState.Ended) {
        cleanupCall()
      }
    })

    call.on(CallEvent.FeedsChanged, () => {
      const remoteFeeds = call.getRemoteFeeds()
      const localFeeds = call.getLocalFeeds()
      const remoteStream = remoteFeeds[0]?.stream ?? null
      const localStream = localFeeds[0]?.stream ?? null
      const hasVideo = detectVideoCall(call)

      // Audio playback — always attach remote audio to a hidden <audio> element
      // so voice-only calls keep working even when no <video> element renders.
      if (remoteStream) {
        if (!remoteAudioRef.current) {
          remoteAudioRef.current = new Audio()
          remoteAudioRef.current.autoplay = true
        }
        remoteAudioRef.current.srcObject = remoteStream
      }

      setActiveCall(prev => prev ? { ...prev, remoteStream, localStream, video: prev.video || hasVideo } : null)
    })

    call.on(CallEvent.Hangup, () => cleanupCall())
    call.on(CallEvent.Error, () => cleanupCall())
  }

  function cleanupCall() {
    stopCallRingtone()
    if (remoteAudioRef.current) {
      remoteAudioRef.current.srcObject = null
    }
    activeCallRef.current = null
    setActiveCall(null)
  }

  function placeVoiceCall(roomId: string) {
    const client = clientRef.current
    if (!client || activeCallRef.current) return
    const call = client.createCall(roomId)
    if (!call) return
    setupCallListeners(call, client, false)
    call.placeVoiceCall().catch(() => cleanupCall())
  }

  function placeVideoCall(roomId: string) {
    const client = clientRef.current
    if (!client || activeCallRef.current) return
    const call = client.createCall(roomId)
    if (!call) return
    setupCallListeners(call, client, true)
    call.placeVideoCall().catch(() => cleanupCall())
  }

  function answerCall(withVideo?: boolean) {
    const call = activeCallRef.current
    if (!call) return
    if (withVideo !== undefined) {
      call.answer(true, withVideo)
    } else {
      call.answer()
    }
  }

  function rejectCall() {
    activeCallRef.current?.reject()
    cleanupCall()
  }

  function hangupCall() {
    activeCallRef.current?.hangup(CallErrorCode.UserHangup, false)
    cleanupCall()
  }

  function toggleCallMute() {
    const call = activeCallRef.current
    if (!call) return
    const muted = !call.isMicrophoneMuted()
    call.setMicrophoneMuted(muted)
    setActiveCall(prev => prev ? { ...prev, micMuted: muted } : null)
  }

  function toggleCallCamera() {
    const call = activeCallRef.current
    if (!call) return
    const muted = !call.isLocalVideoMuted()
    call.setLocalVideoMuted(muted).catch(() => {})
    setActiveCall(prev => prev ? { ...prev, cameraMuted: muted } : null)
  }

  // ---- Voice messages (MSC3245 / MSC1767) ----

  async function sendVoiceMessage(blob: Blob, durationMs: number, waveform: number[]) {
    const client = clientRef.current
    const roomId = activeRoomIdRef.current
    if (!client || !roomId) return
    const file = new File([blob], `Voice message.${blob.type.includes('ogg') ? 'ogg' : 'webm'}`, { type: blob.type })
    const uploadResp = await client.uploadContent(file, { type: file.type }) as any
    await client.sendEvent(roomId, EventType.RoomMessage, {
      msgtype: MsgType.Audio,
      body: file.name,
      url: uploadResp.content_uri,
      info: { mimetype: file.type, size: file.size, duration: durationMs },
      'org.matrix.msc1767.text': file.name,
      'org.matrix.msc1767.file': { url: uploadResp.content_uri, name: file.name, mimetype: file.type, size: file.size },
      'org.matrix.msc1767.audio': { duration: durationMs, waveform },
      'org.matrix.msc3245.voice': {},
    } as any)
  }

  // ---- Polls (MSC3381) ----
  //
  // Send events using the *unstable* type + keys (`org.matrix.msc3381.poll.*`) because
  // that's what FluffyChat, Cinny, and Element Web actually recognize in practice. We
  // also include the stable `m.poll.start` / `m.text` fields so clients that moved to
  // the stable namespace still render the poll correctly.
  async function sendPoll(data: PollData) {
    const client = clientRef.current
    const roomId = activeRoomIdRef.current
    if (!client || !roomId) return
    const fallbackBody = `${data.question}\n${data.answers.map((a, i) => `${i + 1}. ${a.text}`).join('\n')}`
    // Kind uses unstable prefix (FluffyChat/Cinny expect it). Map stable -> unstable.
    const unstableKind = data.kind === 'm.poll.disclosed'
      ? 'org.matrix.msc3381.poll.disclosed'
      : 'org.matrix.msc3381.poll.undisclosed'
    const pollPayload = {
      question: { 'org.matrix.msc1767.text': data.question, body: data.question },
      kind: unstableKind,
      max_selections: data.maxSelections,
      answers: data.answers.map(a => ({
        id: a.id,
        'org.matrix.msc1767.text': a.text,
        'm.text': [{ body: a.text }],
      })),
    }
    await client.sendEvent(roomId, 'org.matrix.msc3381.poll.start' as any, {
      'org.matrix.msc3381.poll.start': pollPayload,
      // Stable mirror for forward-compat clients
      'm.poll.start': {
        ...pollPayload,
        kind: data.kind,
        question: { 'm.text': [{ body: data.question }], body: data.question },
      },
      'org.matrix.msc1767.text': fallbackBody,
      'm.text': [{ body: fallbackBody }],
      body: fallbackBody,
    } as any)
  }

  async function sendPollResponse(pollId: string, answerIds: string[]) {
    const client = clientRef.current
    const roomId = activeRoomIdRef.current
    if (!client || !roomId) return
    await client.sendEvent(roomId, 'org.matrix.msc3381.poll.response' as any, {
      'm.relates_to': { rel_type: 'm.reference', event_id: pollId },
      'org.matrix.msc3381.poll.response': { answers: answerIds },
      'm.poll.response': { answers: answerIds },
    } as any)
  }

  async function endPoll(pollId: string) {
    const client = clientRef.current
    const roomId = activeRoomIdRef.current
    if (!client || !roomId) return
    await client.sendEvent(roomId, 'org.matrix.msc3381.poll.end' as any, {
      'm.relates_to': { rel_type: 'm.reference', event_id: pollId },
      'org.matrix.msc3381.poll.end': {},
      'm.poll.end': {},
      'org.matrix.msc1767.text': 'The poll has ended.',
      'm.text': [{ body: 'The poll has ended.' }],
      body: 'The poll has ended.',
    } as any)
  }

  const value: MatrixContextValue = {
    state,
    client: clientRef.current,
    login,
    loginWithSsoToken,
    logout,
    setActiveSpace,
    reorderSpaces,
    setActiveRoom,
    loadMoreMessages,
    sendMessage,
    sendReaction,
    sendGif,
    updateAvatar,
    updateBanner,
    removeBanner,
    fetchUserBanner,
    setStatus,
    setReplyTo,
    requestVerification,
    dismissVerification,
    toggleGifPicker: () => dispatch({ type: 'TOGGLE_GIF_PICKER' }),
    toggleStatusModal: () => dispatch({ type: 'TOGGLE_STATUS_MODAL' }),
    toggleAvatarUpload: () => dispatch({ type: 'TOGGLE_AVATAR_UPLOAD' }),
    createDM,
    kickMember,
    setPowerLevel,
    banMember,
    redactMessage,
    editMessage,
    forwardMessage,
    inviteUser,
    createRoom,
    joinRoom,
    knockRoom,
    upgradeRoom,
    declineInvite,
    sendFile,
    sendTypingNotification,
    sendReadReceipt,
    clearReadMarker,
    pinMessage,
    unpinMessage,
    sendSticker,
    getStickerPacks,
    saveStickerPacks,
    sendThreadMessage,
    setupKeyBackup,
    checkKeyBackupStatus,
    unlockCrossSigning,
    restoreFromBackup,
    ssKeyRequest,
    provideRecoveryKey,
    cancelRecoveryKeyRequest,
    ignoreUser,
    unignoreUser,
    activeCall,
    placeVoiceCall,
    placeVideoCall,
    answerCall,
    rejectCall,
    hangupCall,
    toggleCallMute,
    toggleCallCamera,
    sendVoiceMessage,
    sendPoll,
    sendPollResponse,
    endPoll,
  }

  return <MatrixContext.Provider value={value}>{children}</MatrixContext.Provider>
}
