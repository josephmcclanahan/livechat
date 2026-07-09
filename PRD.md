# LiveChat — Product Requirements Document

## Overview

A lightweight, auth-less prototype chat application with a key differentiating feature: live message previews. Instead of showing a generic "typing..." indicator, all participants see the message being composed in real time, character by character. When sent, the message locks in like any normal chat.

---

## Goals

- Validate the live-preview chat UX concept quickly
- Keep friction to zero — no accounts, no passwords, no email
- Support multiple named channels with open participation

---

## Non-Goals

- Authentication or authorization
- Private/direct messages
- Message history persistence beyond prototype scale (no pagination, no archiving)
- Native mobile app (web app is responsive and works well on mobile browsers, but no native shell)

---

## User Flow

### 1. Entry Screen
- User navigates to the app
- Prompted to enter a display name
- Name is persisted locally (localStorage) so returning users skip this step
- No validation beyond "name must not be empty"

### 2. Main Layout
- After entering a name, the user lands in the main app shell: a left sidebar listing channels and a main content area
- The sidebar shows all channels with a `+ Add Channel` button at the bottom
- The main header shows the current channel name (or "Select a channel") and a profile badge with the user's initials
- On mobile (<600px) the sidebar collapses behind a hamburger and overlays the screen when opened
- Creating a channel: tap `+ Add Channel` — a dialog asks for the channel's settings (name + default mode), and the new channel opens immediately
- Channel settings: **name** and **default mode** — **Chat first** (message box up front, inline mic) or **Voice first** (big centered push-to-talk button). The mode picks which composer layout the channel opens in for everyone
- Editing a channel: tap the `✎` next to a channel name — the same settings dialog opens pre-filled; saving updates the name and default mode for everyone live (sidebar, room title, and composer layout if the mode changed)
- Deleting a channel: tap the `×` next to a channel name and confirm — broadcasts deletion to all clients

### 3. Chat Room (in main area)
- Selecting a channel loads its history and a message input at the bottom
- **Live preview bubbles**: other users' in-progress drafts appear as chat bubbles in the message thread, styled with a dashed border, blue tint, italic text, and a pulsing "live" badge next to the name
- Drafts are pinned to the bottom of the thread — newly arriving sent messages insert above any live bubbles
- Once a user sends, their draft bubble is replaced in-place by the committed message
- The user's own in-progress message stays in the input box only — never as a bubble on their own screen

---

## Key Feature: Live Message Preview

This is the core differentiator.

| Behavior | Detail |
|---|---|
| Trigger | Any keystroke in the message input broadcasts the current draft |
| Display | Draft renders inline in the message thread as a styled chat bubble with a pulsing "live" badge, pinned to the bottom |
| Updates | Near real-time (target <100ms latency on local network) |
| On send | Draft bubble is swapped in-place for the committed message |
| On clear/abandon | Draft bubble disappears when input is emptied, the user leaves the channel, or disconnects |

---

## Key Feature: Push-to-Talk Voice

A voice analog of the live text preview — a walkie-talkie inside each channel.

| Behavior | Detail |
|---|---|
| Gesture | Press-and-hold a mic button to talk; release to stop |
| Live while talking | Other participants hear the transmission streaming in near-real-time (~1–2s behind), not just after release |
| Full-duplex | Anyone can transmit at any time; simultaneous talkers stack as separate live bubbles and separate clips — no floor lock or "channel busy" state |
| Auto-playback | Incoming transmissions play automatically through the speaker — no tap-to-listen, like a real radio |
| Live indicator | While someone holds PTT, others see a "🔴 transmitting…" bubble (reuses the live-draft bubble mechanism) |
| On release | The completed clip is saved and replaces the live bubble in-place as a playable audio bubble |
| Persistence | Each transmission is stored as an audio file and replays from channel history on reload |
| Playback setting | A settings menu under the profile icon picks **Voice playback** mode (persisted in `localStorage`): **Live as spoken** (default — stream while talking), **Play when finished** (auto-play the whole clip on release, no live stream), or **Off** (never auto-play; tap clips to play from history). |
| Transcript | A text transcript shows under each clip. The **server** transcribes each saved clip via **Azure AI Speech** (in-tenant), then broadcasts the text so it appears under the bubble a moment after the clip posts — on every device, regardless of the recording browser. Disabled gracefully if the Speech resource isn't configured. |

**Graceful degradation**: true live-while-talking playback uses MediaSource Extensions (Chrome/Edge/Firefox, desktop + Android). On iOS Safari (no Opus/WebM recording, unreliable MSE-for-audio), the app still works as a radio — it shows the live indicator and **auto-plays the complete clip the instant the talker releases**. iOS records in `audio/mp4` so its clips save and play everywhere.

| Convenience | Detail |
|---|---|
| Space shortcut | Holding the **Space** bar (when not typing in a field) acts as push-to-talk, like holding the mic button. |
| Voice-first layout | Each channel has a **default mode** setting (chosen at creation, editable via the sidebar `✎`): **voice first** opens the channel with a big centered record button above the message box — walkie-talkie over the thread; **chat first** opens keyboard-forward. A **profile → settings** toggle overrides the layout live for the room you're in. |
| Custom player | Voice clips render with a minimal play/pause + seekable progress bar (no volume control — system volume governs); transcript sits inside the same bubble. |

---

## Additional Features

| Feature | Detail |
|---|---|
| Delete a message | Right-click (desktop) or long-press (touch) **your own** message → Delete. Removes it for everyone (and deletes the media file for voice clips). Soft ownership check by client `userId` — a UX guard, not security. |
| Time separators | iMessage-style headers appear between messages when a new cluster starts (first message, >15-min gap, or a new calendar day): "Today 12:30 PM", "Yesterday 8:00 AM", "Monday 5:12 PM", "Just now". |
| Shareable channel URLs | The active channel is reflected in the URL hash (`#<channelId>`); a refresh stays in the channel, and back/forward navigate between channels. |

---

## Technical Approach (Prototype)

- **Frontend**: Vanilla HTML/CSS/JS — no framework, no build step, served statically by the backend
- **Realtime transport**: WebSockets for live drafts, sent messages, and streamed voice chunks (base64 audio relayed through the server)
- **Backend**: Node.js + Express + `ws`
- **Persistence**:
  - Display name + user ID: `localStorage` (client-side)
  - Channel list: `${DATA_DIR}/channels.json` on disk
  - Message history: append-only NDJSON files, one per channel (`${DATA_DIR}/messages/<channel-id>.ndjson`) — survives server restarts
  - Voice clips: audio files in `${DATA_DIR}/media/`, referenced by URL from an `audio` row in the channel's NDJSON
  - Live drafts + in-flight voice chunks: in-memory only — ephemeral by nature, never persisted
- **`DATA_DIR` environment variable**: defaults to `./data` locally; set to `/home/data` for Azure App Service (uses the App Service `/home` mount for persistence — no storage account needed)

## Deployment

Designed for one-command deployment to Azure App Service (Linux, Node 18+). See [DEPLOY.md](DEPLOY.md) for the full guide.

```
az webapp up --runtime "NODE:22-lts"
```

Then set the app setting `DATA_DIR=/home/data` so data survives restarts and re-deploys. WebSockets must be enabled on the App Service (`az webapp config set --web-sockets-enabled true`).

## Mobile Considerations

Although mobile-native is out of scope, the web app is built to feel right on touch devices:
- Layout collapses to a hamburger-overlay sidebar below 600px
- iOS keyboard handling via `visualViewport` API — `#app` is dynamically sized so the keyboard doesn't push the header off screen
- Safe-area insets via `env(safe-area-inset-*)` for notched devices
- Hover styles wrapped in `@media (hover: hover)` so taps don't get "stuck" in a hover state
- 44px minimum touch targets on the channel delete button
- Delete affordance is always visible on touch devices (not hover-only)
- PTT mic button uses `touch-action: none` so press-and-hold drives recording without triggering scroll/zoom gestures
- Voice falls back to auto-play-on-release on iOS Safari where live streaming playback isn't supported
- Incoming clips auto-play through one gesture-unlocked audio element + a serial queue, so iOS plays them in order instead of blocking then flushing all at once
- Long-press on your own message opens the delete menu (touch equivalent of right-click)

---

## Out of Scope (v1 Prototype)

- User avatars
- Message editing
- Read receipts
- Push notifications
- Any form of moderation
- Real authentication/authorization (message deletion is a soft, client-asserted "your own" check, not enforced)
- A database (flat files are sufficient)

---

## Success Criteria

- A user can open the app, set their name, join a channel, and see another user's message appear live as they type it
- The experience feels noticeably different and more engaging than a standard typing indicator
- Setup requires no account creation on any participant's part
