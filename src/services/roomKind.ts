import { Room } from 'matrix-js-sdk'

// Room-type identifiers that mark a room as a voice/video channel.
//
// Matrix has no spec-stable voice/video room type yet; Cinny, Element, and
// friends use MSC3417 ("Matrix Video Rooms") with the `io.element.video`
// creation type. We also accept the `m.video` stable-ish alias and the MSC3401
// call room type that Element Call uses.
const VOICE_CHANNEL_TYPES = new Set<string>([
  'io.element.video',
  'org.matrix.msc3417.v1.video',
  'm.video',
  'org.matrix.msc3401.call',
])

function hasVoiceWidget(room: Room): boolean {
  // Rooms without an MSC3417 type but built around a Jitsi or Element Call
  // widget also behave like voice/video channels. Check both the modern and
  // the legacy widget state-event types.
  const state = room.currentState
  if (!state) return false
  const widgetEvents = [
    ...((state.getStateEvents('im.vector.modular.widgets') as any) ?? []),
    ...((state.getStateEvents('m.widget') as any) ?? []),
  ]
  for (const ev of widgetEvents) {
    const content = ev?.getContent?.() ?? {}
    const url: string = content.url ?? ''
    const type: string = content.type ?? ''
    if (type === 'jitsi' || type === 'm.jitsi' || type === 'm.call' || type === 'io.element.call') return true
    if (url.includes('jitsi') || url.includes('element-call')) return true
  }
  return false
}

function hasActiveRtcMembers(room: Room): boolean {
  const state = room.currentState
  if (!state) return false
  // MSC3401 / MatrixRTC sessions use `org.matrix.msc3401.call.member` (or the
  // stabilised `m.call.member`) state events, one per participating device.
  const events = [
    ...((state.getStateEvents('m.call.member') as any) ?? []),
    ...((state.getStateEvents('org.matrix.msc3401.call.member') as any) ?? []),
  ]
  // Empty content = the member left; require at least one event with non-empty content.
  return events.some(ev => {
    const c = ev?.getContent?.()
    if (!c) return false
    return Object.keys(c).length > 0
  })
}

/** Temporary debug helper — logs how we classified a room so mis-detections are easy to spot. */
function debugLog(room: Room, reason: string) {
  if (typeof window === 'undefined') return
  if ((window as any).__VC_ROOM_KIND_LOGGED?.[room.roomId]) return
  ;(window as any).__VC_ROOM_KIND_LOGGED = (window as any).__VC_ROOM_KIND_LOGGED ?? {}
  ;(window as any).__VC_ROOM_KIND_LOGGED[room.roomId] = true
  // eslint-disable-next-line no-console
  console.info('[roomKind]', room.name, 'type=', room.getType(), '→', reason)
}

function dumpRoomState(room: Room) {
  if (typeof window === 'undefined') return
  if ((window as any).__VC_ROOM_DUMP?.[room.roomId]) return
  ;(window as any).__VC_ROOM_DUMP = (window as any).__VC_ROOM_DUMP ?? {}
  ;(window as any).__VC_ROOM_DUMP[room.roomId] = true

  const state = room.currentState
  // Enumerate every state event type in the room.
  const events: any[] = (state as any)?.getStateEvents?.() ?? []
  const byType: Record<string, any[]> = {}
  for (const ev of events) {
    const t = ev.getType?.() ?? '<unknown>'
    byType[t] = byType[t] ?? []
    byType[t].push({ stateKey: ev.getStateKey?.(), content: ev.getContent?.() })
  }
  // eslint-disable-next-line no-console
  console.groupCollapsed('[roomKind][debug]', room.name || room.roomId, '— not classified as voice')
  // eslint-disable-next-line no-console
  console.log('room.getType() =', room.getType())
  // eslint-disable-next-line no-console
  console.log('room.roomId =', room.roomId)
  // eslint-disable-next-line no-console
  console.log('state event types:', Object.keys(byType))
  for (const [type, list] of Object.entries(byType)) {
    // eslint-disable-next-line no-console
    console.log(` • ${type} (${list.length})`, list)
  }
  // eslint-disable-next-line no-console
  console.groupEnd()
}

export function isVoiceChannel(room: Room | null | undefined): boolean {
  if (!room) return false
  const t = room.getType()
  if (typeof t === 'string' && VOICE_CHANNEL_TYPES.has(t)) {
    debugLog(room, 'matched room.getType()')
    return true
  }
  if (hasVoiceWidget(room)) {
    debugLog(room, 'has voice widget')
    return true
  }
  if (hasActiveRtcMembers(room)) {
    debugLog(room, 'has active RTC members')
    return true
  }
  // Dump the room once so we can see what Cinny put on it that we missed.
  dumpRoomState(room)
  return false
}
