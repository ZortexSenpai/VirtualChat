/**
 * Push notification service for VirtualChat.
 * Handles desktop notifications (Browser Notification API) and notification sounds (Web Audio API).
 */

import type { MatrixClient, MatrixEvent, Room } from 'matrix-js-sdk'

const DESKTOP_NOTIFICATIONS_KEY = 'vc_desktop_notifications'
const NOTIFICATION_SOUND_KEY = 'vc_notification_sound'
const NOTIFICATION_SOUND_CHOICE_KEY = 'vc_notification_sound_choice'
const NOTIFICATION_VOLUME_KEY = 'vc_notification_volume'
const CALL_RING_ENABLED_KEY = 'vc_call_ring'
const DND_MANUAL_KEY = 'vc_dnd_manual'
const DND_SCHEDULE_ENABLED_KEY = 'vc_dnd_schedule_enabled'
const DND_SCHEDULE_START_KEY = 'vc_dnd_schedule_start'
const DND_SCHEDULE_END_KEY = 'vc_dnd_schedule_end'
const DND_ALLOW_MENTIONS_KEY = 'vc_dnd_allow_mentions'

// ---- Sound presets ----
//
// Each preset is a function that, given an AudioContext + destination and the
// current time, schedules audio events and returns the total duration so the
// caller can optionally loop. All presets are short (≤ 600ms) and synthesised
// in-browser so there's no asset shipping and zero round-trip cost.
export type SoundId = 'chime' | 'ping' | 'pop' | 'blip' | 'silent'

export const SOUND_PRESETS: { id: SoundId; label: string; desc: string }[] = [
  { id: 'chime', label: 'Chime',  desc: 'Default — two-tone bell.' },
  { id: 'ping',  label: 'Ping',   desc: 'Short bright high tone.' },
  { id: 'pop',   label: 'Pop',    desc: 'Quick muted bubble.' },
  { id: 'blip',  label: 'Blip',   desc: 'Soft mid-tone beep.' },
  { id: 'silent', label: 'Silent', desc: 'No sound.' },
]

// ---- Settings ----

export function isDesktopNotificationsEnabled(): boolean {
  return localStorage.getItem(DESKTOP_NOTIFICATIONS_KEY) !== 'false'
}

export function setDesktopNotificationsEnabled(enabled: boolean) {
  localStorage.setItem(DESKTOP_NOTIFICATIONS_KEY, String(enabled))
}

export function isNotificationSoundEnabled(): boolean {
  return localStorage.getItem(NOTIFICATION_SOUND_KEY) !== 'false'
}

export function setNotificationSoundEnabled(enabled: boolean) {
  localStorage.setItem(NOTIFICATION_SOUND_KEY, String(enabled))
}

export function getNotificationSoundChoice(): SoundId {
  const val = localStorage.getItem(NOTIFICATION_SOUND_CHOICE_KEY) as SoundId | null
  if (val && SOUND_PRESETS.some(p => p.id === val)) return val
  return 'chime'
}

export function setNotificationSoundChoice(choice: SoundId) {
  localStorage.setItem(NOTIFICATION_SOUND_CHOICE_KEY, choice)
}

/** Notification-sound volume, 0..1. Applied as a master gain multiplier. */
export function getNotificationVolume(): number {
  const raw = localStorage.getItem(NOTIFICATION_VOLUME_KEY)
  if (raw == null) return 0.5
  const n = Number(raw)
  if (!Number.isFinite(n)) return 0.5
  return Math.min(1, Math.max(0, n))
}

export function setNotificationVolume(v: number) {
  const clamped = Math.min(1, Math.max(0, v))
  localStorage.setItem(NOTIFICATION_VOLUME_KEY, String(clamped))
}

export function isCallRingEnabled(): boolean {
  return localStorage.getItem(CALL_RING_ENABLED_KEY) !== 'false'
}

export function setCallRingEnabled(enabled: boolean) {
  localStorage.setItem(CALL_RING_ENABLED_KEY, String(enabled))
}

// ---- Do Not Disturb ----

export interface DndSchedule { startHHMM: string; endHHMM: string }

export function isDndManuallyOn(): boolean {
  return localStorage.getItem(DND_MANUAL_KEY) === 'true'
}

export function setDndManual(enabled: boolean) {
  localStorage.setItem(DND_MANUAL_KEY, String(enabled))
}

export function isDndScheduleEnabled(): boolean {
  return localStorage.getItem(DND_SCHEDULE_ENABLED_KEY) === 'true'
}

export function setDndScheduleEnabled(enabled: boolean) {
  localStorage.setItem(DND_SCHEDULE_ENABLED_KEY, String(enabled))
}

export function getDndSchedule(): DndSchedule {
  return {
    startHHMM: localStorage.getItem(DND_SCHEDULE_START_KEY) ?? '22:00',
    endHHMM: localStorage.getItem(DND_SCHEDULE_END_KEY) ?? '08:00',
  }
}

export function setDndSchedule(schedule: DndSchedule) {
  localStorage.setItem(DND_SCHEDULE_START_KEY, schedule.startHHMM)
  localStorage.setItem(DND_SCHEDULE_END_KEY, schedule.endHHMM)
}

export function isDndAllowMentions(): boolean {
  return localStorage.getItem(DND_ALLOW_MENTIONS_KEY) === 'true'
}

export function setDndAllowMentions(enabled: boolean) {
  localStorage.setItem(DND_ALLOW_MENTIONS_KEY, String(enabled))
}

function parseHHMM(s: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s)
  if (!m) return null
  const h = Number(m[1]); const mm = Number(m[2])
  if (h < 0 || h > 23 || mm < 0 || mm > 59) return null
  return h * 60 + mm
}

/** Returns true if now (local time) falls in [start, end), handling overnight ranges (end <= start). */
function isWithinSchedule(startHHMM: string, endHHMM: string, now = new Date()): boolean {
  const start = parseHHMM(startHHMM)
  const end = parseHHMM(endHHMM)
  if (start == null || end == null) return false
  if (start === end) return false
  const mins = now.getHours() * 60 + now.getMinutes()
  if (start < end) return mins >= start && mins < end
  // Overnight: e.g. 22:00 → 08:00 wraps midnight.
  return mins >= start || mins < end
}

/** True if DND is currently active — manual override OR schedule is in range. */
export function isDndActive(): boolean {
  if (isDndManuallyOn()) return true
  if (isDndScheduleEnabled()) {
    const { startHHMM, endHHMM } = getDndSchedule()
    if (isWithinSchedule(startHHMM, endHHMM)) return true
  }
  return false
}

// ---- Browser Notification Permission ----

export function getNotificationPermission(): NotificationPermission {
  if (!('Notification' in window)) return 'denied'
  return Notification.permission
}

export async function requestNotificationPermission(): Promise<NotificationPermission> {
  if (!('Notification' in window)) return 'denied'
  return Notification.requestPermission()
}

// ---- Desktop Notification ----

export interface DesktopNotificationOpts {
  title: string
  body: string
  iconUrl?: string
  /**
   * Stable identifier for coalescing. Multiple notifications with the same
   * `tag` replace each other in the OS notification center rather than
   * stacking — so a burst of messages from one room doesn't spam the user.
   */
  tag?: string
  /** If true, the OS re-alerts even when replacing an existing tag. */
  renotify?: boolean
  onClick?: () => void
}

export function showDesktopNotification(opts: DesktopNotificationOpts): Notification | null
export function showDesktopNotification(
  title: string,
  body: string,
  iconUrl?: string,
  onClick?: () => void,
): Notification | null
export function showDesktopNotification(
  titleOrOpts: string | DesktopNotificationOpts,
  body?: string,
  iconUrl?: string,
  onClick?: () => void,
): Notification | null {
  const opts: DesktopNotificationOpts = typeof titleOrOpts === 'string'
    ? { title: titleOrOpts, body: body ?? '', iconUrl, onClick }
    : titleOrOpts

  if (!isDesktopNotificationsEnabled()) return null
  if (getNotificationPermission() !== 'granted') return null

  const notification = new Notification(opts.title, {
    body: opts.body,
    icon: opts.iconUrl || undefined,
    tag: opts.tag ?? `vc-${Date.now()}`,
    renotify: opts.renotify ?? !!opts.tag,
    silent: true, // we handle sound separately
  } as NotificationOptions)

  if (opts.onClick) {
    notification.onclick = () => {
      // Focus the window / tab first — crucial because the click handler
      // often runs while the tab is backgrounded.
      try { window.focus() } catch { /* ignore */ }
      try { window.parent?.focus?.() } catch { /* ignore */ }
      opts.onClick!()
      notification.close()
    }
  }

  setTimeout(() => notification.close(), 6000)
  return notification
}

// ---- Audio primitives (Web Audio API) ----

let audioContext: AudioContext | null = null

function getCtx(): AudioContext | null {
  try {
    if (!audioContext || audioContext.state === 'closed') {
      audioContext = new AudioContext()
    }
    if (audioContext.state === 'suspended') {
      audioContext.resume()
    }
    return audioContext
  } catch {
    return null
  }
}

/** Schedule a single sine-ish tone with an envelope. Returns end time. */
function scheduleTone(
  ctx: AudioContext,
  destination: AudioNode,
  opts: { startAt: number; freq: number; duration: number; peakGain: number; type?: OscillatorType; attack?: number },
): number {
  const { startAt, freq, duration, peakGain, type = 'sine', attack = 0.01 } = opts
  const osc = ctx.createOscillator()
  const gain = ctx.createGain()
  osc.type = type
  osc.frequency.setValueAtTime(freq, startAt)
  gain.gain.setValueAtTime(0, startAt)
  gain.gain.linearRampToValueAtTime(peakGain, startAt + attack)
  gain.gain.exponentialRampToValueAtTime(0.001, startAt + duration)
  osc.connect(gain)
  gain.connect(destination)
  osc.start(startAt)
  osc.stop(startAt + duration)
  return startAt + duration
}

/** Play a preset sound once. Returns approximate duration in seconds. */
function playPreset(choice: SoundId): number {
  if (choice === 'silent') return 0
  const ctx = getCtx()
  if (!ctx) return 0
  const now = ctx.currentTime
  const master = ctx.createGain()
  master.gain.value = getNotificationVolume()
  master.connect(ctx.destination)

  switch (choice) {
    case 'chime': {
      // Two-tone bell.
      const o = ctx.createOscillator()
      const g = ctx.createGain()
      o.type = 'sine'
      o.frequency.setValueAtTime(830, now)
      o.frequency.setValueAtTime(1050, now + 0.08)
      g.gain.setValueAtTime(0, now)
      g.gain.linearRampToValueAtTime(0.15, now + 0.01)
      g.gain.exponentialRampToValueAtTime(0.001, now + 0.5)
      o.connect(g); g.connect(master)
      o.start(now); o.stop(now + 0.5)
      return 0.5
    }
    case 'ping': {
      scheduleTone(ctx, master, { startAt: now, freq: 1400, duration: 0.22, peakGain: 0.16, type: 'sine' })
      return 0.22
    }
    case 'pop': {
      // Low bubble — fast attack, quick decay, lower freq.
      scheduleTone(ctx, master, { startAt: now, freq: 420, duration: 0.12, peakGain: 0.22, type: 'sine', attack: 0.004 })
      return 0.12
    }
    case 'blip': {
      scheduleTone(ctx, master, { startAt: now, freq: 660, duration: 0.18, peakGain: 0.14, type: 'triangle' })
      return 0.18
    }
  }
  return 0
}

/** Public: play a preset by id (or the user's current choice by default). */
export function playNotificationSound(id?: SoundId) {
  if (!isNotificationSoundEnabled()) return
  if (isDndActive()) return
  const choice = id ?? getNotificationSoundChoice()
  try { playPreset(choice) } catch { /* ignore */ }
}

/** Preview a preset regardless of the global enable flag — used by the settings picker. */
export function previewSound(id: SoundId) {
  try { playPreset(id) } catch { /* ignore */ }
}

/** Play the user's chosen sound for a mention. Mentions can bypass DND if opted in. */
export function playMentionSound() {
  if (!isNotificationSoundEnabled()) return
  if (isDndActive() && !isDndAllowMentions()) return
  try { playPreset(getNotificationSoundChoice()) } catch { /* ignore */ }
}

// ---- Incoming-call ringtone (looping) ----

let ringState: { ctx: AudioContext; timer: number; master: GainNode } | null = null

export function startCallRingtone() {
  if (!isCallRingEnabled()) return
  if (ringState) return
  const ctx = getCtx()
  if (!ctx) return
  const master = ctx.createGain()
  master.gain.value = 1
  master.connect(ctx.destination)

  // Classic ring-ring cadence: two short chirps, pause, repeat.
  function scheduleRing(at: number) {
    scheduleTone(ctx, master, { startAt: at,         freq: 880,  duration: 0.25, peakGain: 0.2, type: 'sine' })
    scheduleTone(ctx, master, { startAt: at + 0.32,  freq: 880,  duration: 0.25, peakGain: 0.2, type: 'sine' })
  }
  scheduleRing(ctx.currentTime + 0.05)
  const timer = window.setInterval(() => {
    if (!ringState) return
    scheduleRing(ctx.currentTime + 0.05)
  }, 2000)

  ringState = { ctx, timer, master }
}

export function stopCallRingtone() {
  if (!ringState) return
  clearInterval(ringState.timer)
  try { ringState.master.gain.setValueAtTime(0, ringState.ctx.currentTime) } catch { /* ignore */ }
  try { ringState.master.disconnect() } catch { /* ignore */ }
  ringState = null
}

// ---- Incoming event handler ----

/**
 * Direct check for a room-level mute (override push rule with `dont_notify`).
 * `getPushActionsForEvent` should already honor this, but the SDK's cached
 * rules can briefly lag the server after `addPushRule`, so we read the rules
 * map ourselves as a defensive second check.
 */
function isRoomMutedByPushRule(client: MatrixClient, roomId: string): boolean {
  const rules = (client as any).getPushRules?.()
  const overrides: any[] = rules?.global?.override ?? []
  const match = overrides.find((r: any) => r.rule_id === roomId && r.enabled)
  if (!match) return false
  const actions: any[] = match.actions ?? []
  return actions.includes('dont_notify') || actions.some((a: any) => a?.set_tweak === 'sound' && a?.value === null)
}

export function handleIncomingEvent(
  event: MatrixEvent,
  room: Room,
  client: MatrixClient,
  activeRoomId: string | null,
  onRoomClick?: (roomId: string) => void,
) {
  const sender = event.getSender()
  if (!sender || sender === client.getUserId()) return

  // Don't notify if the room is currently viewed and the window is focused
  if (room.roomId === activeRoomId && document.hasFocus()) return

  // Respect per-room mute explicitly before anything else
  if (isRoomMutedByPushRule(client, room.roomId)) return

  // Evaluate server-side push rules via the SDK
  const pushActions = client.getPushActionsForEvent(event) as
    | { notify: boolean; tweaks?: { sound?: string; highlight?: boolean } }
    | null
  if (!pushActions?.notify) return

  const isHighlight = !!pushActions.tweaks?.highlight

  // Do Not Disturb — drop the notification entirely unless this is a highlight
  // (mention / keyword hit) AND the user opted to let mentions through DND.
  if (isDndActive() && !(isHighlight && isDndAllowMentions())) {
    return
  }

  const senderMember = room.getMember(sender)
  const senderName = senderMember?.name || sender
  const roomName = room.name || room.roomId
  const content = event.getContent()
  const body = (content.body as string) || (event.getType() === 'm.sticker' ? 'Sticker' : 'New message')

  // Resolve room avatar for the notification icon
  const roomAvatarMxc = room.getMxcAvatarUrl()
  const iconUrl = roomAvatarMxc
    ? (client.mxcUrlToHttp(roomAvatarMxc, 64, 64, 'crop') || undefined)
    : undefined

  showDesktopNotification({
    title: isHighlight ? `@ ${roomName}` : roomName,
    body: `${senderName}: ${body}`,
    iconUrl,
    // One active notification per room: coalesce bursts instead of stacking.
    // Mentions/highlights use a separate tag so they don't get replaced by
    // later non-highlight messages in the same room.
    tag: isHighlight ? `vc-room-hl-${room.roomId}` : `vc-room-${room.roomId}`,
    renotify: true,
    onClick: onRoomClick ? () => onRoomClick(room.roomId) : undefined,
  })

  // Highlight-tweak from push rules = mention / keyword hit = attention sound.
  // Otherwise, only play the chime when the rule explicitly asks for a sound.
  if (isHighlight) {
    playMentionSound()
  } else if (pushActions.tweaks?.sound) {
    playNotificationSound()
  }
}
