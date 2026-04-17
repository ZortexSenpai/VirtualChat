# VirtualChat

A Discord-inspired, glassmorphism-styled Matrix client built with React and TypeScript. Connects to any Matrix homeserver (matrix.org, Synapse, Dendrite, …) and supports end-to-end encrypted chat, calls, polls, and more — all in a single web app.

## Features

### Messaging
- Rich text messages with **markdown** (bold, italic, strike, spoilers, code, quotes), rendered via `react-markdown`
- **Replies**, **threads**, **edits**, **redactions**, **read receipts**, **typing indicators**
- **Reactions** (quick emoji bar + full picker), **stickers** (with custom sticker pack management), **GIFs**
- **Polls** (MSC3381 — interoperable with Element / Cinny / FluffyChat)
- **Voice messages** — in-browser recording with waveform preview (MSC3245)
- **Image / video / audio / file uploads** with drag-and-drop, clipboard paste, and staged previews (remove/cancel before send)
- **Inline media**: images, videos (with playback), voice messages (with waveform), link previews
- **Image lightbox** with scroll/double-click/keyboard zoom, pan, download
- **Message forwarding** to any room or DM, fan-out to multiple targets
- **Pinned messages** per room
- **Per-room message drafts** (persisted to local storage)
- **Message search** within a room

### Rooms & spaces
- Create, join, knock, invite, kick, ban; configure power levels, encryption, history visibility
- **Spaces** hierarchy with space-switcher sidebar and per-space room filtering
- **DMs**, **public**, **private**, and **voice channels** (MSC3417 `io.element.video`) with distinct icons
- **Room directory** browser, join by address, knock flow
- **Pinned rooms** in home view
- **Context menu** for room actions

### Calls (1:1)
- **Voice calls** (WebRTC via matrix-js-sdk `MatrixCall`)
- **Video calls** with remote main-view + local PiP
- Mute mic, toggle camera mid-call
- **Looping ringtone** for incoming calls (cadenced ring-ring)
- Accept "with video" or "audio only" on incoming video calls

### Encryption
- **Rust crypto** (`initRustCrypto`) with Megolm + Olm
- **Device verification** via emoji SAS (m.sas.v1)
- **Cross-signing** bootstrap
- **Secret storage + key backup** with passphrase/recovery key
- Devices tab with **Verified / Cross-signed / Not verified** states and session-trust guidance
- Recovery-key prompt when the crypto callback needs SSSS

### UX
- **Ctrl/Cmd+K quick switcher** — fuzzy-rank jump to any room, DM, voice channel, or space
- **Desktop notifications** + in-app notification sounds
  - Multiple sound presets (chime, ping, pop, blip, silent) with preview
  - Distinct **mention/highlight** sound
  - Separate **call ringtone** toggle
- Light / dark theme, font-size adjustment, three message layouts (spacious, compact, bubble)
- Animations with `prefers-reduced-motion` support
- Glass (blur + saturate) aesthetic throughout
- Keyboard shortcuts for formatting (Ctrl+B / I / U)
- `prefers-reduced-motion`-aware
- **Installable as a PWA** — standalone window, home-screen icon, offline-ready app shell (service worker precaches JS/CSS/assets; Matrix API calls always go to the network)

### Account & identity
- Password login
- **SSO / OIDC** with redirect-callback flow
- Session restore across reloads
- Avatar / display-name / presence status management
- **Auto-away** — presence flips to "Idle" after 20 min of inactivity and restores on the next interaction (respects a manual Invisible / Idle choice)
- **Ignore / block** users

## Tech stack

| Layer | What |
| ----- | ---- |
| UI | React 18 + TypeScript (strict) |
| Build | Vite 6 |
| Matrix | [`matrix-js-sdk`](https://github.com/matrix-org/matrix-js-sdk) 41 (rust-crypto) |
| Markdown | `react-markdown` |
| Crypto | `@matrix-org/matrix-sdk-crypto-wasm` (via matrix-js-sdk) |
| State | React Context + `useReducer` (single `MatrixContext`) |
| PWA | `vite-plugin-pwa` (Workbox service worker + web manifest) |

No state-management library, no CSS framework — intentionally small dependency graph.

## Quick start

### Requirements
- Node.js 18+
- A Matrix account on any homeserver

### Install and run
```bash
npm install
npm run dev
```
Open the URL Vite prints (default `http://localhost:5173`).

Sign in with your Matrix user ID, homeserver URL, and password, **or** use the SSO button if your homeserver supports it.

### Build for production
```bash
npm run build
# Outputs to dist/. Serve it statically with any HTTP server.
```

### Configuration (env vars)

All config is passed through `VITE_*` env vars (read by Vite at **build time**; see `.env.example`). Copy that file to `.env` and fill in what you need.

| Var | Purpose |
| --- | ------- |
| `VITE_KLIPY_API_KEY` | Klipy API key for the GIF picker. Leave empty to disable GIF search. Get one free at <https://klipy.com/developers>. |
| `VITE_DEFAULT_HOMESERVER` | Preset value for the homeserver field on the login form (e.g. `https://matrix.example.com`). |
| `VITE_LOCK_HOMESERVER` | `true` / `1` / `yes` to hide the homeserver field entirely, so users can only sign in against `VITE_DEFAULT_HOMESERVER`. Useful for a self-hosted deployment tied to one server. |

The build also emits `manifest.webmanifest` and a Workbox-generated `sw.js`, so the deployed app is installable as a PWA. **The browser only offers install when the app is served over HTTPS (or `http://localhost`)** — on plain HTTP over a LAN IP, the install prompt will not appear even though the manifest is valid.

### Regenerating PWA icons
Icons in `public/` (`pwa-*.png`, `apple-touch-icon-*.png`, `maskable-icon-*.png`, `favicon.ico`) are generated from `public/icon.svg`. If you edit the SVG, regenerate them:
```bash
npx pwa-assets-generator --preset minimal-2023 public/icon.svg
```

## Docker

VirtualChat ships with a multi-stage `Dockerfile` (Node build → nginx serve) and an example `docker-compose.yml`.

### Build and run with Docker
```bash
docker build -t virtualchat \
  --build-arg VITE_KLIPY_API_KEY=your_klipy_key \
  --build-arg VITE_DEFAULT_HOMESERVER=https://matrix.example.com \
  --build-arg VITE_LOCK_HOMESERVER=true \
  .
docker run --rm -p 8080:80 virtualchat
```
Then open `http://localhost:8080`.

### Docker Compose
```bash
# Put your VITE_* vars in .env (see .env.example), then:
docker compose up -d --build
```

> **Note:** Vite inlines `VITE_*` variables at **build time**, not runtime. Changing any of them requires a rebuild (`docker compose build` or `docker compose up --build`). Each var is optional — leave blank to use the default behavior (see the [configuration table](#configuration-env-vars)).

The nginx config ([nginx.conf](nginx.conf)) handles SPA routing, gzip, long-cache for hashed assets, and the correct `application/wasm` content-type for `matrix-sdk-crypto-wasm`.

### Behind Traefik

The compose file ships with example Traefik v2/v3 labels (HTTP→HTTPS redirect, Let's Encrypt, HSTS, common security headers). To use them:

1. Make sure you have a Traefik instance with `web` / `websecure` entrypoints and a `letsencrypt` cert resolver.
2. Create the shared network once: `docker network create proxy`.
3. In [docker-compose.yml](docker-compose.yml), uncomment `- proxy` under `networks:` on the service and remove (or keep for local access) the `ports:` block.
4. Set the hostname in `.env`:
   ```
   VIRTUALCHAT_HOST=chat.example.com
   ```
5. `docker compose up -d --build`.

Adjust the `certresolver` name and entrypoint names if your Traefik setup uses different ones.

## Development

### Useful scripts
```bash
npm run dev        # Vite dev server with HMR
npm run build      # tsc --noEmit + vite build
npm run preview    # Preview the production build
```

### Project layout
```
src/
├── App.tsx                   # Top-level layout + providers
├── context/
│   └── MatrixContext.tsx     # Matrix client, all actions, reducer-based state
├── components/
│   ├── ChannelSidebar.tsx    # Room/DM list + create/join/knock flows
│   ├── SpaceBar.tsx          # Space switcher (leftmost rail)
│   ├── ChatArea.tsx          # Message list, composer host, modals
│   ├── MessageInput.tsx      # Composer (text, attachments, voice, polls)
│   ├── MemberList.tsx        # Right-side member panel
│   ├── CallOverlay.tsx       # Voice / video call UI
│   ├── SettingsModal.tsx     # Account / appearance / notifications / privacy / devices / security / stickerpacks
│   ├── RoomSettingsModal.tsx
│   ├── RoomDirectory.tsx
│   ├── RoomContextMenu.tsx
│   ├── ForwardModal.tsx
│   ├── QuickSwitcher.tsx     # Ctrl/Cmd+K
│   ├── ImageLightbox.tsx     # Full-screen image viewer with zoom
│   ├── ProfilePopup.tsx
│   ├── GifPicker.tsx
│   ├── MxcAvatar.tsx
│   ├── VerificationModal.tsx
│   ├── UserPanel.tsx
│   └── Login.tsx
├── services/
│   ├── notifications.ts      # Desktop notifications + Web Audio sounds + call ringtone
│   ├── media.ts              # Authenticated mxc:// → blob URL helper
│   └── roomKind.ts           # Voice-channel / room-type detection
├── styles.css                # All styles (no CSS modules — plain CSS with variables)
├── polyfills.ts
└── main.tsx
```

### Architecture notes

- **Single source of truth**: `MatrixContext` owns the Matrix client, subscribes to SDK events, and exposes both state (rooms, messages, reactions, …) and actions (send, react, invite, create, …). Every component pulls from `useMatrix()`.
- **Events → state**: the reducer consumes discrete actions dispatched from SDK event handlers. No component reaches into the SDK directly; they call actions on the context.
- **Media**: Matrix 1.11 authenticated media endpoints are used when possible, with legacy fallback. `fetchMediaBlobUrl` in `services/media.ts` handles the shape.
- **Encryption**: rust-crypto is initialised in `initClient`. Secret-storage key prompts route through an `ssKeyRequest` promise in the context, surfaced to the UI via the `RecoveryKeyModal`.
- **Motion**: the CSS motion system is centralised via `--motion-*` and `--ease-out` tokens with a global `prefers-reduced-motion` override.

## Matrix spec coverage

| Feature | MSC / Event |
| ------- | ----------- |
| Polls | MSC3381 (unstable `org.matrix.msc3381.poll.*` + stable `m.poll.*`) |
| Voice messages | MSC3245 + MSC1767 (`org.matrix.msc3245.voice`, waveform) |
| Video rooms | MSC3417 (`io.element.video` room type) |
| 1:1 calls | `m.call.*` events via matrix-js-sdk WebRTC |
| Threads | `m.thread` with `m.in_reply_to` fallback |
| Stickers | `m.sticker` |
| Pinned messages | `m.room.pinned_events` |
| Ignore users | `m.ignored_user_list` |

## Known limitations

Things that aren't done yet. See `missing-features.md` for more:

- Group / conference calls (MatrixRTC / Element Call) — only 1:1 calls today
- Screen sharing
- Location sharing
- Custom per-room emoji packs (MSC2545)
- QR-code device verification
- Widgets / Jitsi / integration manager
- i18n / localization (English only)
- Element-style labs panel for experimental features

## Contributing

This is a personal project but PRs are welcome. Keep the dependency graph small and match the existing glass aesthetic / motion-token system.

Before committing:
```bash
npm run build   # runs tsc --noEmit && vite build — must pass
```

## License

See `LICENSE` (if present). Matrix and `matrix-js-sdk` are licensed separately by their respective owners.
