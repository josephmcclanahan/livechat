const express = require('express');
const { WebSocketServer } = require('ws');
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// --- Data directory setup ---
// Locally defaults to ./data. On App Service set DATA_DIR=/home/data
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const CHANNELS_FILE = path.join(DATA_DIR, 'channels.json');
const MESSAGES_DIR = path.join(DATA_DIR, 'messages');
const MEDIA_DIR = path.join(DATA_DIR, 'media');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(MESSAGES_DIR)) fs.mkdirSync(MESSAGES_DIR);
if (!fs.existsSync(MEDIA_DIR)) fs.mkdirSync(MEDIA_DIR);
if (!fs.existsSync(CHANNELS_FILE)) fs.writeFileSync(CHANNELS_FILE, '[]');

// --- In-memory state ---
let channels = JSON.parse(fs.readFileSync(CHANNELS_FILE, 'utf8'));
const clients = new Map();  // ws → { userId, name, channelId }
const drafts = new Map();   // userId → { channelId, name, text }

// --- Persistence helpers ---
function saveChannels() {
  fs.writeFileSync(CHANNELS_FILE, JSON.stringify(channels, null, 2));
}

function appendMessage(channelId, msg) {
  const file = path.join(MESSAGES_DIR, `${channelId}.ndjson`);
  fs.appendFileSync(file, JSON.stringify(msg) + '\n');
}

function readMessages(channelId, limit = 200) {
  const file = path.join(MESSAGES_DIR, `${channelId}.ndjson`);
  if (!fs.existsSync(file)) return [];
  const rows = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
  // Transcripts are their own append-only rows; merge them onto their audio message by id.
  const transcripts = {};
  for (const r of rows) if (r.type === 'transcript') transcripts[r.forId] = r.text;
  return rows
    .filter(r => r.type !== 'transcript')
    .slice(-limit)
    .map(r => (transcripts[r.id] ? { ...r, transcript: transcripts[r.id] } : r));
}

function extForMime(mime) {
  return (mime || '').includes('mp4') ? 'mp4' : 'webm';
}

// Delete a message, but only if it belongs to userId. Rewrites the channel's NDJSON without that
// message (and its transcript row), and removes the media file for a voice clip. Returns the
// removed message, or null if it wasn't found / wasn't theirs.
function removeOwnMessage(channelId, id, userId) {
  const file = path.join(MESSAGES_DIR, `${channelId}.ndjson`);
  if (!id || !fs.existsSync(file)) return null;
  const rows = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
  const target = rows.find(r => r.type !== 'transcript' && r.id === id);
  if (!target || target.userId !== userId) return null;
  const kept = rows.filter(r => r.id !== id && !(r.type === 'transcript' && r.forId === id));
  fs.writeFileSync(file, kept.length ? kept.map(r => JSON.stringify(r)).join('\n') + '\n' : '');
  if (target.type === 'audio' && target.url) {
    const f = path.join(MEDIA_DIR, path.basename(target.url));
    try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch {}
  }
  return target;
}

// --- Transcription (Azure AI Speech "fast transcription" REST) ---
// No-op unless AZURE_SPEECH_KEY + AZURE_SPEECH_REGION are configured. Runs async after a clip
// commits: on success it appends a `transcript` row and broadcasts `transcript` (the same path the
// history merge + client renderer already understand), so the clip posts instantly and the text
// fills in a moment later — on every device, regardless of the recording browser.
const SPEECH_KEY = process.env.AZURE_SPEECH_KEY;
const SPEECH_REGION = process.env.AZURE_SPEECH_REGION;
const SPEECH_LOCALES = (process.env.AZURE_SPEECH_LOCALES || 'en-US').split(',').map(s => s.trim());

async function transcribeClip(channelId, id, filePath) {
  if (!SPEECH_KEY || !SPEECH_REGION) {
    console.warn(`[transcribe] skipped ${id}: AZURE_SPEECH_KEY/REGION not set in this process`);
    return;
  }
  try {
    console.info(`[transcribe] requesting ${id} (${path.basename(filePath)})`);
    const url = `https://${SPEECH_REGION}.api.cognitive.microsoft.com/speechtotext/transcriptions:transcribe?api-version=2024-11-15`;
    const audio = fs.readFileSync(filePath);
    const form = new FormData();
    form.append('audio', new Blob([audio]), path.basename(filePath));
    form.append('definition', JSON.stringify({ locales: SPEECH_LOCALES }));
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Ocp-Apim-Subscription-Key': SPEECH_KEY },
      body: form
    });
    if (!res.ok) {
      console.warn('[transcribe] HTTP', res.status, (await res.text()).slice(0, 400));
      return;
    }
    const data = await res.json();
    const text = (data.combinedPhrases?.map(p => p.text).join(' ') || '').trim();
    console.info(`[transcribe] done ${id}: "${text.slice(0, 80)}"`);
    if (!text) return;
    appendMessage(channelId, { type: 'transcript', forId: id, text });
    broadcastToChannel(channelId, { type: 'transcript', id, text });
  } catch (err) {
    console.warn('[transcribe] failed:', err.message);
  }
}

// --- Broadcast helpers ---
function send(ws, msg) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

function broadcastToChannel(channelId, msg, excludeWs = null) {
  for (const [ws, client] of clients) {
    if (client.channelId === channelId && ws !== excludeWs) send(ws, msg);
  }
}

function broadcastToAll(msg) {
  for (const ws of clients.keys()) send(ws, msg);
}

// Upper bound on a live PCM frame; anything bigger is malformed or abusive.
const MAX_LIVE_FRAME = 32 * 1024;

function broadcastBinaryToChannel(channelId, buf, excludeWs = null) {
  for (const [ws, client] of clients) {
    if (client.channelId === channelId && ws !== excludeWs && ws.readyState === ws.OPEN) ws.send(buf);
  }
}

// --- REST API ---
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/media', express.static(MEDIA_DIR));

app.get('/api/channels', (req, res) => {
  res.json(channels);
});

app.post('/api/channels', (req, res) => {
  const name = (req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Name required' });
  // Channel setting: which composer layout the channel opens in — 'voice' (big push-to-talk
  // button) or 'chat' (keyboard-forward). Anything unexpected falls back to 'chat'.
  const defaultMode = req.body.defaultMode === 'voice' ? 'voice' : 'chat';
  const channel = { id: crypto.randomUUID().slice(0, 8), name, defaultMode, createdAt: new Date().toISOString() };
  channels.push(channel);
  saveChannels();
  broadcastToAll({ type: 'channel_created', channel });
  res.json(channel);
});

// Edit a channel's settings after creation. Accepts either or both of { name, defaultMode };
// omitted fields keep their current value.
app.patch('/api/channels/:id', (req, res) => {
  const channel = channels.find(c => c.id === req.params.id);
  if (!channel) return res.status(404).json({ error: 'Not found' });
  if (req.body.name !== undefined) {
    const name = String(req.body.name || '').trim();
    if (!name) return res.status(400).json({ error: 'Name required' });
    channel.name = name;
  }
  if (req.body.defaultMode !== undefined) {
    channel.defaultMode = req.body.defaultMode === 'voice' ? 'voice' : 'chat';
  }
  saveChannels();
  broadcastToAll({ type: 'channel_updated', channel });
  res.json(channel);
});

app.delete('/api/channels/:id', (req, res) => {
  const idx = channels.findIndex(c => c.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  channels.splice(idx, 1);
  saveChannels();
  const msgFile = path.join(MESSAGES_DIR, `${req.params.id}.ndjson`);
  if (fs.existsSync(msgFile)) fs.unlinkSync(msgFile);
  broadcastToAll({ type: 'channel_deleted', channelId: req.params.id });
  res.json({ ok: true });
});

app.get('/api/channels/:id/messages', (req, res) => {
  res.json(readMessages(req.params.id));
});

// --- Voice QoS ---
// Talker and each live listener POST a per-transmission report keyed by txId; rows for
// one txId correlate the capture experience with every playback experience of the same
// voice message. Surfaced in the client via the "Show voice QoS" setting.
const QOS_FILE = path.join(DATA_DIR, 'qos.ndjson');

app.post('/api/qos', (req, res) => {
  const r = req.body;
  if (!r || typeof r.txId !== 'string' || !/^[\w-]{1,32}$/.test(r.txId) ||
      (r.role !== 'tx' && r.role !== 'rx')) {
    return res.status(400).json({ error: 'Bad report' });
  }
  const line = JSON.stringify({ ts: new Date().toISOString(), ...r });
  if (line.length > 8192) return res.status(413).json({ error: 'Report too large' });
  fs.appendFileSync(QOS_FILE, line + '\n');
  res.json({ ok: true });
});

app.get('/api/qos/:txId', (req, res) => {
  if (!/^[\w-]{1,32}$/.test(req.params.txId) || !fs.existsSync(QOS_FILE)) return res.json([]);
  const rows = fs.readFileSync(QOS_FILE, 'utf8').split('\n').filter(Boolean)
    .map(l => { try { return JSON.parse(l); } catch { return null; } })
    .filter(r => r && r.txId === req.params.txId);
  res.json(rows);
});

// --- WebSocket ---
wss.on('connection', (ws) => {
  clients.set(ws, { userId: null, name: null, channelId: null });

  ws.on('message', (data, isBinary) => {
    const client = clients.get(ws);

    // Binary frames are live PCM audio from a talker: [0x01][Int16 PCM]. Relay to the
    // channel with the sender's userId spliced in — never parsed, never persisted (the
    // durable clip arrives separately as ptt_chunk uploads).
    if (isBinary) {
      if (!client || !client.userId || !client.channelId || !client.audioChunks) return;
      if (data.length < 2 || data.length > MAX_LIVE_FRAME || data[0] !== 0x01) return;
      const uid = Buffer.from(client.userId, 'utf8');
      if (uid.length > 255) return;
      const relay = Buffer.concat([Buffer.from([0x01, uid.length]), uid, data.subarray(1)]);
      broadcastBinaryToChannel(client.channelId, relay, ws);
      return;
    }

    let msg;
    try { msg = JSON.parse(data); } catch { return; }

    switch (msg.type) {
      case 'identify': {
        client.userId = msg.userId;
        client.name = msg.name;
        break;
      }
      case 'join': {
        client.channelId = msg.channelId;
        for (const [userId, draft] of drafts) {
          if (draft.channelId === msg.channelId) {
            send(ws, { type: 'draft_update', userId, name: draft.name, text: draft.text });
          }
        }
        break;
      }
      case 'leave': {
        if (client.userId && client.channelId) {
          drafts.delete(client.userId);
          broadcastToChannel(client.channelId, { type: 'draft_update', userId: client.userId, name: client.name, text: '' });
          if (client.audioChunks) {
            broadcastToChannel(client.channelId, { type: 'ptt_cancel', userId: client.userId });
            client.audioChunks = null;
          }
        }
        client.channelId = null;
        break;
      }
      case 'draft': {
        if (!client.userId || !client.channelId) break;
        if (msg.text === '') {
          drafts.delete(client.userId);
        } else {
          drafts.set(client.userId, { channelId: client.channelId, name: client.name, text: msg.text });
        }
        broadcastToChannel(client.channelId, { type: 'draft_update', userId: client.userId, name: client.name, text: msg.text }, ws);
        break;
      }
      case 'send': {
        if (!client.userId || !client.channelId) break;
        const text = (msg.text || '').trim();
        if (!text) break;
        const message = {
          id: crypto.randomUUID().slice(0, 8),
          userId: client.userId,
          name: client.name,
          text,
          timestamp: new Date().toISOString()
        };
        appendMessage(client.channelId, message);
        drafts.delete(client.userId);
        broadcastToChannel(client.channelId, { type: 'message', message });
        broadcastToChannel(client.channelId, { type: 'draft_update', userId: client.userId, name: client.name, text: '' });
        break;
      }
      case 'ptt_start': {
        if (!client.userId || !client.channelId) break;
        client.audioChunks = [];
        client.audioMime = msg.mime || 'audio/webm';
        client.audioStart = Date.now();
        // Correlates the committed message with the /api/qos reports for this transmission.
        client.audioTxId = typeof msg.txId === 'string' && /^[\w-]{1,32}$/.test(msg.txId) ? msg.txId : undefined;
        // live/rate advertise the talker's PCM stream so listeners can schedule it; a
        // client without a live path (no AudioWorklet) omits them and listeners just
        // wait for the committed clip.
        broadcastToChannel(client.channelId, {
          type: 'ptt_start', userId: client.userId, name: client.name, mime: client.audioMime,
          live: !!msg.live, rate: Number(msg.rate) || 0,
          // Listeners decode frames per this codec — dropping it here once made them read
          // µ-law bytes as Int16 PCM (ear-splitting noise).
          codec: typeof msg.codec === 'string' ? msg.codec.slice(0, 16) : undefined,
          txId: client.audioTxId
        }, ws);
        break;
      }
      case 'ptt_chunk': {
        // Archive upload only — accumulated for the committed clip, not relayed
        // (listeners hear the live PCM frames instead).
        if (!client.userId || !client.channelId || !client.audioChunks || !msg.data) break;
        client.audioChunks.push(Buffer.from(msg.data, 'base64'));
        break;
      }
      case 'ptt_end': {
        if (!client.userId || !client.channelId || !client.audioChunks) break;
        const chunks = client.audioChunks;
        client.audioChunks = null;
        if (!chunks.length) {
          // Recording captured nothing (e.g. iOS stale mic) — clear listeners' "transmitting…" bubble.
          broadcastToChannel(client.channelId, { type: 'ptt_cancel', userId: client.userId });
          break;
        }
        const id = crypto.randomUUID().slice(0, 8);
        const ext = extForMime(client.audioMime);
        const filePath = path.join(MEDIA_DIR, `${id}.${ext}`);
        fs.writeFileSync(filePath, Buffer.concat(chunks));
        const message = {
          id,
          txId: client.audioTxId,
          type: 'audio',
          userId: client.userId,
          name: client.name,
          url: `/media/${id}.${ext}`,
          mime: client.audioMime,
          duration: (Date.now() - client.audioStart) / 1000,
          timestamp: new Date().toISOString()
        };
        appendMessage(client.channelId, message);
        broadcastToChannel(client.channelId, { type: 'message', message });
        // Fire-and-forget: transcript fills in async so the clip posts instantly.
        transcribeClip(client.channelId, id, filePath);
        break;
      }
      case 'delete_message': {
        if (!client.userId || !client.channelId) break;
        const removed = removeOwnMessage(client.channelId, String(msg.id || ''), client.userId);
        console.info(`[delete] ${msg.id} by ${client.userId}: ${removed ? 'removed' : 'not found / not owner'}`);
        if (removed) broadcastToChannel(client.channelId, { type: 'message_deleted', id: removed.id });
        break;
      }
    }
  });

  ws.on('close', () => {
    const client = clients.get(ws);
    if (client && client.userId && client.channelId) {
      drafts.delete(client.userId);
      broadcastToChannel(client.channelId, { type: 'draft_update', userId: client.userId, name: client.name, text: '' });
      // If they were mid-transmission, signal listeners to tear down the live "transmitting" bubble.
      if (client.audioChunks) {
        broadcastToChannel(client.channelId, { type: 'ptt_cancel', userId: client.userId });
      }
    }
    clients.delete(ws);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`LiveChat running at http://localhost:${PORT}`);
  console.log(SPEECH_KEY && SPEECH_REGION
    ? `Transcription: ENABLED (Azure AI Speech, region ${SPEECH_REGION})`
    : 'Transcription: DISABLED (set AZURE_SPEECH_KEY + AZURE_SPEECH_REGION)');
});
