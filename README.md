# LiveChat

A lightweight, auth-less prototype chat app built around one idea: **you see other people's messages as they type them** — character by character — instead of a generic "typing…" indicator. It also does **push-to-talk voice** like a walkie-talkie, with live streaming and auto-transcription.

No accounts, no database, no build step. Just enter a name and chat.

## Features

- **Live message previews** — drafts appear as a chat bubble and update keystroke-by-keystroke; on send they lock in place.
- **Push-to-talk voice** — hold the mic button (or **Space**) to talk. Others hear it streaming live (where supported), and the clip is saved to history as a slim, seekable player.
- **Voice-first layout** — a big centered record button over the thread (toggle under **profile → settings**).
- **Auto transcripts** — each voice clip is transcribed server-side via Azure AI Speech and shown under the bubble (optional; off if not configured).
- **Multiple channels** — anyone can create or delete them.
- **iMessage-style time separators**, **delete-your-own-message** (right-click / long-press), and **shareable channel URLs** that survive refresh.
- **Mobile-friendly** — iOS keyboard handling, safe-area insets, touch targets.

## Quick start

Requires **Node 18+**.

```bash
npm install
npm start
```

Open <http://localhost:3000>, enter a display name, and create a channel. To see the live previews, open a second browser (or a private window) as a different user.

## Optional: voice transcription

Transcription uses **Azure AI Speech** and is **off until configured** — voice clips still record and play without it. Provide a Speech resource key/region as environment variables before starting:

```powershell
# PowerShell
$env:AZURE_SPEECH_KEY="<your-key>"; $env:AZURE_SPEECH_REGION="eastus"; npm start
```
```bash
# bash
AZURE_SPEECH_KEY=<your-key> AZURE_SPEECH_REGION=eastus npm start
```

See [`.env.example`](.env.example) for all supported variables. (The app reads from the process environment directly — there's no `.env` auto-loader, so set them in your shell or App Service settings.)

## How it works

- **Backend:** Node + Express + [`ws`](https://github.com/websockets/ws). A single process relays WebSocket events and persists to flat files.
- **Frontend:** vanilla HTML/CSS/JS in [`public/`](public/) — no framework, no bundler.
- **Storage:** newline-delimited JSON per channel under `DATA_DIR` (default `./data`), with voice clips in `DATA_DIR/media/`. Survives restarts.

Full design details are in [ARCHITECTURE.md](ARCHITECTURE.md).

## Deployment

Designed for one-command deploy to **Azure App Service** using the persistent `/home` mount (no storage account needed). Step-by-step guide in [DEPLOY.md](DEPLOY.md).

A GitHub Actions pipeline ([`.github/workflows/ci-deploy.yml`](.github/workflows/ci-deploy.yml)) runs CI (syntax check + server smoke test) on every push and PR, and auto-deploys `main` to App Service once you've added the publish-profile secret — setup steps in [DEPLOY.md](DEPLOY.md#automated-deploys-github-actions).

## Project structure

```
server.js          # Express + WebSocket server (single entry point)
public/
  index.html       # App shell
  app.js           # All frontend logic
  style.css
data/               # Auto-created at runtime (gitignored)
PRD.md              # Product requirements
ARCHITECTURE.md     # Technical design
DEPLOY.md           # Azure deployment guide
```

## Known limitations

This is a prototype, by design:

- **iOS plays voice on release, not live.** iPhones record and post fine (others hear them live), but an iPhone *listener* hears incoming clips once they're sent, not streaming — Safari can't reliably stream-decode the audio. Other devices get true live playback.
- **"Delete your own message"** is matched by a client-supplied user ID — a UX guard, not real security (the app is intentionally auth-less).
- **Single instance only.** The in-memory relay + flat files don't scale horizontally; multiplying instances would need a pub/sub backplane and shared storage.

## License

[MIT](LICENSE)
