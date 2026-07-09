# LiveChat — Architecture

## File Structure

```
LiveChat/
  package.json
  server.js              # Express + WebSocket server (single entry point)
  public/
    index.html           # App shell
    app.js               # All frontend logic — views + WS client
    pcm-capture-worklet.js  # AudioWorklet: mic → 16 kHz Int16 PCM frames (live voice path)
    style.css
  ${DATA_DIR}/           # Auto-created at startup; defaults to ./data, /home/data on Azure
    channels.json        # Ordered list of channel objects
    messages/
      <channel-id>.ndjson  # One JSON object per line, append-only (text + audio rows)
    media/
      <clip-id>.webm|.mp4  # One audio file per completed PTT transmission
```

`DATA_DIR` is controlled by the `DATA_DIR` environment variable. Local default: `./data`. Azure App Service: set `DATA_DIR=/home/data` so data persists across restarts and re-deploys (the `/home` mount survives both).

**Environment variables**

| Var | Purpose |
|-----|---------|
| `DATA_DIR` | Data root (default `./data`; `/home/data` on Azure) |
| `PORT` | Listen port (App Service injects it) |
| `AZURE_SPEECH_KEY` | Azure AI Speech resource key — enables clip transcription |
| `AZURE_SPEECH_REGION` | Speech resource region, e.g. `eastus` |
| `AZURE_SPEECH_LOCALES` | Optional, default `en-US`; comma-separated candidate locales |

Transcription is **off** unless both `AZURE_SPEECH_KEY` and `AZURE_SPEECH_REGION` are set — clips still post and play, just without transcripts.

---

## Backend (`server.js`)

### In-Memory State

```js
// Active WebSocket connections. While a client holds PTT, its entry also carries an
// in-flight transmit buffer: { audioChunks: [Buffer], audioMime, audioStart }.
const clients = new Map()  // ws → { userId, name, channelId, audioChunks?, audioMime?, audioStart? }

// Live drafts currently being typed
const drafts = new Map()   // userId → { channelId, name, text }
```

Both are ephemeral — reset on server restart. Drafts and in-flight audio buffers are never persisted until a transmission completes (then the assembled clip is written to `media/`).

### REST API

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/channels` | Return full channel list |
| `POST` | `/api/channels` | Create channel `{ name, defaultMode }` → channel object; `defaultMode` is `'voice'` or `'chat'` (anything else → `'chat'`); broadcasts `channel_created` to all WS clients |
| `PATCH` | `/api/channels/:id` | Edit a channel's settings; accepts either/both of `{ name, defaultMode }` (omitted fields unchanged, blank name → 400); broadcasts `channel_updated` to all WS clients |
| `DELETE` | `/api/channels/:id` | Remove channel from list, delete its NDJSON file, broadcast `channel_deleted` to all WS clients |
| `GET` | `/api/channels/:id/messages` | Return last 200 messages from NDJSON file |

### WebSocket Protocol

**Client → Server**

| `type` | Payload | Effect |
|--------|---------|--------|
| `identify` | `{ userId, name }` | Register the connection in `clients` |
| `join` | `{ channelId }` | Set client's active channel; flush current drafts for that channel to them |
| `leave` | — | Clear client's channel; broadcast empty draft to clear their row for others |
| `draft` | `{ text }` | Update `drafts` map; broadcast `draft_update` to channel (excluding sender) |
| `send` | `{ text }` | Append message to NDJSON; broadcast `message` to channel; clear draft |
| `ptt_start` | `{ mime, live, rate }` | Begin a voice transmission; init transmit buffer; broadcast `ptt_start` to channel (excluding sender). `live`/`rate` advertise the talker's PCM stream (absent if the browser lacks AudioWorklet) |
| `ptt_chunk` | `{ data }` | Base64 **archive** chunk (MediaRecorder output); append to the transmit buffer only — never relayed |
| `ptt_end` | — | Assemble buffer → write `media/<id>.<ext>`; append `audio` row; broadcast `message`; kick off async `transcribeClip` |
| *(binary frame)* | `[0x01][Int16 PCM]` | Live audio frame (mono, `rate` Hz, ~60 ms). Relayed to the channel with the sender's userId spliced in; never parsed or persisted. Dropped unless a transmission is open; capped at 32 KB |
| `delete_message` | `{ id }` | Delete that message **only if it belongs to the sender** (`removeOwnMessage`); rewrites the channel NDJSON without it (+ its transcript row), unlinks the media file, broadcasts `message_deleted` |

**Server → Client**

| `type` | Payload | When |
|--------|---------|------|
| `draft_update` | `{ userId, name, text }` | On every `draft`; `text: ""` signals removal |
| `message` | `{ message: { id, userId, name, text, timestamp } }` or `{ message: { id, type:'audio', userId, name, url, mime, duration, timestamp } }` | When a text message is sent or a voice clip is committed |
| `channel_created` | `{ channel: { id, name, defaultMode, createdAt } }` | When any client creates a channel |
| `channel_updated` | `{ channel: { id, name, defaultMode, createdAt } }` | When any client edits a channel's settings |
| `channel_deleted` | `{ channelId }` | When any client deletes a channel |
| `ptt_start` | `{ userId, name, mime, live, rate }` | Another user began transmitting — show live bubble; if `live`, open a jitter-buffered Web Audio stream at `rate` Hz |
| *(binary frame)* | `[0x01][uidLen:u8][uid utf8][Int16 PCM]` | Live PCM frame relayed from a transmitter — decode the uid header, schedule the samples into that talker's stream |
| `ptt_cancel` | `{ userId }` | Transmitter left/disconnected mid-clip, or the recording captured no audio — tear down live bubble + playback, no commit coming |
| `transcript` | `{ id, text }` | A clip's transcript (from server-side Azure AI Speech) — patch it under the matching `#msg-<id>` bubble |
| `message_deleted` | `{ id }` | Remove the `#msg-<id>` bubble for everyone |

Live audio rides as raw binary WebSocket frames — no base64 (~33% smaller, no main-thread encode), no container, and the server treats the payload as opaque bytes. The uid header the server splices in makes each frame self-describing, so simultaneous talkers demux trivially. Archive chunks stay as base64-in-JSON since they're upload-only and low-rate. Full-duplex: no floor lock, anyone can transmit anytime. The `/media` directory is served statically (`app.use('/media', express.static(MEDIA_DIR))`).

### Disk Persistence

```
data/channels.json          → JSON array, read/written atomically with fs.writeFileSync
data/messages/<id>.ndjson   → append-only, one JSON line per message via fs.appendFileSync
data/media/<id>.webm|.mp4   → one audio file per completed transmission via fs.writeFileSync
```

On startup, `data/`, `data/messages/`, and `data/media/` are created if missing. `channels.json` is initialized to `[]` if absent.

Reading history: split file on `\n`, parse non-empty lines, return last 200.

---

## Frontend (`public/app.js`)

Single file, no framework. Manages one `div#app` root. Boots into either the entry screen or directly into the main layout if `userName` is already in localStorage.

### Session State (module-level variables)

```js
let userId           // uuid stored in localStorage
let userName         // display name stored in localStorage
let ws               // single WebSocket instance for the session
let currentChannelId // id of the channel the user is currently viewing (null if none)
let channels         // local cache of channel list
let playbackMode     // voice playback: 'full' | 'onfinish' | 'off' (localStorage, default 'full')
let voiceFirst       // composer layout for the open room — seeded from the channel's defaultMode
let currentChannelName // name of the active channel (for re-rendering the composer)
let lastMsgTs        // timestamp of the last rendered message (for time separators)
```

### Layout & Views

**`renderEntry()`**
- Shown when `userName` is absent
- Form: name input + submit button
- On submit: save name to localStorage, `connectWS(renderLayout)`

**`renderLayout()`** — called once after a successful identify
- Renders the persistent shell: sidebar (channel list + Add Channel) and main area
- Main area starts in `.welcome-state` (prompt to pick a channel)
- Fetches `/api/channels` once and populates the sidebar
- Sidebar opens/closes via hamburger on narrow screens
- `+ Add Channel` button → a modal dialog (`openChannelModal()`) collects the channel's settings (name + default mode: chat first / voice first) → `POST /api/channels` → opens new channel immediately (the creator adds the channel from the POST response; `onChannelCreated` dedupes against the WS broadcast)
- The dialog mounts **inside `#app`** (absolute overlay) rather than on `document.body`, so it lives in the visualViewport-sized container: when the mobile keyboard opens, it re-centers in the visible area instead of leaving its Save/Cancel row under the keyboard (with iOS rendering a detached input caret over other content). Only the **create** path auto-focuses the name field (it's empty and required); edit doesn't, so the keyboard stays closed. A failed save keeps the dialog open and shows the error as a toast (toast z-index sits above the overlay)
- Each channel row also has a `✎` edit button → the same dialog pre-filled (`openChannelModal(channel)`) → `PATCH /api/channels/:id`. `onChannelUpdated` (PATCH response + `channel_updated` broadcast, idempotent) mutates the cached channel object **in place** so the sidebar's closures stay fresh, relabels the sidebar row, and — if you're in that room — updates the title, re-seeds the layout when the default mode changed, and re-renders the composer (preserving any in-progress draft)
- Each channel row has a `×` delete button → `DELETE /api/channels/:id` (with `confirm()`)

**`openRoom(channelId, channelName)`**
- Updates only the main content area (sidebar stays mounted)
- On enter: sends `leave` for the previous channel if any, then `join` for the new one; `GET /api/channels/:id/messages` to load history
- Renders: scrollable `.history` div + the composer (`composerMarkup` → `wireComposer`)
- Seeds `voiceFirst` from the channel's `defaultMode` setting (`'voice'` → voice-first composer; missing/`'chat'` → keyboard-forward) and syncs the profile-menu toggle to match
- Sets the URL hash to `#<channelId>` so a refresh stays in the channel; resets `lastMsgTs` so the next message gets a time header

**Composer (`composerMarkup` / `wireComposer` / `renderComposer`)**
- Two layouts chosen by `voiceFirst`: normal inline (`[input] [🎙️] [Send]`), or **voice-first** (a big centered record button above the message box). `voiceFirst` starts from the channel's `defaultMode` on room open; the profile-menu toggle overrides it live for the current room (not persisted). `wireComposer` attaches the draft/submit/PTT listeners for either; `renderComposer` swaps the layout live when the toggle changes.
- Input `input` event → `draft` WS message; submit → `send` + clear + empty `draft`.

**URL routing** — `openRoom` writes `location.hash`; on boot the hash selects the initial channel; a `hashchange` listener handles back/forward and manual edits; deleting the current channel clears the hash.

### Message & Draft Rendering

Drafts are rendered as chat bubbles **in** the history container — not a separate pane.

- `updateDraft({ userId, name, text })`:
  - Skipped if `userId === local userId` (you don't see your own draft as a bubble)
  - Creates or updates a `<div class="message theirs draft-bubble" id="draft-${userId}">` with the "live" badge
  - Appends to the bottom of `.history`, scrolls into view
  - If `text === ""`, removes the bubble
- `appendMessage(msg, { scroll, live })`:
  - Gives the bubble `id="msg-<id>"` + `data-userId` (+ `own` class) so the delete menu and transcript/delete events can target it
  - Branches on `msg.type === 'audio'` → renders a **custom audio player** bubble (`setupAudioPlayer`): play/pause + seekable progress bar over a hidden `<audio>`, **no volume control** (system volume governs); transcript sits inside the same bubble. Auto-plays via the shared queue only when `live && !isMine` and not already heard streaming. Otherwise a text bubble.
  - Calls `timeHeaderFor(msg)` and inserts an iMessage-style `.time-header` above the bubble when a new time cluster starts
  - If the sender had a draft/transmitting bubble, swaps it in-place via `replaceChild`; otherwise `insertBefore` the first `.draft-bubble` (keeps drafts pinned to the bottom), else appends
- `setupAudioPlayer(div, msgDuration)` — wires the custom player. WebM from `MediaRecorder` often lacks a duration header (`audio.duration` is `Infinity`), so it falls back to the server's measured `duration` and "primes" the real duration via a seek-to-end (so the progress bar moves from the first play and seeking is exact).
- `timeHeaderFor(msg)` — returns a `.time-header` element (and advances `lastMsgTs`) when a message opens a new cluster: first message, **>15-min gap**, or a new calendar day. `formatTimeHeader` yields "Just now" / "Today 12:30 PM" / "Yesterday 8:00 AM" / "Monday 5:12 PM" / "Mar 29" via `toLocale*` (locale-aware).

### Push-to-Talk (voice)

Recording support is probed once at load (`pttMime` via `MediaRecorder.isTypeSupported`, preferring `audio/webm;codecs=opus`, falling back to `audio/mp4`); the PTT button hides entirely if unsupported.

Voice runs as **two pipelines off one mic stream** — the live stream and the durable clip have opposite container requirements (timestamped fragments vs. a seekable index), and making one MediaRecorder output serve both is what used to keep iOS out of live mode:

- **Live path (worklet PCM)** — an `AudioWorklet` (`pcm-capture-worklet.js`) resamples mic audio to **mono 16 kHz Int16 PCM** and posts 60 ms frames, which go out as **binary WS frames**. Raw PCM needs no container or codec, so the same code runs on every browser — **iOS transmits and hears live audio like everything else**. ~32 KB/s upstream per talker.
- **Archive path (MediaRecorder)** — unchanged in role: produces the compressed clip for history, seeking, and transcription. WebM uploads progressively via 250 ms timeslice; MP4 (iOS) is only valid as one complete blob (its sample index is written at the end), so it records in one piece and uploads on stop. Archive chunks are upload-only — the server no longer relays them.
- **Transmit** — `startTransmit()` gets a **fresh** mic stream each hold, builds the live pipeline (`startLiveTx`), sends `ptt_start { mime, live, rate }`, starts the archive recorder, and connects mic → worklet → (muted) destination. Worklet frames are tagged `0x01` and sent as binary. A promise chain (`chunkChain`) still serializes archive-chunk encodes so `ptt_end` (from `recorder.onstop`) always follows the final chunk. On stop, `releaseMic()` tears down the worklet graph and stops the tracks — iOS otherwise keeps the mic hot (ducking/blocking incoming playback, Dynamic Island stays lit) and a cached track can silently die and record a 0 s clip. An empty recording sends `ptt_end` with no chunks; the server replies `ptt_cancel` to clear listeners' bubbles, and the transmitter sees a "Couldn't record" toast.
- **One context for everything** — capture runs on the **same shared `AudioContext`** as playback, never its own. A second context with no real output demand can receive render callbacks faster than the mic delivers samples; the media-stream source pads the gaps with silence and listeners hear chopped audio (shipped once: ~1.7× frame inflation, choppy on every platform).
- **Self-calibrating capture rate** — the worklet's resample step assumes mic samples arrive at the context's rate, which breaks on iOS: the hardware rate changes when the mic session starts (e.g. 48 kHz → 24 kHz on some routes) while the context's rate stays locked at creation — listeners hear wrong-speed, underrun-choppy audio. Don't model this (rebuilding the context mid-hold corrupts MediaRecorder's clip; a fresh capture-only context free-runs and chops audio — both shipped, both reverted). Instead the main thread **measures** emitted-audio-seconds against the wall clock ~0.6 s into each hold and posts a `stepScale` correction to the worklet when the ratio drifts past ±15%. The learned scale (`txStepScale`, visible on `__lc`) persists across holds, so only the first hold on a new route drifts briefly.
- **Receive (live)** — `rxAudio` is a `Map<userId, rx>`; on a `ptt_start` with `live`, `startRx` creates a per-talker `GainNode` in the shared `AudioContext`. Each binary frame is demuxed by its uid header, converted to an `AudioBuffer`, and **scheduled back-to-back on the AudioContext clock** (`nextTime`). Simultaneous talkers each get their own node — full-duplex with zero extra coordination.
- **Silent "keeper" element** — iOS mutes Web Audio output with the ring/silent switch *unless* the page's audio session is in playback mode, which any playing media element provides (symptom: live audio silent until some clip played through an `<audio>` element, then fine). A silent, looping keeper `<audio>` (a runtime-generated 1 s WAV) starts on the first gesture and holds the session open, so rx audio plays straight from `ctx.destination`. Don't route the live mix through a media element via `MediaStreamAudioDestinationNode` instead — the element buffering degrades quality and WebKit glitch-loops the last chunk when the live stream stalls between transmissions. `keepSessionAlive()` re-kicks the keeper on every gesture and incoming transmission, since iOS pauses it across audio-session interruptions (e.g. after recording).
- **Jitter buffer (smoothness ↔ snappiness)** — playback starts once `rxLead` (150 ms floor) of audio is pre-buffered. On underrun mid-stream, playback resumes just ahead of "now" and `rxLead` grows ×1.5 (capped at 500 ms); each healthy new transmission decays it ×0.9 back toward the floor. Debug counters live on `window.__lc` (`framesSent` / `framesHeard` / `underruns`).
- **Receive (fallback)** — if the talker advertised no live stream (no AudioWorklet) or the listener lacks Web Audio, the committed clip **auto-plays on release** instead — same behavior every browser had before, now only a fallback. A committed clip whose codec the device can't decode shows a "can't be played on this device" fallback instead of a broken player.
- **Audio unlock + serial queue** — iOS only permits audio from a recent user gesture and blocks/queues a fresh `<audio>` each time (symptom: first clip plays, later ones don't, then all flush at once on the next gesture). So auto-play routes through **one persistent `player` element**, unlocked on the first `pointerdown`/PTT hold (`unlockAudio()` plays a silent clip on it — and also creates/resumes the shared `AudioContext` and starts the `liveOut` element while the gesture is live), and a FIFO `playQueue` (`enqueuePlay`/`playNext`) plays clips one-at-a-time. The per-bubble hidden `<audio>` (driven by `setupAudioPlayer`) is still there for manual replay.
- **Space-to-talk** — `setupSpacePtt()` makes holding the **Space** bar push-to-talk (when not typing in a field and in a channel), routing to the same `startTransmit`/`stopTransmit`.
- **Transcript** — server-side (see `transcribeClip` in `server.js`). After a clip commits, the server POSTs the saved file to Azure AI Speech "fast transcription"; on success it appends a `transcript` row and broadcasts `transcript`. The client's `onTranscript` patches the text into `#msg-<id> .audio-transcript` (with a brief retry in case it beats the bubble). No client speech code — works on every browser/device, in-tenant.
- **Live indicator** — `ptt_start` renders a `draft-${userId}` "🔴 transmitting…" bubble reusing the exact draft-bubble mechanism; the committed `audio` message swaps it in-place via the existing `replaceChild` path.
- **Cleanup** — `finishRx` flushes any still-pre-buffering frames (clips shorter than the jitter lead), lets the scheduled tail play out, then disconnects the talker's gain node; `ptt_cancel` (transmitter left mid-clip) disconnects it immediately and removes the bubble.
- **Playback mode setting** — the profile menu (`setupProfileMenu`) sets `playbackMode` (persisted in `localStorage`, default `'full'`):
  - `'full'` → `startRx` opens a live stream (when the talker advertises one); commit doesn't re-play. A stream that never delivered a frame falls back to auto-play on commit.
  - `'onfinish'` → `startRx` returns early (no live stream); the committed clip auto-plays on release.
  - `'off'` → no live stream and no auto-play; clips are tap-to-play from history.
  Switching to a non-`'full'` mode tears down any active `rxAudio` contexts. The "🔴 transmitting…" indicator shows in all modes.

### WebSocket Client

```js
function connectWS(onOpen) {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws'
  ws = new WebSocket(`${proto}://${location.host}`)
  ws.binaryType = 'arraybuffer'
  ws.onmessage = e => e.data instanceof ArrayBuffer
    ? onLiveFrame(e.data)                 // binary = live PCM frame from a talker
    : handleMessage(JSON.parse(e.data))
  ws.onopen = () => {
    ws.send(JSON.stringify({ type: 'identify', userId, name: userName }))
    if (onOpen) onOpen()
  }
  ws.onclose = () => setTimeout(() => connectWS(), 2000)  // simple reconnect
}

function handleMessage(msg) {
  switch (msg.type) {
    case 'draft_update':    // updateDraft()
    case 'message':         // appendMessage(msg.message, { live: true })
    case 'channel_created': // add to sidebar
    case 'channel_deleted': // remove from sidebar; show "deleted" state if viewing it
    case 'ptt_start':       // show transmitting bubble + open jitter-buffered live playback
    case 'ptt_cancel':      // tear down live bubble + playback (transmitter left)
    case 'transcript':      // onTranscript() — patch text into the clip bubble
    case 'message_deleted': // onMessageDeleted() — remove the bubble
  }
}
```

### Deleting messages

`setupMessageMenu()` (one document-level handler) opens a small Delete menu on **right-click** (desktop) or **long-press** (touch) — but only over a message whose `data-userId` matches the local `userId`. Choosing Delete sends `delete_message { id }`; the server's `removeOwnMessage` re-checks ownership, rewrites the NDJSON without the message (and its transcript row), unlinks any media file, and broadcasts `message_deleted`. On touch, own messages get `-webkit-touch-callout: none` so the long-press doesn't trigger the iOS selection callout.

### iOS Keyboard Handling

`setupViewport()` runs at boot and listens to `visualViewport.resize` / `scroll`:
- Sets `#app` height to `visualViewport.height` (shrinks when keyboard opens)
- Calls `window.scrollTo(0, 0)` to counteract iOS scrolling the page when an input focuses
- `#app` is `position: fixed` so window scrolling can't displace the shell

The combination keeps the header anchored at the top while the input + history compress upward as the keyboard opens.

---

## Data Formats

**`data/channels.json`**
```json
[
  { "id": "f3a1b2c4", "name": "general", "defaultMode": "chat", "createdAt": "2026-03-29T12:00:00.000Z" }
]
```

**`data/messages/<id>.ndjson`** (one object per line; text and audio rows interleave)
```
{"id":"m1","userId":"u1","name":"Alice","text":"hello","timestamp":"2026-03-29T12:01:00.000Z"}
{"id":"m2","userId":"u2","name":"Bob","text":"hey!","timestamp":"2026-03-29T12:01:05.000Z"}
{"id":"ab12cd34","type":"audio","userId":"u2","name":"Bob","url":"/media/ab12cd34.webm","mime":"audio/webm;codecs=opus","duration":4.2,"timestamp":"2026-03-29T12:01:10.000Z"}
{"type":"transcript","forId":"ab12cd34","text":"hey are we still on for noon"}
```

Text rows have no `type` (implicitly `text`); audio rows carry `type:"audio"` + `url`/`mime`/`duration`. A clip's transcript (from server-side Azure AI Speech) is a separate append-only `type:"transcript"` row (`forId` → the audio `id`); `readMessages` merges it onto the audio message as `transcript` and omits the standalone row. `userId` values are `crypto.randomUUID()` generated once client-side and persisted in localStorage.

---

## Key Behaviors

- **Own draft not shown** — user sees their own input in the text box, never as a bubble on their own screen
- **Draft cleared on send** — server broadcasts `draft_update` with `text: ""` after broadcasting the message
- **Draft cleared on leave** — server broadcasts empty draft when client disconnects or sends `leave`
- **Draft bubbles update in-place** — DOM elements are keyed by `userId` to avoid flicker
- **Drafts stay at the bottom** — newly arriving sent messages insert *before* live bubbles so drafts always sit at the end of the thread
- **Sent message replaces sender's draft in-place** — no visual jump when your own message commits
- **Channel deletion is collaborative** — anyone can delete; broadcast to all clients; if you were viewing it, the room is replaced with a "That channel was deleted." message
- **History loads once on room enter** — subsequent messages appended via WS events only
- **Voice is full-duplex** — no floor lock; simultaneous talkers each get their own live bubble + decode context
- **Voice degrades gracefully** — live PCM streaming wherever Web Audio exists (every modern browser, iOS included); auto-play-on-release fallback if the talker or listener can't do the live path
- **Voice clips persist like text** — committed transmissions are `audio` rows in the same NDJSON and replay from `/media` on reload
- **Transcripts are server-side** — the server transcribes each saved clip via Azure AI Speech and broadcasts the text; works on every device/browser, in-tenant; no-op if `AZURE_SPEECH_KEY`/`REGION` aren't set
- **iOS auto-play is serialized** — incoming clips play through one gesture-unlocked element via a FIFO queue, so they play in order instead of being blocked then flushed all at once
- **Delete is owner-only (soft)** — right-click/long-press your own message → `delete_message`; the server enforces a `userId` match before removing it and the media file, then broadcasts `message_deleted`. Client-asserted identity, so it's a UX guard, not security.
- **Time separators are client-side** — `appendMessage` inserts an iMessage-style header when a message opens a new cluster (first, >15-min gap, or new day); computed at render time, not live-updating.
- **Channel is in the URL** — the active channel lives in `location.hash`, so refresh stays put and channels are link-shareable; back/forward navigate.
- **Reconnect re-identifies but does not re-join** — after a dropped WS connection, `identify` is re-sent on `onopen`, but the user must switch channels (or stay in their current channel — the local `currentChannelId` is preserved but the server-side `client.channelId` is reset) to resume receiving drafts. Known limitation, acceptable for prototype scope.
