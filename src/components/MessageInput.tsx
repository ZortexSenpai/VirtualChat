import React, { useState, useRef, useEffect, useLayoutEffect, useMemo, KeyboardEvent } from 'react'
import { MatrixEvent } from 'matrix-js-sdk'
import { useMatrix } from '../context/MatrixContext'
import type { StickerPack, StickerItem, PollAnswer, MentionRef } from '../context/MatrixContext'
import GifPicker from './GifPicker'
import { useMxcBlobUrl } from './MxcAvatar'
import LocationShareModal from './LocationShareModal'
import { matchCommands, parseCommandLine, findCommand } from '../services/commands'
import type { SlashCommand } from '../services/commands'
import { useTranslation } from '../services/i18n'
import { searchEmojiShortcodes, type EmojiEntry } from '../services/emojiShortcodes'
import { getRoomEmoteMap, type RoomEmote } from '../services/emotes'

const DRAFT_KEY = (roomId: string) => `vc_draft_${roomId}`

// ---- Voice Recorder ----

function VoiceRecorder({ onCancel, onSend }: { onCancel: () => void; onSend: (blob: Blob, durationMs: number, waveform: number[]) => void }) {
  const [elapsed, setElapsed] = useState(0)
  const [ready, setReady] = useState(false)
  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const streamRef = useRef<MediaStream | null>(null)
  const audioCtxRef = useRef<AudioContext | null>(null)
  const analyserRef = useRef<AnalyserNode | null>(null)
  const waveformRef = useRef<number[]>([])
  const rafRef = useRef<number | null>(null)
  const startTsRef = useRef<number>(Date.now())

  useEffect(() => {
    let cancelled = false
    async function start() {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
        if (cancelled) { stream.getTracks().forEach(t => t.stop()); return }
        streamRef.current = stream
        const mime = MediaRecorder.isTypeSupported('audio/ogg;codecs=opus') ? 'audio/ogg;codecs=opus'
          : MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus'
          : 'audio/webm'
        const rec = new MediaRecorder(stream, { mimeType: mime })
        rec.ondataavailable = e => { if (e.data.size > 0) chunksRef.current.push(e.data) }
        rec.start()
        mediaRecorderRef.current = rec

        // Waveform sampling
        const ctx = new AudioContext()
        const analyser = ctx.createAnalyser()
        analyser.fftSize = 256
        ctx.createMediaStreamSource(stream).connect(analyser)
        audioCtxRef.current = ctx
        analyserRef.current = analyser
        const buf = new Uint8Array(analyser.frequencyBinCount)
        let lastSample = 0
        const tick = () => {
          analyser.getByteTimeDomainData(buf)
          let sum = 0
          for (let i = 0; i < buf.length; i++) {
            const v = (buf[i] - 128) / 128
            sum += v * v
          }
          const rms = Math.sqrt(sum / buf.length)
          const now = Date.now()
          if (now - lastSample >= 100 && waveformRef.current.length < 1024) {
            waveformRef.current.push(Math.min(1024, Math.round(rms * 1024)))
            lastSample = now
          }
          setElapsed(Math.floor((now - startTsRef.current) / 1000))
          rafRef.current = requestAnimationFrame(tick)
        }
        startTsRef.current = Date.now()
        rafRef.current = requestAnimationFrame(tick)
        setReady(true)
      } catch (err) {
        console.error('Microphone access failed:', err)
        onCancel()
      }
    }
    start()
    return () => {
      cancelled = true
      if (rafRef.current) cancelAnimationFrame(rafRef.current)
      mediaRecorderRef.current?.state === 'recording' && mediaRecorderRef.current.stop()
      streamRef.current?.getTracks().forEach(t => t.stop())
      audioCtxRef.current?.close().catch(() => {})
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function finish() {
    const rec = mediaRecorderRef.current
    if (!rec) { onCancel(); return }
    const durationMs = Date.now() - startTsRef.current
    const mime = rec.mimeType
    await new Promise<void>(resolve => {
      rec.onstop = () => resolve()
      rec.stop()
    })
    streamRef.current?.getTracks().forEach(t => t.stop())
    if (rafRef.current) cancelAnimationFrame(rafRef.current)
    audioCtxRef.current?.close().catch(() => {})
    const blob = new Blob(chunksRef.current, { type: mime })
    if (blob.size === 0) { onCancel(); return }
    onSend(blob, durationMs, waveformRef.current)
  }

  const mins = Math.floor(elapsed / 60)
  const secs = elapsed % 60
  return (
    <div className="voice-recorder">
      <span className="voice-recorder-dot" />
      <span className="voice-recorder-time">{mins}:{secs.toString().padStart(2, '0')}</span>
      <span className="voice-recorder-label">{ready ? 'Recording…' : 'Requesting microphone…'}</span>
      <button className="voice-recorder-btn voice-recorder-cancel" onClick={onCancel} type="button" title="Cancel">✕</button>
      <button className="voice-recorder-btn voice-recorder-send" onClick={finish} type="button" title="Send" disabled={!ready}>➤</button>
    </div>
  )
}

// ---- Poll Modal ----

function PollModal({ onClose }: { onClose: () => void }) {
  const { sendPoll } = useMatrix()
  const [question, setQuestion] = useState('')
  const [answers, setAnswers] = useState<string[]>(['', ''])
  const [disclosed, setDisclosed] = useState(true)
  const [maxSelections, setMaxSelections] = useState(1)
  const [sending, setSending] = useState(false)

  function randomId() {
    return Math.random().toString(36).slice(2, 10)
  }

  async function handleCreate() {
    const validAnswers = answers.map(a => a.trim()).filter(Boolean)
    if (!question.trim() || validAnswers.length < 2) return
    setSending(true)
    try {
      const pollAnswers: PollAnswer[] = validAnswers.map(text => ({ id: randomId(), text }))
      await sendPoll({
        question: question.trim(),
        answers: pollAnswers,
        kind: disclosed ? 'm.poll.disclosed' : 'm.poll.undisclosed',
        maxSelections: Math.max(1, Math.min(maxSelections, pollAnswers.length)),
      })
      onClose()
    } catch (err) {
      console.error('Poll send failed:', err)
    } finally {
      setSending(false)
    }
  }

  const validAnswerCount = answers.filter(a => a.trim()).length
  const canSubmit = !sending && question.trim().length > 0 && validAnswerCount >= 2

  return (
    <div className="modal-overlay" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="modal-card poll-modal">
        <h2>Create Poll</h2>

        <div className="rs-field">
          <label className="rs-label">Question</label>
          <input
            className="rs-input"
            placeholder="Ask a question…"
            value={question}
            onChange={e => setQuestion(e.target.value)}
            autoFocus
          />
        </div>

        <div className="rs-field poll-modal-answers">
          <label className="rs-label">Options</label>
          {answers.map((a, i) => (
            <div key={i} className="poll-modal-answer-row">
              <input
                className="rs-input"
                placeholder={`Option ${i + 1}`}
                value={a}
                onChange={e => setAnswers(prev => prev.map((v, j) => j === i ? e.target.value : v))}
              />
              {answers.length > 2 && (
                <button
                  className="poll-modal-remove"
                  onClick={() => setAnswers(prev => prev.filter((_, j) => j !== i))}
                  title="Remove option"
                  type="button"
                >✕</button>
              )}
            </div>
          ))}
          {answers.length < 20 && (
            <button
              className="poll-modal-add"
              onClick={() => setAnswers(prev => [...prev, ''])}
              type="button"
            >+ Add option</button>
          )}
        </div>

        <div className="rs-field">
          <label className="poll-modal-check">
            <input type="checkbox" checked={disclosed} onChange={e => setDisclosed(e.target.checked)} />
            <span>Show results before poll ends</span>
          </label>
        </div>

        <div className="rs-field">
          <label className="rs-label">Max selections per voter</label>
          <input
            type="number"
            className="rs-input poll-modal-max"
            min={1}
            max={Math.max(1, validAnswerCount)}
            value={maxSelections}
            onChange={e => setMaxSelections(Number(e.target.value) || 1)}
          />
        </div>

        <div className="modal-actions">
          <button className="btn-secondary" onClick={onClose}>Cancel</button>
          <button
            className="rs-save-btn"
            onClick={handleCreate}
            disabled={!canSubmit}
          >{sending ? 'Creating…' : 'Create Poll'}</button>
        </div>
      </div>
    </div>
  )
}

// ---- Auto-format JSON in fenced code blocks ----
//
// When `vc_autoformat_json` is on, scan the body for ```…``` blocks; if the
// body parses as JSON, replace it with `JSON.stringify(parsed, null, 2)`.
// Untagged blocks must look like JSON (start with `{` or `[`) before we
// attempt to parse, so plain prose inside ``` doesn't accidentally fail.
const FENCED_RE = /(^|\n)```([^\n`]*)\n([\s\S]*?)\n```/g

function autoformatJsonBlocks(body: string): string {
  return body.replace(FENCED_RE, (match, lead: string, lang: string, code: string) => {
    const tag = lang.trim().toLowerCase()
    const looksLikeJson = /^\s*[{\[]/.test(code)
    if (tag !== 'json' && !looksLikeJson) return match
    try {
      const formatted = JSON.stringify(JSON.parse(code), null, 2)
      return `${lead}\`\`\`${lang || 'json'}\n${formatted}\n\`\`\``
    } catch {
      return match
    }
  })
}

// ---- Sticker Picker ----

function StickerThumb({ url, alt }: { url: string; alt: string }) {
  // forceDownload: stickers are usually animated GIF/WebP — the thumbnail
  // endpoint flattens animation, so fetch the original.
  const blob = useMxcBlobUrl(url, 80, 80, 'scale', true)
  if (!blob) return <span style={{ fontSize: 24 }}>🖼</span>
  return <img src={blob} alt={alt} loading="lazy" />
}

function StickerPicker({ onClose, client }: { onClose: () => void; client: any }) {
  const { getStickerPacks, sendSticker } = useMatrix()
  const [packs, setPacks] = useState<StickerPack[]>([])
  const [activePack, setActivePack] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    getStickerPacks().then(p => {
      setPacks(p)
      if (p.length > 0) setActivePack(p[0].id)
      setLoading(false)
    }).catch(() => setLoading(false))
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    function onDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') onClose() }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey as any)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey as any)
    }
  }, [onClose])

  const currentPack = packs.find(p => p.id === activePack)

  async function handleSend(sticker: StickerItem) {
    onClose()
    await sendSticker(sticker.url, sticker.body, { w: sticker.w, h: sticker.h, mimetype: sticker.mimetype })
  }

  return (
    <div className="sticker-picker" ref={ref}>
      {loading ? (
        <div style={{ padding: 24, display: 'flex', justifyContent: 'center' }}><div className="spinner" /></div>
      ) : packs.length === 0 ? (
        <p className="sticker-picker-empty">No sticker packs. Add some in Settings &gt; Sticker Packs.</p>
      ) : (
        <>
          <div className="sticker-picker-tabs">
            {packs.map(pack => (
              <button
                key={pack.id}
                className={`sticker-picker-tab${activePack === pack.id ? ' active' : ''}`}
                onClick={() => setActivePack(pack.id)}
              >
                {pack.name}
              </button>
            ))}
          </div>
          <div className="sticker-picker-grid">
            {(currentPack?.stickers ?? []).map(s => (
              <button key={s.id} className="sticker-picker-item" onClick={() => handleSend(s)} title={s.body}>
                <StickerThumb url={s.url} alt={s.body} />
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  )
}

interface MessageInputProps {
  roomName: string
  editingEvent?: MatrixEvent | null
  onCancelEdit?: () => void
}

interface PendingAttachment {
  id: string
  file: File
  previewUrl: string | null
}

function makeAttachment(file: File): PendingAttachment {
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const previewUrl = file.type.startsWith('image/') ? URL.createObjectURL(file) : null
  return { id, file, previewUrl }
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

export default function MessageInput({ roomName, editingEvent, onCancelEdit }: MessageInputProps) {
  const { t } = useTranslation()
  const { state, client, sendMessage, sendGif, setReplyTo, editMessage, sendFile, sendTypingNotification, sendVoiceMessage, inviteUser, kickMember, banMember, joinRoom } = useMatrix()
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const [showGif, setShowGif] = useState(false)
  const [showStickers, setShowStickers] = useState(false)
  const [showPoll, setShowPoll] = useState(false)
  const [showLocation, setShowLocation] = useState(false)
  const [recording, setRecording] = useState(false)
  const [attachments, setAttachments] = useState<PendingAttachment[]>([])
  const [showMoreMenu, setShowMoreMenu] = useState(false)
  const [commandError, setCommandError] = useState<string | null>(null)
  const [commandInfo, setCommandInfo] = useState<string | null>(null)
  const [paletteIndex, setPaletteIndex] = useState(0)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const moreMenuRef = useRef<HTMLDivElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const typingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Track whether text state was set from a user keystroke vs a room switch,
  // to avoid saving the outgoing room's draft into the incoming room's key.
  const lastRoomIdRef = useRef<string | null>(null)

  // Revoke preview URLs on unmount so we don't leak blob memory
  useEffect(() => () => {
    attachments.forEach(a => { if (a.previewUrl) URL.revokeObjectURL(a.previewUrl) })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function removeAttachment(id: string) {
    setAttachments(prev => {
      const target = prev.find(a => a.id === id)
      if (target?.previewUrl) URL.revokeObjectURL(target.previewUrl)
      return prev.filter(a => a.id !== id)
    })
  }

  function clearAttachments() {
    attachments.forEach(a => { if (a.previewUrl) URL.revokeObjectURL(a.previewUrl) })
    setAttachments([])
  }

  // Re-focus after send completes (textarea was disabled during send, so focus must wait for re-render)
  useEffect(() => {
    if (!sending) {
      textareaRef.current?.focus()
    }
  }, [sending])

  // Close the "+" more-menu on outside click or Escape.
  useEffect(() => {
    if (!showMoreMenu) return
    function onDown(e: MouseEvent) {
      if (moreMenuRef.current && !moreMenuRef.current.contains(e.target as Node)) {
        setShowMoreMenu(false)
      }
    }
    function onKey(e: globalThis.KeyboardEvent) {
      if (e.key === 'Escape') setShowMoreMenu(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [showMoreMenu])

  // Focus the textarea when a reply is initiated
  useEffect(() => {
    if (state.replyTo) {
      textareaRef.current?.focus()
    }
  }, [state.replyTo])

  // Pre-fill text when editingEvent changes
  useEffect(() => {
    if (editingEvent) {
      const body = editingEvent.getContent().body ?? ''
      setText(body)
      textareaRef.current?.focus()
    } else {
      // Restore draft for the active room when exiting edit mode
      const draft = state.activeRoomId ? localStorage.getItem(DRAFT_KEY(state.activeRoomId)) ?? '' : ''
      setText(draft)
    }
  }, [editingEvent?.getId()])

  // Load/save per-room draft when the active room changes
  useEffect(() => {
    const roomId = state.activeRoomId
    if (editingEvent) return
    lastRoomIdRef.current = roomId
    setPendingMentions([])
    if (!roomId) { setText(''); return }
    const draft = localStorage.getItem(DRAFT_KEY(roomId)) ?? ''
    setText(draft)
  }, [state.activeRoomId, editingEvent?.getId()])

  // Persist draft on text change. Skip while editing (edit text is not a draft).
  useEffect(() => {
    if (editingEvent) return
    const roomId = state.activeRoomId
    if (!roomId) return
    // Avoid persisting the previous room's text into the new room right after a switch
    if (lastRoomIdRef.current !== roomId) return
    if (text) localStorage.setItem(DRAFT_KEY(roomId), text)
    else localStorage.removeItem(DRAFT_KEY(roomId))
  }, [text, state.activeRoomId, editingEvent?.getId()])

  // Textarea auto-resize.
  //
  // useLayoutEffect runs after React commits the new value prop to the DOM but
  // before the browser paints, so we read the post-commit scrollHeight and set
  // the height in the same frame — no flicker, no setTimeout dance.
  //
  // The pattern is: collapse to auto → read scrollHeight (which now reflects
  // real content height including padding) → clamp to a max. Also account for
  // explicit border/box-sizing so height tracks scroll without overflow.
  const MAX_TEXTAREA_HEIGHT = 400
  useLayoutEffect(() => {
    const ta = textareaRef.current
    if (!ta) return
    ta.style.height = 'auto'
    const next = Math.min(ta.scrollHeight, MAX_TEXTAREA_HEIGHT)
    ta.style.height = next + 'px'
    // If we hit the cap, show a scrollbar; otherwise hide it so short messages
    // don't flash a scrollbar briefly during type/delete.
    ta.style.overflowY = ta.scrollHeight > MAX_TEXTAREA_HEIGHT ? 'auto' : 'hidden'
  }, [text])


  // --- Slash command palette state ---
  // Only activate the palette while the composer is a single-line command-ish
  // input (no newlines, starts with exactly one '/'). Multi-line drafts that
  // happen to start with '/' stay as regular text.
  const commandQuery = useMemo(() => {
    if (!text.startsWith('/') || text.startsWith('//')) return null
    if (text.includes('\n')) return null
    if (editingEvent) return null
    const body = text.slice(1)
    const spaceIdx = body.search(/\s/)
    const name = spaceIdx === -1 ? body : body.slice(0, spaceIdx)
    const typingArgs = spaceIdx !== -1
    return { name, typingArgs }
  }, [text, editingEvent])

  const paletteMatches = useMemo<SlashCommand[]>(() => {
    if (!commandQuery) return []
    if (commandQuery.typingArgs) {
      const exact = findCommand(commandQuery.name)
      return exact ? [exact] : []
    }
    return matchCommands(commandQuery.name).slice(0, 8)
  }, [commandQuery])

  useEffect(() => {
    setPaletteIndex(i => (paletteMatches.length === 0 ? 0 : Math.min(i, paletteMatches.length - 1)))
  }, [paletteMatches.length])

  // --- Emoji autocomplete (":shortcode") state ---
  // We track the cursor position so we know where the ":token" starts and can
  // replace just that slice on completion instead of rewriting the whole value.
  const [cursorPos, setCursorPos] = useState(0)
  const [emojiPaletteIndex, setEmojiPaletteIndex] = useState(0)

  // --- Mention autocomplete ("@user") state ---
  // pendingMentions tracks display-name → userId for mentions inserted via the
  // picker, so sendMessage can serialise them as Matrix m.mentions + HTML pills.
  // Reset whenever the composer is cleared.
  const [pendingMentions, setPendingMentions] = useState<MentionRef[]>([])
  const [mentionPaletteIndex, setMentionPaletteIndex] = useState(0)

  const activeRoom = state.activeRoomId ? client?.getRoom(state.activeRoomId) ?? null : null
  const roomEmoteMap: Record<string, RoomEmote> = useMemo(
    () => activeRoom ? getRoomEmoteMap(activeRoom) : {},
    // Re-read when the active room changes; don't need to re-read on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [state.activeRoomId],
  )

  // Identify a ":token" at the cursor. The token is active only if there's at
  // least one character after the colon and no whitespace/newline inside it,
  // and the colon is preceded by whitespace, start-of-string, or punctuation
  // (so "http://foo" or "12:34" don't accidentally open the picker).
  const emojiQuery = useMemo(() => {
    if (!text || editingEvent) return null
    if (cursorPos === 0) return null
    const before = text.slice(0, cursorPos)
    const match = before.match(/(?:^|[\s(])(:([A-Za-z0-9_+\-]{1,32}))$/)
    if (!match) return null
    // Absolute start index of the ":" in `text`.
    const start = cursorPos - match[1].length
    return { start, end: cursorPos, query: match[2] }
  }, [text, cursorPos, editingEvent])

  interface EmojiPaletteItem {
    kind: 'unicode' | 'custom'
    shortcode: string
    emoji?: string
    emote?: RoomEmote
  }

  const emojiMatches = useMemo<EmojiPaletteItem[]>(() => {
    if (!emojiQuery) return []
    const q = emojiQuery.query.toLowerCase()
    const out: EmojiPaletteItem[] = []
    for (const [code, emote] of Object.entries(roomEmoteMap)) {
      if (code.toLowerCase().includes(q)) {
        out.push({ kind: 'custom', shortcode: code, emote })
      }
    }
    const unicode: EmojiEntry[] = searchEmojiShortcodes(emojiQuery.query, 8 - out.length)
    for (const e of unicode) {
      out.push({ kind: 'unicode', shortcode: e.shortcode, emoji: e.emoji })
    }
    return out.slice(0, 8)
  }, [emojiQuery, roomEmoteMap])

  useEffect(() => {
    setEmojiPaletteIndex(i => (emojiMatches.length === 0 ? 0 : Math.min(i, emojiMatches.length - 1)))
  }, [emojiMatches.length])

  function completeEmoji(item: EmojiPaletteItem) {
    if (!emojiQuery) return
    const replacement = item.kind === 'custom' ? `:${item.shortcode}:` : item.emoji ?? ''
    const newText = text.slice(0, emojiQuery.start) + replacement + text.slice(emojiQuery.end)
    const newCursor = emojiQuery.start + replacement.length
    setText(newText)
    requestAnimationFrame(() => {
      const ta = textareaRef.current
      if (!ta) return
      ta.focus()
      ta.setSelectionRange(newCursor, newCursor)
      setCursorPos(newCursor)
    })
  }

  // Detect a "@token" at the cursor. Same lead-in rules as emoji, minus the
  // colon-vs-time-syntax dance: we just want word characters.
  const mentionQuery = useMemo(() => {
    if (!text || editingEvent) return null
    if (cursorPos === 0) return null
    const before = text.slice(0, cursorPos)
    const match = before.match(/(?:^|[\s(])(@([A-Za-z0-9_\-.]{0,32}))$/)
    if (!match) return null
    const start = cursorPos - match[1].length
    return { start, end: cursorPos, query: match[2] }
  }, [text, cursorPos, editingEvent])

  interface MentionPaletteItem {
    userId: string
    displayName: string
    avatarMxc: string | null
  }

  const mentionMatches = useMemo<MentionPaletteItem[]>(() => {
    if (!mentionQuery || !activeRoom) return []
    const q = mentionQuery.query.toLowerCase()
    const members = activeRoom.getJoinedMembers()
    const out: MentionPaletteItem[] = []
    for (const m of members) {
      const name = (m.name ?? '').toLowerCase()
      const id = m.userId.toLowerCase()
      if (q === '' || name.includes(q) || id.includes(q)) {
        out.push({
          userId: m.userId,
          displayName: m.name || m.userId.replace(/^@/, '').split(':')[0],
          avatarMxc: m.getMxcAvatarUrl() ?? null,
        })
      }
      if (out.length >= 8) break
    }
    return out
  }, [mentionQuery, activeRoom])

  useEffect(() => {
    setMentionPaletteIndex(i => (mentionMatches.length === 0 ? 0 : Math.min(i, mentionMatches.length - 1)))
  }, [mentionMatches.length])

  function completeMention(item: MentionPaletteItem) {
    if (!mentionQuery) return
    const replacement = `@${item.displayName} `
    const newText = text.slice(0, mentionQuery.start) + replacement + text.slice(mentionQuery.end)
    const newCursor = mentionQuery.start + replacement.length
    setText(newText)
    setPendingMentions(prev => {
      // Avoid duplicate entries when the same user is tagged twice.
      if (prev.some(p => p.userId === item.userId && p.displayName === item.displayName)) return prev
      return [...prev, { userId: item.userId, displayName: item.displayName }]
    })
    requestAnimationFrame(() => {
      const ta = textareaRef.current
      if (!ta) return
      ta.focus()
      ta.setSelectionRange(newCursor, newCursor)
      setCursorPos(newCursor)
    })
  }

  // Auto-dismiss ephemeral command feedback
  useEffect(() => {
    if (!commandError && !commandInfo) return
    const t = setTimeout(() => { setCommandError(null); setCommandInfo(null) }, 4000)
    return () => clearTimeout(t)
  }, [commandError, commandInfo])

  function completeCommand(cmd: SlashCommand) {
    setText(`/${cmd.name} `)
    // Move cursor to end after React commits the new value
    requestAnimationFrame(() => {
      const ta = textareaRef.current
      if (!ta) return
      ta.focus()
      const end = ta.value.length
      ta.setSelectionRange(end, end)
    })
  }

  async function executeCommandLine(line: string): Promise<void> {
    if (!client) throw new Error('Not connected')
    const parsed = parseCommandLine(line)
    if (!parsed) {
      const name = line.slice(1).split(/\s/)[0]
      throw new Error(`Unknown command: /${name}. Type /help for the list.`)
    }
    const result = await parsed.command.run(parsed.args, {
      client,
      roomId: state.activeRoomId,
      replyTo: state.replyTo,
      sendTextMessage: sendMessage,
      inviteUser,
      kickMember,
      banMember,
      joinRoom,
    })
    if (result && result.info) setCommandInfo(result.info)
  }

  async function handleSend() {
    if (sending) return
    const hasText = text.trim().length > 0
    const hasAttachments = attachments.length > 0
    if (!hasText && !hasAttachments) return

    // Edits don't support attachments — just update the text.
    if (editingEvent) {
      setSending(true)
      try {
        await editMessage(state.activeRoomId!, editingEvent.getId() ?? '', text.trim())
        onCancelEdit?.()
        sendTypingNotification(false)
        setText('')
      } catch (err) {
        console.error('Edit failed:', err)
      } finally {
        setSending(false)
      }
      return
    }

    // Escape: "//foo" sends the literal text "/foo" without command parsing.
    if (text.startsWith('//') && attachments.length === 0) {
      setSending(true)
      try {
        await sendMessage(text.slice(1), state.replyTo)
        sendTypingNotification(false)
        setText('')
      } catch (err) {
        console.error('Send failed:', err)
      } finally {
        setSending(false)
      }
      return
    }

    // Slash command: single-line input that starts with exactly one '/'.
    if (text.startsWith('/') && !text.includes('\n') && attachments.length === 0) {
      setSending(true)
      setCommandError(null)
      setCommandInfo(null)
      try {
        await executeCommandLine(text)
        setText('')
        sendTypingNotification(false)
      } catch (err: any) {
        const msg = err?.data?.error ?? err?.message ?? 'Command failed'
        setCommandError(msg)
      } finally {
        setSending(false)
      }
      return
    }

    setSending(true)
    try {
      // Upload attachments first so they appear in timeline order before any caption.
      for (const att of attachments) {
        try { await sendFile(att.file) }
        catch (err) { console.error('Attachment upload failed:', err) }
      }
      if (hasText) {
        const body = localStorage.getItem('vc_autoformat_json') === 'true'
          ? autoformatJsonBlocks(text)
          : text
        await sendMessage(body, state.replyTo, pendingMentions)
      }
      clearAttachments()
      sendTypingNotification(false)
      setText('')
      setPendingMentions([])
    } catch (err) {
      console.error('Send failed:', err)
    } finally {
      setSending(false)
    }
  }

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    const paletteOpen = paletteMatches.length > 0 && commandQuery && !commandQuery.typingArgs
    if (paletteOpen) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setPaletteIndex(i => (i + 1) % paletteMatches.length)
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setPaletteIndex(i => (i - 1 + paletteMatches.length) % paletteMatches.length)
        return
      }
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
        e.preventDefault()
        const cmd = paletteMatches[paletteIndex]
        if (cmd) completeCommand(cmd)
        return
      }
    }
    const emojiOpen = emojiMatches.length > 0 && emojiQuery
    if (emojiOpen) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setEmojiPaletteIndex(i => (i + 1) % emojiMatches.length)
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setEmojiPaletteIndex(i => (i - 1 + emojiMatches.length) % emojiMatches.length)
        return
      }
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
        e.preventDefault()
        const item = emojiMatches[emojiPaletteIndex]
        if (item) completeEmoji(item)
        return
      }
      if (e.key === 'Escape') {
        // Close the palette without sending / cancelling reply etc.
        e.preventDefault()
        setCursorPos(-1)
        return
      }
    }
    const mentionOpen = mentionMatches.length > 0 && mentionQuery
    if (mentionOpen) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setMentionPaletteIndex(i => (i + 1) % mentionMatches.length)
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setMentionPaletteIndex(i => (i - 1 + mentionMatches.length) % mentionMatches.length)
        return
      }
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
        e.preventDefault()
        const item = mentionMatches[mentionPaletteIndex]
        if (item) completeMention(item)
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        setCursorPos(-1)
        return
      }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
    if (e.key === 'Escape') {
      if (commandError || commandInfo) {
        setCommandError(null)
        setCommandInfo(null)
      } else if (attachments.length > 0) {
        clearAttachments()
      } else if (state.replyTo) {
        setReplyTo(null)
      }
    }
  }

  async function handleGifSelect(gifUrl: string, title: string) {
    setSending(true)
    try {
      await sendGif(gifUrl, title)
    } catch (err) {
      console.error('GIF send failed:', err)
    } finally {
      setSending(false)
    }
  }

  const replyTo = state.replyTo
  const replySenderName = replyTo
    ? (replyTo.getSender() ?? '').replace(/^@/, '').split(':')[0]
    : null

  function wrapSelection(before: string, after: string) {
    const ta = textareaRef.current
    if (!ta) return
    const start = ta.selectionStart
    const end = ta.selectionEnd
    const selected = text.slice(start, end)
    const newText = text.slice(0, start) + before + selected + after + text.slice(end)
    setText(newText)
    setTimeout(() => {
      ta.focus()
      if (selected) {
        ta.selectionStart = start + before.length
        ta.selectionEnd = end + before.length
      } else {
        ta.selectionStart = ta.selectionEnd = start + before.length
      }
    }, 0)
  }

  function handleFormatKey(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (!(e.ctrlKey || e.metaKey)) return
    switch (e.key) {
      case 'b': e.preventDefault(); wrapSelection('**', '**'); break
      case 'i': e.preventDefault(); wrapSelection('*', '*'); break
      case 'u': e.preventDefault(); wrapSelection('<u>', '</u>'); break
    }
  }

  async function handleVoiceSend(blob: Blob, durationMs: number, waveform: number[]) {
    setRecording(false)
    setSending(true)
    try {
      await sendVoiceMessage(blob, durationMs, waveform)
    } catch (err) {
      console.error('Voice message send failed:', err)
    } finally {
      setSending(false)
    }
  }

  return (
    <div className="message-input-area" style={{ position: 'relative' }}>
      {showGif && (
        <GifPicker
          onSelect={handleGifSelect}
          onClose={() => { setShowGif(false); textareaRef.current?.focus() }}
        />
      )}
      {showStickers && (
        <StickerPicker
          client={client}
          onClose={() => { setShowStickers(false); textareaRef.current?.focus() }}
        />
      )}
      {showPoll && (
        <PollModal onClose={() => setShowPoll(false)} />
      )}
      {showLocation && (
        <LocationShareModal onClose={() => setShowLocation(false)} />
      )}

      {editingEvent && (
        <div className="reply-preview-bar">
          <span className="reply-preview-label">{t('composer.editing')}</span>
          <button className="reply-preview-cancel" onClick={() => { onCancelEdit?.(); sendTypingNotification(false) }} title={t('composer.cancelEdit')} type="button">✕</button>
        </div>
      )}

      {replyTo && (
        <div className="reply-preview-bar">
          <span className="reply-preview-label">{t('composer.replyingTo')}</span>
          <span className="reply-preview-name">{replySenderName}</span>
          <span className="reply-preview-text">{replyTo.getContent().body ?? ''}</span>
          <button
            className="reply-preview-cancel"
            onClick={() => setReplyTo(null)}
            title={t('composer.cancelReply')}
            type="button"
          >
            ✕
          </button>
        </div>
      )}

      {/* Formatting toolbar */}
      {state.activeRoomId && (
        <div className="format-toolbar">
          <button className="format-btn" onClick={() => wrapSelection('**', '**')} title={t('composer.bold')} type="button"><strong>B</strong></button>
          <button className="format-btn" onClick={() => wrapSelection('*', '*')} title={t('composer.italic')} type="button"><em>I</em></button>
          <button className="format-btn" onClick={() => wrapSelection('~~', '~~')} title={t('composer.strikethrough')} type="button"><s>S</s></button>
          <button className="format-btn" onClick={() => wrapSelection('`', '`')} title={t('composer.inlineCode')} type="button"><code>&lt;/&gt;</code></button>
          <button className="format-btn" onClick={() => wrapSelection('||', '||')} title={t('composer.spoiler')} type="button">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/><line x1="1" y1="1" x2="23" y2="23"/></svg>
          </button>
          <button className="format-btn" onClick={() => wrapSelection('```\n', '\n```')} title={t('composer.codeBlock')} type="button">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>
          </button>
          <button className="format-btn" onClick={() => wrapSelection('> ', '')} title={t('composer.quote')} type="button">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M10 8V6c0-1.1-.9-2-2-2H4C2.9 4 2 4.9 2 6v4c0 1.1.9 2 2 2h4l-2 4h2.5l2-4V8h-.5zm10 0V6c0-1.1-.9-2-2-2h-4c-1.1 0-2 .9-2 2v4c0 1.1.9 2 2 2h4l-2 4h2.5l2-4V8h-.5z"/></svg>
          </button>
        </div>
      )}

      {recording && (
        <VoiceRecorder onCancel={() => setRecording(false)} onSend={handleVoiceSend} />
      )}

      {mentionQuery && mentionMatches.length > 0 && (
        <div className="command-palette command-palette--mention" role="listbox" aria-label="Mention user">
          {mentionMatches.map((item, i) => {
            const httpUrl = item.avatarMxc
              ? (client as any)?.mxcUrlToHttp(item.avatarMxc, 24, 24, 'scale', false, true)
              : null
            return (
              <button
                key={item.userId}
                type="button"
                className={`command-palette-item${i === mentionPaletteIndex ? ' selected' : ''}`}
                onMouseEnter={() => setMentionPaletteIndex(i)}
                onMouseDown={e => { e.preventDefault(); completeMention(item) }}
                role="option"
                aria-selected={i === mentionPaletteIndex}
              >
                <span className="emoji-palette-glyph">
                  {httpUrl
                    ? <img src={httpUrl} alt="" className="emoji-palette-img" />
                    : <span className="avatar-placeholder" style={{ background: '#5865f2', borderRadius: '50%', width: 20, height: 20, fontSize: 11 }}>{item.displayName.charAt(0).toUpperCase()}</span>}
                </span>
                <span className="command-palette-name">{item.displayName}</span>
                <span className="command-palette-desc">{item.userId}</span>
              </button>
            )
          })}
          <div className="command-palette-footer">
            <kbd>Tab</kbd> complete
            <kbd>↑↓</kbd> navigate
            <kbd>Enter</kbd> insert
            <kbd>Esc</kbd> close
          </div>
        </div>
      )}

      {emojiQuery && emojiMatches.length > 0 && (
        <div className="command-palette command-palette--emoji" role="listbox" aria-label="Emoji">
          {emojiMatches.map((item, i) => {
            const mxcUrl = item.kind === 'custom' && item.emote
              ? (client as any)?.mxcUrlToHttp(item.emote.url, 32, 32, 'scale', false, true)
              : null
            return (
              <button
                key={`${item.kind}-${item.shortcode}`}
                type="button"
                className={`command-palette-item${i === emojiPaletteIndex ? ' selected' : ''}`}
                onMouseEnter={() => setEmojiPaletteIndex(i)}
                onMouseDown={e => { e.preventDefault(); completeEmoji(item) }}
                role="option"
                aria-selected={i === emojiPaletteIndex}
              >
                <span className="emoji-palette-glyph">
                  {mxcUrl
                    ? <img src={mxcUrl} alt={item.shortcode} className="emoji-palette-img" />
                    : item.emoji}
                </span>
                <span className="command-palette-name">:{item.shortcode}:</span>
                {item.kind === 'custom' && <span className="command-palette-desc">Room emote</span>}
              </button>
            )
          })}
          <div className="command-palette-footer">
            <kbd>Tab</kbd> complete
            <kbd>↑↓</kbd> navigate
            <kbd>Enter</kbd> insert
            <kbd>Esc</kbd> close
          </div>
        </div>
      )}

      {commandQuery && (paletteMatches.length > 0 || commandQuery.typingArgs) && (
        <div className="command-palette" role="listbox" aria-label="Commands">
          {commandQuery.typingArgs && paletteMatches[0] ? (
            <div className="command-palette-hint">
              <span className="command-palette-name">/{paletteMatches[0].name}</span>
              <span className="command-palette-usage">
                {paletteMatches[0].usage ?? paletteMatches[0].name}
              </span>
              <span className="command-palette-desc">— {paletteMatches[0].description}</span>
            </div>
          ) : (
            paletteMatches.map((cmd, i) => (
              <button
                key={cmd.name}
                type="button"
                className={`command-palette-item${i === paletteIndex ? ' selected' : ''}`}
                onMouseEnter={() => setPaletteIndex(i)}
                onMouseDown={e => { e.preventDefault(); completeCommand(cmd) }}
                role="option"
                aria-selected={i === paletteIndex}
              >
                <span className="command-palette-name">/{cmd.name}</span>
                {cmd.usage && cmd.usage !== `/${cmd.name}` && (
                  <span className="command-palette-usage">{cmd.usage.replace(`/${cmd.name}`, '').trim()}</span>
                )}
                <span className="command-palette-desc">{cmd.description}</span>
              </button>
            ))
          )}
          <div className="command-palette-footer">
            <kbd>Tab</kbd> complete
            <kbd>↑↓</kbd> navigate
            <kbd>Enter</kbd> run
            <kbd>Esc</kbd> close
          </div>
        </div>
      )}

      {(commandError || commandInfo) && (
        <div className={`command-toast${commandError ? ' error' : ''}`} role="status">
          {commandError ?? commandInfo}
          <button
            type="button"
            className="command-toast-close"
            onClick={() => { setCommandError(null); setCommandInfo(null) }}
            aria-label="Dismiss"
          >✕</button>
        </div>
      )}

      {attachments.length > 0 && (
        <div className="attachment-preview-row">
          {attachments.map(att => (
            <div key={att.id} className="attachment-preview-item">
              {att.previewUrl ? (
                <img className="attachment-preview-thumb" src={att.previewUrl} alt={att.file.name} />
              ) : (
                <div className="attachment-preview-file">
                  <PaperclipIcon />
                  <div className="attachment-preview-filename" title={att.file.name}>{att.file.name}</div>
                  <div className="attachment-preview-size">{formatBytes(att.file.size)}</div>
                </div>
              )}
              <button
                className="attachment-preview-remove"
                onClick={() => removeAttachment(att.id)}
                title="Remove attachment"
                type="button"
                aria-label={`Remove ${att.file.name}`}
              >✕</button>
            </div>
          ))}
        </div>
      )}

      <div className="message-input-wrap">
        {/* "+" menu — groups sticker, voice message, poll */}
        <div className="input-more" ref={moreMenuRef}>
          <button
            className={`input-btn${showMoreMenu ? ' active' : ''}`}
            title={t('composer.moreOptions')}
            onClick={() => setShowMoreMenu(v => !v)}
            disabled={!state.activeRoomId || recording}
            type="button"
            aria-haspopup="menu"
            aria-expanded={showMoreMenu}
          >
            <PlusIcon />
          </button>
          {showMoreMenu && (
            <div className="input-more-menu" role="menu">
              <button
                className="input-more-item"
                onClick={() => { setShowMoreMenu(false); fileInputRef.current?.click() }}
                disabled={!state.activeRoomId || recording}
                type="button"
                role="menuitem"
              >
                <PaperclipIcon />
                <span className="input-more-item-text">
                  <span className="input-more-item-label">Upload file</span>
                  <span className="input-more-item-desc">Images, videos, documents</span>
                </span>
              </button>
              <button
                className="input-more-item"
                onClick={() => { setShowMoreMenu(false); setShowStickers(true) }}
                disabled={!state.activeRoomId}
                type="button"
                role="menuitem"
              >
                <StickerIcon />
                <span className="input-more-item-text">
                  <span className="input-more-item-label">Sticker</span>
                  <span className="input-more-item-desc">Pick from your sticker packs</span>
                </span>
              </button>
              <button
                className="input-more-item"
                onClick={() => { setShowMoreMenu(false); setRecording(true) }}
                disabled={!state.activeRoomId || sending || !!editingEvent}
                type="button"
                role="menuitem"
              >
                <MicIcon />
                <span className="input-more-item-text">
                  <span className="input-more-item-label">Voice message</span>
                  <span className="input-more-item-desc">Record and send audio</span>
                </span>
              </button>
              <button
                className="input-more-item"
                onClick={() => { setShowMoreMenu(false); setShowPoll(true) }}
                disabled={!state.activeRoomId}
                type="button"
                role="menuitem"
              >
                <PollIcon />
                <span className="input-more-item-text">
                  <span className="input-more-item-label">Poll</span>
                  <span className="input-more-item-desc">Ask a question with options</span>
                </span>
              </button>
              <button
                className="input-more-item"
                onClick={() => { setShowMoreMenu(false); setShowLocation(true) }}
                disabled={!state.activeRoomId}
                type="button"
                role="menuitem"
              >
                <LocationIcon />
                <span className="input-more-item-text">
                  <span className="input-more-item-label">Share location</span>
                  <span className="input-more-item-desc">Send your current coordinates</span>
                </span>
              </button>
            </div>
          )}
        </div>

        {/* GIF button */}
        <button
          className="input-btn"
          title={t('composer.sendGif')}
          onClick={() => setShowGif(v => !v)}
          disabled={!state.activeRoomId || recording}
          type="button"
        >
          <svg viewBox="0 0 30 18" width="30" height="18" fill="none" aria-hidden="true">
            <rect x="0.75" y="0.75" width="28.5" height="16.5" rx="3.5" stroke="currentColor" strokeWidth="1.5"/>
            <text x="15" y="13" textAnchor="middle" fontFamily="system-ui,sans-serif" fontWeight="800" fontSize="10" fill="currentColor" letterSpacing="0.5">GIF</text>
          </svg>
        </button>

        <input ref={fileInputRef} type="file" style={{ display: 'none' }}
          onChange={async e => {
            const file = e.target.files?.[0]
            if (!file) return
            setSending(true)
            try { await sendFile(file) } catch (err) { console.error('Upload failed:', err) } finally {
              setSending(false)
              if (e.target) e.target.value = ''
            }
          }}
        />

        <textarea
          ref={textareaRef}
          className="message-input"
          rows={1}
          placeholder={state.activeRoomId ? t('composer.messagePlaceholder', { room: roomName }) : t('composer.selectRoomToChat')}
          value={text}
          onChange={e => {
            setText(e.target.value)
            setCursorPos(e.target.selectionStart)
            // Resize is handled by the useLayoutEffect watching `text`.
            if (e.target.value.trim()) {
              sendTypingNotification(true)
              if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current)
              typingTimeoutRef.current = setTimeout(() => sendTypingNotification(false), 4000)
            } else {
              sendTypingNotification(false)
            }
          }}
          onSelect={e => setCursorPos((e.target as HTMLTextAreaElement).selectionStart)}
          onClick={e => setCursorPos((e.target as HTMLTextAreaElement).selectionStart)}
          onKeyDown={e => { handleFormatKey(e); handleKeyDown(e) }}
          onPaste={e => {
            if (!state.activeRoomId || editingEvent) return
            const items = e.clipboardData?.items
            if (!items) return
            const files: File[] = []
            for (const item of Array.from(items)) {
              if (item.kind !== 'file') continue
              const file = item.getAsFile()
              if (file) files.push(file)
            }
            if (files.length === 0) return
            // A file is present — don't also paste its filename as text.
            e.preventDefault()
            setAttachments(prev => [...prev, ...files.map(makeAttachment)])
          }}
          disabled={!state.activeRoomId || sending}
        />

        {/* Send button */}
        <button
          className="input-btn"
          title={t('composer.sendMessage')}
          onClick={handleSend}
          disabled={(!text.trim() && attachments.length === 0) || !state.activeRoomId || sending}
          type="button"
        >
          ➤
        </button>
      </div>
    </div>
  )
}

function PaperclipIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
    </svg>
  )
}

function StickerIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M15.5 3H5a2 2 0 0 0-2 2v14c0 1.1.9 2 2 2h14a2 2 0 0 0 2-2V8.5L15.5 3Z" />
      <path d="M15 3v6h6" />
      <circle cx="9.5" cy="13.5" r="1.5" fill="currentColor" stroke="none" />
      <path d="M11 17c0-1.1 1.1-2 2.5-2s2.5.9 2.5 2" />
    </svg>
  )
}

function MicIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
      <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
      <line x1="12" y1="19" x2="12" y2="23" />
      <line x1="8" y1="23" x2="16" y2="23" />
    </svg>
  )
}

function PollIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="6" y1="20" x2="6" y2="10" />
      <line x1="12" y1="20" x2="12" y2="4" />
      <line x1="18" y1="20" x2="18" y2="14" />
    </svg>
  )
}

function PlusIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  )
}

function LocationIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z" />
      <circle cx="12" cy="10" r="3" />
    </svg>
  )
}
