# Deploying LiveChat to Azure App Service

LiveChat is a single Node.js process (Express + WebSocket) that stores everything as flat files. The simplest durable host is **Azure App Service on Linux**, using the built-in persistent `/home` mount for data — no database or storage account required.

This guide covers a first deployment and routine re-deploys.

---

## What you need

- An Azure subscription
- **Azure CLI** (`az`) — install from <https://learn.microsoft.com/cli/azure/install-azure-cli>
  - Verify: `az --version`
- Node.js 18+ locally (to test before pushing)

Sign in once:

```bash
az login
```

---

## One-time concepts

| Concept | LiveChat's choice | Why |
|---|---|---|
| OS | **Linux** | Cheaper, first-class Node support |
| Runtime | **Node 22 LTS** | Current Node LTS on App Service; satisfies the `>=18` `engines.node` in `package.json` |
| Persistence | **`/home/data`** | The `/home` mount is backed by Azure Files and survives restarts, scale operations, and re-deploys |
| WebSockets | **Enabled** | Live drafts + push-to-talk voice both require an upgraded WS connection |
| Build | **None** | No build step — Oryx just runs `npm install` and `npm start` |

> **Important — persistence:** App Service serves your code from `/home/site/wwwroot`, which is **overwritten on every deploy**. Anything written there is lost on the next push. LiveChat avoids this by writing all data under **`/home/data`** (outside `wwwroot`), set via the `DATA_DIR` app setting below. Never point `DATA_DIR` inside `wwwroot`.

---

## First deployment

From the project root (`c:\ClaudeCode\LiveChat`):

### 1. Create and deploy in one command

`az webapp up` provisions the resource group, App Service plan, and web app, then zip-deploys your code. Pick a **globally unique** app name.

```bash
az webapp up --name <your-unique-app-name> --runtime "NODE:22-lts" --sku B1 --os-type Linux
```

- `--sku B1` is the cheapest tier that keeps the app always-on. `F1` (free) also works for testing but sleeps when idle and has WebSocket limits.
- Note the resource group name it prints (e.g. `<your-app>_group`) — you'll reuse it below.

### 2. Point data at the persistent mount

```bash
az webapp config appsettings set \
  --name <your-unique-app-name> \
  --resource-group <your-app>_group \
  --settings DATA_DIR=/home/data
```

### 3. Enable WebSockets

```bash
az webapp config set \
  --name <your-unique-app-name> \
  --resource-group <your-app>_group \
  --web-sockets-enabled true
```

### 4. Restart so the settings take effect

```bash
az webapp restart --name <your-unique-app-name> --resource-group <your-app>_group
```

Your app is live at `https://<your-unique-app-name>.azurewebsites.net`.

> App Service terminates TLS for you, so the browser uses `https://` → the client automatically upgrades to `wss://` (see `connectWS` in `public/app.js`). Voice recording (`getUserMedia`) **requires HTTPS**, which you get for free on `*.azurewebsites.net`.

---

## Re-deploying after changes

From the project root, just run `az webapp up` again with the **same name** — it redeploys in place:

```bash
az webapp up --name <your-unique-app-name> --runtime "NODE:22-lts"
```

App settings (`DATA_DIR`, WebSockets) and everything under `/home/data` **persist across re-deploys** — your channels, message history, and voice clips are untouched.

---

## Optional: voice-clip transcription (Azure AI Speech)

Each voice clip can be auto-transcribed, with the text shown under the clip. This is **off** until you configure an Azure AI Speech resource — clips still post and play without it.

1. **Create a Speech resource** (`F0` = free tier, 5 audio hours/month; use `S0` for more):
   ```bash
   az cognitiveservices account create \
     --name livechat-speech --resource-group <your-app>_group \
     --kind SpeechServices --sku F0 --location eastus --yes
   ```
2. **Read the key** (region is the `--location` above):
   ```bash
   az cognitiveservices account keys list \
     --name livechat-speech --resource-group <your-app>_group --query key1 -o tsv
   ```
3. **Set the app settings**, then restart:
   ```bash
   az webapp config appsettings set -n <your-unique-app-name> -g <your-app>_group \
     --settings AZURE_SPEECH_KEY=<key> AZURE_SPEECH_REGION=eastus
   az webapp restart -n <your-unique-app-name> -g <your-app>_group
   ```
   (Optional: `AZURE_SPEECH_LOCALES=en-US,es-ES` to widen language auto-detect.)

Transcription runs **server-side**, so it works for clips recorded on any device/browser — including iOS — and stays inside your Azure tenant. Locally, set `AZURE_SPEECH_KEY` / `AZURE_SPEECH_REGION` in your shell before `npm start`.

---

## Verifying a deployment

1. Open `https://<your-unique-app-name>.azurewebsites.net` in two different browsers.
2. Set a name, create/join a channel, send a text message → it appears in both.
3. Type in one → the other sees the live draft bubble.
4. Hold the 🎙️ button and talk → the other hears it live (or auto-plays on release on iOS) and a clip bubble persists.
5. Reload → channels, messages, and voice clips are all still there (confirms `/home/data` persistence).
6. (If transcription configured) a transcript appears under each clip a second or two after it posts.

### Tail the logs

```bash
az webapp log tail --name <your-unique-app-name> --resource-group <your-app>_group
```

You should see `LiveChat running at http://localhost:<port>` (App Service injects `PORT`, which `server.js` already honors).

---

## Confirming data persistence directly (optional)

Open the SSH console to inspect the persistent mount:

```bash
az webapp ssh --name <your-unique-app-name> --resource-group <your-app>_group
```

Then inside the container:

```bash
ls -la /home/data            # channels.json, messages/, media/
cat /home/data/channels.json
ls /home/data/media          # saved voice clips (.webm / .mp4)
```

---

## Cost & cleanup

- **B1** is a low-cost basic tier billed hourly while it exists.
- To stop billing entirely, delete the resource group (removes the app, plan, and all data):

```bash
az group delete --name <your-app>_group --yes --no-wait
```

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Live drafts / voice never arrive | WebSockets disabled | Re-run step 3, then restart |
| Data resets on each deploy | `DATA_DIR` unset or inside `wwwroot` | Set `DATA_DIR=/home/data` (step 2) and restart |
| Mic button missing / recording fails | Page not served over HTTPS | Use the `https://` URL; `getUserMedia` is blocked on plain HTTP |
| App won't start | Node version mismatch | Ensure a supported runtime (`--runtime "NODE:22-lts"`, or `NODE:24-lts`); `package.json` requires Node ≥18. Check current options with `az webapp list-runtimes --os Linux` |
| `502`/app sleeps | Free `F1` tier idle timeout | Move to `B1`: `az appservice plan update --sku B1 ...` |
| Voice clips grow disk usage | Every transmission is stored under `/home/data/media` | Periodically prune old clips; no auto-cap in the prototype |

---

## Why not a storage account / database?

For a prototype, App Service's `/home` mount gives durable storage for free and keeps the architecture to a single process with flat files (see [ARCHITECTURE.md](ARCHITECTURE.md)). If LiveChat ever needs to **scale out to multiple instances**, the flat-file + in-memory-relay model breaks (each instance has its own `clients`/`drafts` maps and its own view of disk) — at that point you'd move messages/clips to Azure Blob Storage and add a pub/sub backplane (e.g. Azure Web PubSub or Redis) to fan WebSocket events across instances. That's explicitly out of scope for the prototype, which runs on a single instance.
