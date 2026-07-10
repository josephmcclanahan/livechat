// --- Session state ---
let userId = localStorage.getItem('userId');
let userName = localStorage.getItem('userName');
let ws = null;
let currentChannelId = null;
let channels = [];
// Voice playback mode: 'full' = stream live as spoken, 'onfinish' = auto-play the whole clip on
// release, 'off' = never auto-play (tap to play from history). Defaults to full.
let playbackMode = localStorage.getItem('playbackMode') || 'full';
// Composer layout for the open room: big centered walkie-talkie (voice) or keyboard-forward
// (chat). Seeded from the channel's defaultMode setting on open; the profile-menu toggle
// overrides it live for the current room only.
let voiceFirst = false;
let currentChannelName = null;
let lastMsgTs = null; // timestamp of the last rendered message, for iMessage-style time headers

if (!userId) {
  userId = crypto.randomUUID();
  localStorage.setItem('userId', userId);
}

// --- WebSocket ---
function connectWS(onOpen) {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}`);
  ws.binaryType = 'arraybuffer'; // binary frames carry live PCM audio; JSON carries everything else
  ws.onopen = () => {
    ws.send(JSON.stringify({ type: 'identify', userId, name: userName }));
    if (onOpen) onOpen();
  };
  ws.onmessage = (e) => {
    if (e.data instanceof ArrayBuffer) onLiveFrame(e.data);
    else handleMessage(JSON.parse(e.data));
  };
  ws.onclose = () => setTimeout(() => connectWS(), 2000);
}

function wsSend(msg) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function handleMessage(msg) {
  switch (msg.type) {
    case 'draft_update': updateDraft(msg); break;
    case 'message':      appendMessage(msg.message, { live: true }); break;
    case 'channel_created': onChannelCreated(msg.channel); break;
    case 'channel_updated': onChannelUpdated(msg.channel); break;
    case 'channel_deleted': onChannelDeleted(msg.channelId); break;
    case 'ptt_start':    onPttStart(msg); break;
    case 'ptt_cancel':   cancelTransmit(msg.userId); break;
    case 'transcript':   onTranscript(msg); break;
    case 'message_deleted': onMessageDeleted(msg.id); break;
  }
}

// --- Entry screen ---
function renderEntry() {
  document.getElementById('app').innerHTML = `
    <div class="center-wrap">
      <h1>LiveChat</h1>
      <p>Enter your name to get started.</p>
      <form id="entry-form">
        <input id="name-input" type="text" placeholder="Your name" maxlength="32" autocomplete="off" />
        <button type="submit">Start chatting</button>
      </form>
    </div>
  `;
  const input = document.getElementById('name-input');
  input.focus();
  document.getElementById('entry-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const name = input.value.trim();
    if (!name) return;
    userName = name;
    localStorage.setItem('userName', name);
    connectWS(renderLayout);
  });
}

// --- Main layout (sidebar + content) ---
function renderLayout() {
  document.getElementById('app').innerHTML = `
    <div class="layout">
      <nav class="sidebar" id="sidebar">
        <div class="sidebar-header">
          <span class="sidebar-title">LiveChat</span>
          <button class="icon-btn" id="close-sidebar" title="Close">✕</button>
        </div>
<div class="channels-label">Channels</div>
        <ul id="channel-list"></ul>
        <button id="new-channel-btn" class="add-channel-btn">+ Add Channel</button>
      </nav>
      <div class="main" id="main">
        <header class="main-header">
          <button class="icon-btn" id="hamburger" title="Channels">☰</button>
          <span id="room-title" class="room-title">Select a channel</span>
          <div class="profile-wrap">
            <button class="profile-badge" id="profile-btn" title="${escHtml(userName)}" aria-haspopup="true" aria-expanded="false">${escHtml(userName.slice(0, 2).toUpperCase())}</button>
            <div class="profile-menu" id="profile-menu" hidden>
              <div class="profile-menu-name">${escHtml(userName)}</div>
              <div class="profile-menu-field">
                <label for="playback-mode">Voice playback</label>
                <select id="playback-mode">
                  <option value="full">Live as spoken</option>
                  <option value="onfinish">Play when finished</option>
                  <option value="off">Off — tap to play</option>
                </select>
              </div>
              <label class="profile-menu-check">
                <input type="checkbox" id="voice-first-toggle" />
                <span>Voice-first layout</span>
              </label>
              <label class="profile-menu-check">
                <input type="checkbox" id="show-qos-toggle" />
                <span>Show voice QoS</span>
              </label>
            </div>
          </div>
        </header>
        <div id="main-content" class="main-content welcome-state">
          <p>Select a channel from the sidebar to start chatting.</p>
        </div>
      </div>
    </div>
  `;

  // Load channels into sidebar, then open the channel named in the URL hash (if any).
  fetch('/api/channels')
    .then(r => r.json())
    .then(list => {
      channels = list;
      list.forEach(addChannelToSidebar);
      const initial = list.find(c => c.id === location.hash.slice(1));
      if (initial) openRoom(initial.id, initial.name);
    });

  // Hamburger / close sidebar
  document.getElementById('hamburger').addEventListener('click', () => {
    document.getElementById('sidebar').classList.add('open');
  });
  document.getElementById('close-sidebar').addEventListener('click', () => {
    document.getElementById('sidebar').classList.remove('open');
  });

  document.getElementById('new-channel-btn').addEventListener('click', () => openChannelModal());

  setupProfileMenu();
}

// --- Profile / settings menu ---
function setupProfileMenu() {
  const btn = document.getElementById('profile-btn');
  const menu = document.getElementById('profile-menu');
  const select = document.getElementById('playback-mode');
  select.value = playbackMode;

  const closeMenu = () => {
    menu.hidden = true;
    btn.setAttribute('aria-expanded', 'false');
    document.removeEventListener('pointerdown', onOutside);
  };
  const onOutside = (e) => { if (!menu.contains(e.target) && e.target !== btn) closeMenu(); };

  btn.addEventListener('click', () => {
    const willOpen = menu.hidden;
    menu.hidden = !willOpen;
    btn.setAttribute('aria-expanded', String(willOpen));
    if (willOpen) document.addEventListener('pointerdown', onOutside);
    else document.removeEventListener('pointerdown', onOutside);
  });

  select.addEventListener('change', () => {
    playbackMode = select.value;
    localStorage.setItem('playbackMode', playbackMode);
    // Dropping out of full live mode stops any in-progress streaming immediately.
    if (playbackMode !== 'full') {
      for (const uid of [...rxAudio.keys()]) teardownRx(uid);
    }
  });

  // Live override of the current room's layout; openRoom re-seeds it from the channel's default.
  const vf = document.getElementById('voice-first-toggle');
  vf.checked = voiceFirst;
  vf.addEventListener('change', () => {
    voiceFirst = vf.checked;
    renderComposer(); // re-render the current room's composer live
  });

  // Debug: a 📊 link on every voice bubble opens that message's QoS reports (capture +
  // every live playback). Re-opens the room so existing bubbles gain/lose the link.
  const qos = document.getElementById('show-qos-toggle');
  qos.checked = showQos;
  qos.addEventListener('change', () => {
    showQos = qos.checked;
    localStorage.setItem('showQos', showQos ? 'on' : 'off');
    if (currentChannelId) openRoom(currentChannelId, currentChannelName);
  });
}

function addChannelToSidebar(channel) {
  const list = document.getElementById('channel-list');
  if (!list || document.getElementById(`ch-${channel.id}`)) return;
  const li = document.createElement('li');
  li.id = `ch-${channel.id}`;
  li.className = 'channel-item';

  const btn = document.createElement('button');
  btn.className = 'channel-btn';
  btn.textContent = `# ${channel.name}`;
  if (channel.id === currentChannelId) btn.classList.add('active');
  btn.addEventListener('click', () => {
    document.getElementById('sidebar').classList.remove('open');
    openRoom(channel.id, channel.name);
  });

  const edit = document.createElement('button');
  edit.className = 'channel-edit-btn';
  edit.title = 'Channel settings';
  edit.textContent = '✎';
  edit.addEventListener('click', (e) => {
    e.stopPropagation();
    openChannelModal(channel);
  });

  const del = document.createElement('button');
  del.className = 'channel-delete-btn';
  del.title = 'Delete channel';
  del.textContent = '×';
  del.addEventListener('click', (e) => {
    e.stopPropagation();
    if (!confirm(`Delete #${channel.name}? This cannot be undone.`)) return;
    fetch(`/api/channels/${channel.id}`, { method: 'DELETE' });
  });

  li.appendChild(btn);
  li.appendChild(edit);
  li.appendChild(del);
  list.appendChild(li);
}

function setActiveChannel(channelId) {
  document.querySelectorAll('.channel-btn').forEach(btn => btn.classList.remove('active'));
  const li = document.getElementById(`ch-${channelId}`);
  if (li) li.querySelector('.channel-btn').classList.add('active');
}

// Channel settings dialog — name and default mode (voice first or chat first). With no
// argument it creates a new channel; given an existing channel it edits it in place.
function openChannelModal(channel = null) {
  document.getElementById('channel-modal')?.remove();
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.id = 'channel-modal';
  overlay.innerHTML = `
    <form class="modal" id="channel-form">
      <h2>${channel ? 'Channel settings' : 'New channel'}</h2>
      <label class="modal-label" for="channel-name-input">Name</label>
      <input id="channel-name-input" type="text" maxlength="32" placeholder="e.g. general" autocomplete="off" />
      <span class="modal-label">Default mode</span>
      <div class="mode-options">
        <label class="mode-option">
          <input type="radio" name="default-mode" value="chat" checked />
          <span class="mode-option-body">
            <strong>💬 Chat first</strong>
            <small>Message box up front, mic alongside</small>
          </span>
        </label>
        <label class="mode-option">
          <input type="radio" name="default-mode" value="voice" />
          <span class="mode-option-body">
            <strong>🎙️ Voice first</strong>
            <small>Big push-to-talk button over the thread</small>
          </span>
        </label>
      </div>
      <div class="modal-actions">
        <button type="button" class="modal-cancel" id="channel-cancel">Cancel</button>
        <button type="submit">${channel ? 'Save' : 'Create'}</button>
      </div>
    </form>
  `;
  // Mount inside #app, which is kept sized to the visual viewport: when the mobile keyboard
  // opens, the dialog re-centers in the visible area instead of staying centered in the full
  // layout viewport with its Save/Cancel row hidden under the keyboard (and iOS rendering the
  // input's caret detached, floating over other content).
  document.getElementById('app').appendChild(overlay);

  const form = overlay.querySelector('#channel-form');
  const nameInput = overlay.querySelector('#channel-name-input');
  if (channel) {
    nameInput.value = channel.name;
    const mode = form.querySelector(`input[name="default-mode"][value="${(channel.defaultMode || 'chat') === 'voice' ? 'voice' : 'chat'}"]`);
    if (mode) mode.checked = true;
  } else {
    // Only the create path starts in the name field (it's empty and required). On edit the
    // name is already filled — focusing it would just pop the keyboard over the dialog.
    nameInput.focus();
  }

  const close = () => overlay.remove();
  overlay.querySelector('#channel-cancel').addEventListener('click', close);
  overlay.addEventListener('pointerdown', (e) => { if (e.target === overlay) close(); });
  overlay.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const name = nameInput.value.trim();
    if (!name) { nameInput.focus(); return; }
    const defaultMode = form.querySelector('input[name="default-mode"]:checked').value;
    const req = channel
      ? fetch(`/api/channels/${channel.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, defaultMode }) })
      : fetch('/api/channels', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, defaultMode }) });
    req
      .then(async (r) => {
        const body = await r.json().catch(() => null);
        if (!r.ok || !body || body.error) throw new Error(body?.error || `Save failed (HTTP ${r.status})`);
        return body;
      })
      .then(saved => {
        close();
        // Apply from the response rather than waiting on the WS broadcast.
        if (channel) {
          onChannelUpdated(saved);
        } else {
          onChannelCreated(saved);
          document.getElementById('sidebar').classList.remove('open');
          openRoom(saved.id, saved.name);
        }
      })
      // Keep the dialog open so nothing is lost; surface why instead of silently doing nothing.
      .catch(err => showToast(err.message || 'Couldn’t save channel'));
  });
}

function onChannelCreated(channel) {
  // The creator hears about the channel twice (POST response + WS broadcast) — add it once.
  if (!channels.find(c => c.id === channel.id)) channels.push(channel);
  addChannelToSidebar(channel);
}

function onChannelUpdated(channel) {
  const cached = channels.find(c => c.id === channel.id);
  const prevMode = cached?.defaultMode || 'chat';
  // Mutate the cached object in place — the sidebar's click/edit/delete handlers hold a
  // reference to it, so they pick up the new settings without re-wiring.
  if (cached) Object.assign(cached, channel);
  else channels.push(channel);

  const btn = document.querySelector(`#ch-${channel.id} .channel-btn`);
  if (btn) btn.textContent = `# ${channel.name}`;

  if (currentChannelId === channel.id) {
    currentChannelName = channel.name;
    document.getElementById('room-title').textContent = `# ${channel.name}`;
    // Re-seed the layout only when the default mode actually changed, so an unrelated rename
    // doesn't clobber someone's live voice-first override.
    if ((channel.defaultMode || 'chat') !== prevMode) {
      voiceFirst = (channel.defaultMode || 'chat') === 'voice';
      const vf = document.getElementById('voice-first-toggle');
      if (vf) vf.checked = voiceFirst;
    }
    renderComposer(); // refresh the "Message #name" placeholder (and layout if mode changed)
  }
}

function onChannelDeleted(channelId) {
  channels = channels.filter(c => c.id !== channelId);
  document.getElementById(`ch-${channelId}`)?.remove();
  if (currentChannelId === channelId) {
    currentChannelId = null;
    if (location.hash.slice(1) === channelId) history.replaceState(null, '', location.pathname + location.search);
    document.getElementById('room-title').textContent = 'Select a channel';
    const main = document.getElementById('main-content');
    main.className = 'main-content welcome-state';
    main.innerHTML = '<p>That channel was deleted.</p>';
  }
}

// --- Room ---
function openRoom(channelId, channelName) {
  if (currentChannelId && currentChannelId !== channelId) {
    wsSend({ type: 'leave' });
  }
  currentChannelId = channelId;
  currentChannelName = channelName;
  setActiveChannel(channelId);
  if (location.hash.slice(1) !== channelId) location.hash = channelId; // so a refresh stays here

  // Start the composer in the channel's default mode (channels predating the setting → chat).
  const channel = channels.find(c => c.id === channelId);
  voiceFirst = (channel?.defaultMode || 'chat') === 'voice';
  const vfToggle = document.getElementById('voice-first-toggle');
  if (vfToggle) vfToggle.checked = voiceFirst;

  document.getElementById('room-title').textContent = `# ${channelName}`;

  document.getElementById('main-content').innerHTML = `
    <div class="room-body">
      <div id="history" class="history"></div>
    </div>
    ${composerMarkup(channelName)}
  `;
  document.getElementById('main-content').className = 'main-content';

  lastMsgTs = null; // fresh thread → next message gets a time header
  fetch(`/api/channels/${channelId}/messages`)
    .then(r => r.json())
    .then(messages => {
      messages.forEach(msg => appendMessage(msg, { scroll: false }));
      scrollHistory();
    });

  wsSend({ type: 'join', channelId });
  wireComposer();
}

// The composer (message box + PTT). Two layouts: normal inline, or voice-first with a big
// centered record button above the message box — a walkie-talkie over the thread.
function composerMarkup(channelName) {
  const ptt = `<button type="button" id="ptt-btn" class="ptt-btn" title="Hold to talk (or hold Space)" aria-label="Hold to talk">🎙️</button>`;
  const input = `<input id="msg-input" type="text" placeholder="Message #${escHtml(channelName)}" autocomplete="off" autocapitalize="sentences" />`;
  const send = '<button type="submit">Send</button>';
  if (voiceFirst) {
    return `
      <form id="msg-form" class="msg-form voice-first">
        ${ptt}
        <span class="ptt-hint">Hold to talk</span>
        <div class="compose-row">${input}${send}</div>
      </form>`;
  }
  return `<form id="msg-form" class="msg-form">${input}${ptt}${send}</form>`;
}

function wireComposer() {
  const msgInput = document.getElementById('msg-input');
  if (!msgInput) return;
  if (!voiceFirst) msgInput.focus(); // don't pop the keyboard in voice-first mode
  msgInput.addEventListener('input', () => wsSend({ type: 'draft', text: msgInput.value }));
  document.getElementById('msg-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const text = msgInput.value.trim();
    if (!text) return;
    wsSend({ type: 'send', text });
    msgInput.value = '';
    wsSend({ type: 'draft', text: '' });
  });

  // Push-to-talk: hold to record, release to send. Hidden if the browser can't record.
  const pttBtn = document.getElementById('ptt-btn');
  if (!pttMime) {
    pttBtn.style.display = 'none';
  } else {
    pttBtn.addEventListener('pointerdown', (e) => { e.preventDefault(); startTransmit(); });
    ['pointerup', 'pointerleave', 'pointercancel'].forEach(ev =>
      pttBtn.addEventListener(ev, () => stopTransmit()));
    pttBtn.addEventListener('contextmenu', (e) => e.preventDefault()); // suppress iOS long-press menu
  }
}

// Re-render just the composer in place (voice-first toggled mid-channel, or the channel's
// settings were edited). Carries any in-progress draft across the swap.
function renderComposer() {
  const form = document.getElementById('msg-form');
  if (!form || !currentChannelName) return;
  const draft = document.getElementById('msg-input')?.value || '';
  form.outerHTML = composerMarkup(currentChannelName);
  wireComposer();
  const input = document.getElementById('msg-input');
  if (input && draft) input.value = draft;
}

// iMessage-style time separator. Returns { day, time } — e.g. { day:'Today', time:'12:30 PM' },
// { day:'Yesterday', time:'8:00 AM' }, { day:'Monday', time:'5:12 PM' }, or { day:'Just now' }.
function formatTimeHeader(date) {
  const now = new Date();
  const diff = now - date;
  if (diff >= 0 && diff < 60 * 1000) return { day: 'Just now', time: '' };
  const time = date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const dayDiff = Math.round((startOfDay(now) - startOfDay(date)) / 86400000);
  let day;
  if (dayDiff <= 0) day = 'Today';
  else if (dayDiff === 1) day = 'Yesterday';
  else if (dayDiff < 7) day = date.toLocaleDateString([], { weekday: 'long' });
  else {
    const opts = { month: 'short', day: 'numeric' };
    if (date.getFullYear() !== now.getFullYear()) opts.year = 'numeric';
    day = date.toLocaleDateString([], opts);
  }
  return { day, time };
}

// Decide whether `msg` opens a new time cluster (first message, >15 min gap, or a new calendar day).
function timeHeaderFor(msg) {
  if (!msg.timestamp) return null;
  const ts = new Date(msg.timestamp).getTime();
  if (Number.isNaN(ts)) return null;
  const GAP = 15 * 60 * 1000;
  const newDay = lastMsgTs == null || new Date(ts).toDateString() !== new Date(lastMsgTs).toDateString();
  const show = lastMsgTs == null || ts - lastMsgTs > GAP || newDay;
  lastMsgTs = ts;
  if (!show) return null;
  const el = document.createElement('div');
  el.className = 'time-header';
  const h = formatTimeHeader(new Date(ts));
  el.innerHTML = h.time ? `<strong>${h.day}</strong> ${h.time}` : `<strong>${h.day}</strong>`;
  return el;
}

function appendMessage(msg, { scroll = true, live = false } = {}) {
  const history = document.getElementById('history');
  if (!history) return;
  const isMine = msg.userId === userId;
  const headerEl = timeHeaderFor(msg);

  // If sender had a live draft/transmitting bubble, replace it in-place with the committed message
  const existingDraft = document.getElementById(`draft-${msg.userId}`);
  const div = document.createElement('div');
  div.className = `message ${isMine ? 'mine' : 'theirs'}`;
  if (msg.id) {
    div.id = `msg-${msg.id}`;
    div.dataset.userId = msg.userId;       // used by the delete menu to check ownership
    if (isMine) div.classList.add('own');
  }

  let shouldAutoplay = false;
  if (msg.type === 'audio') {
    // Auto-play on commit unless playback is off, it's our own clip, or we already heard it
    // live. An open rx that never received a frame (sender's live path failed) doesn't
    // count — and neither do frames "played" into a context that isn't actually running
    // (iOS interruption): they were inaudible, so the clip still auto-plays.
    const rx = rxAudio.get(msg.userId);
    const rxAudible = !!rx && (rx.started || rx.pending.length > 0) &&
      !!audioCtx && audioCtx.state === 'running';
    const playedLive = live && rxAudible;
    shouldAutoplay = playbackMode !== 'off' && live && !isMine && !playedLive;
    const dur = msg.duration ? `${msg.duration.toFixed(1)}s` : '';
    // Empty placeholder (hidden via :empty) that the async `transcript` event fills in.
    const transcript = msg.transcript
      ? `<span class="audio-transcript">${escHtml(msg.transcript)}</span>`
      : '<span class="audio-transcript"></span>';
    const qosLink = showQos && msg.txId
      ? `<button class="qos-link" type="button" data-txid="${escHtml(msg.txId)}">📊 QoS</button>`
      : '';
    div.innerHTML = `
      <span class="msg-name">${escHtml(msg.name)}</span>
      <span class="msg-text audio-bubble">
        <span class="audio-row">
          <button class="ap-play" type="button" aria-label="Play">▶</button>
          <span class="ap-track"><span class="ap-progress"></span></span>
          <span class="audio-dur">🎙️ ${dur}</span>
          <audio preload="metadata" src="${escHtml(msg.url)}"></audio>
        </span>
        ${transcript}
        ${qosLink}
      </span>
    `;
  } else {
    div.innerHTML = `
      <span class="msg-name">${escHtml(msg.name)}</span>
      <span class="msg-text">${escHtml(msg.text)}</span>
    `;
  }

  if (existingDraft) {
    history.replaceChild(div, existingDraft);
  } else {
    const firstDraft = history.querySelector('.draft-bubble');
    if (firstDraft) {
      history.insertBefore(div, firstDraft);
    } else {
      history.appendChild(div);
    }
  }
  if (headerEl) history.insertBefore(headerEl, div); // time separator sits just above its cluster

  if (msg.type === 'audio') {
    // Graceful fallback when this device can't decode the clip's codec (e.g. iOS can't play WebM).
    const audioEl = div.querySelector('audio');
    audioEl?.addEventListener('error', () => {
      const row = div.querySelector('.audio-row');
      if (row) row.innerHTML = '<span class="audio-error">⚠️ Voice clip can’t be played on this device</span>';
    });
    setupAudioPlayer(div, msg.duration);
    div.querySelector('.qos-link')?.addEventListener('click', (e) => openQosModal(e.target.dataset.txid));
    // Let any live-streaming playback for this user finish/clean up now that the clip is committed.
    finishRx(msg.userId);
    // Auto-play through the shared, gesture-unlocked player (serialized — reliable on iOS).
    if (shouldAutoplay) enqueuePlay(msg.url);
  }
  if (scroll) scrollHistory();
}

function scrollHistory() {
  const history = document.getElementById('history');
  if (history) history.scrollTop = history.scrollHeight;
}

// Minimal per-clip player: play/pause + seekable progress bar, no volume control (always 100% —
// the OS/system volume is the only control). The <audio> element itself is hidden.
function setupAudioPlayer(div, msgDuration) {
  const audio = div.querySelector('audio');
  const btn = div.querySelector('.ap-play');
  const track = div.querySelector('.ap-track');
  const prog = div.querySelector('.ap-progress');
  if (!audio || !btn || !track || !prog) return;

  // WebM from MediaRecorder often has no duration in its header → audio.duration is Infinity until
  // the file is read to the end. Fall back to the server's measured duration so the bar moves from
  // the first play, and "prime" the real duration with a seek-to-end so seeking is exact.
  let priming = false;
  const knownDur = () => (Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : (msgDuration || 0));
  const primeDuration = () => {
    if (Number.isFinite(audio.duration) || priming) return;
    priming = true;
    const onTU = () => {
      audio.removeEventListener('timeupdate', onTU);
      audio.currentTime = 0;
      priming = false;
    };
    audio.addEventListener('timeupdate', onTU);
    audio.currentTime = 1e101; // forces the browser to resolve the true duration
  };
  audio.addEventListener('loadedmetadata', primeDuration);
  if (audio.readyState >= 1) primeDuration();

  btn.addEventListener('click', () => { if (audio.paused) audio.play().catch(() => {}); else audio.pause(); });
  audio.addEventListener('play', () => { btn.textContent = '⏸'; btn.setAttribute('aria-label', 'Pause'); });
  audio.addEventListener('pause', () => { btn.textContent = '▶'; btn.setAttribute('aria-label', 'Play'); });
  audio.addEventListener('ended', () => { btn.textContent = '▶'; prog.style.width = '0%'; });
  audio.addEventListener('timeupdate', () => {
    if (priming) return; // ignore the seek-to-end probe
    const d = knownDur();
    if (d) prog.style.width = `${Math.min(100, (audio.currentTime / d) * 100)}%`;
  });
  track.addEventListener('click', (e) => {
    const d = knownDur();
    if (!d) return;
    const rect = track.getBoundingClientRect();
    audio.currentTime = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width)) * d;
  });
}

// Remove a message everyone, after its owner deletes it.
function onMessageDeleted(id) {
  document.getElementById(`msg-${id}`)?.remove();
}

function isTypingTarget(el) {
  if (!el) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
}

// Hold Space (when not typing in a field and you're in a channel) → push-to-talk, like the mic button.
function setupSpacePtt() {
  let spaceHeld = false;
  document.addEventListener('keydown', (e) => {
    if (e.code !== 'Space' || e.repeat || spaceHeld) return;
    if (isTypingTarget(document.activeElement) || !currentChannelId || !pttMime) return;
    if (document.getElementById('channel-modal')) return; // dialog open — Space activates buttons
    e.preventDefault(); // stop page scroll + button activation
    spaceHeld = true;
    startTransmit();
  });
  document.addEventListener('keyup', (e) => {
    if (e.code !== 'Space' || !spaceHeld) return;
    e.preventDefault();
    spaceHeld = false;
    stopTransmit();
  });
}

// Right-click (desktop) or long-press (touch) on your OWN message → a small Delete menu.
function setupMessageMenu() {
  let menu = null;
  let lpTimer = null, lpStart = null;

  const eligible = (target) => {
    const el = target.closest?.('.message');
    if (!el || !el.id.startsWith('msg-') || el.dataset.userId !== userId) return null;
    return el;
  };

  const close = () => {
    if (menu) { menu.remove(); menu = null; }
    document.removeEventListener('pointerdown', onDocDown, true);
  };
  const onDocDown = (e) => { if (menu && !menu.contains(e.target)) close(); };

  const open = (msgEl, x, y) => {
    close();
    const id = msgEl.id.slice(4); // strip "msg-"
    menu = document.createElement('div');
    menu.className = 'msg-menu';
    menu.innerHTML = '<button type="button" class="msg-menu-del">Delete message</button>';
    document.body.appendChild(menu);
    menu.style.left = `${Math.min(x, window.innerWidth - menu.offsetWidth - 8)}px`;
    menu.style.top = `${Math.min(y, window.innerHeight - menu.offsetHeight - 8)}px`;
    menu.querySelector('.msg-menu-del').addEventListener('click', () => {
      wsSend({ type: 'delete_message', id });
      close();
    });
    setTimeout(() => document.addEventListener('pointerdown', onDocDown, true), 0);
  };

  // Desktop: right-click. (Left to the browser on others' messages, so their text stays copyable.)
  document.addEventListener('contextmenu', (e) => {
    const el = eligible(e.target);
    if (!el) return;
    e.preventDefault();
    open(el, e.clientX, e.clientY);
  });

  // Touch: long-press (~500ms), cancelled if the finger moves or lifts early.
  const cancelLp = () => { if (lpTimer) { clearTimeout(lpTimer); lpTimer = null; } };
  document.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse') return;
    const el = eligible(e.target);
    if (!el) return;
    lpStart = { x: e.clientX, y: e.clientY };
    lpTimer = setTimeout(() => { lpTimer = null; open(el, lpStart.x, lpStart.y); }, 500);
  });
  document.addEventListener('pointermove', (e) => {
    if (!lpTimer || !lpStart) return;
    const dx = e.clientX - lpStart.x, dy = e.clientY - lpStart.y;
    if (dx * dx + dy * dy > 100) cancelLp(); // moved >10px → not a long-press
  });
  document.addEventListener('pointerup', cancelLp);
  document.addEventListener('pointercancel', cancelLp);
}

// Fill in a clip's transcript when it arrives from the server (shortly after the clip committed).
// The bubble normally exists already; retry briefly just in case it doesn't yet.
function onTranscript(msg, tries = 0) {
  const el = document.querySelector(`#msg-${msg.id} .audio-transcript`);
  if (el) {
    const history = document.getElementById('history');
    // Was the view at the bottom before the transcript grew the bubble? If so, keep it in view.
    const nearBottom = history && (history.scrollHeight - history.scrollTop - history.clientHeight) < 120;
    el.textContent = msg.text;
    el.classList.remove('none');
    if (nearBottom) scrollHistory();
  } else if (tries < 10) {
    setTimeout(() => onTranscript(msg, tries + 1), 300);
  }
}

function updateDraft(msg) {
  if (msg.userId === userId) return;
  const history = document.getElementById('history');
  if (!history) return;

  let bubble = document.getElementById(`draft-${msg.userId}`);
  if (!msg.text) {
    if (bubble) bubble.remove();
    return;
  }
  if (!bubble) {
    bubble = document.createElement('div');
    bubble.id = `draft-${msg.userId}`;
    bubble.className = 'message theirs draft-bubble';
    history.appendChild(bubble);
    scrollHistory();
  }
  bubble.innerHTML = `
    <span class="msg-name">${escHtml(msg.name)}<span class="live-badge">live</span></span>
    <span class="msg-text">${escHtml(msg.text)}</span>
  `;
}

// --- Utility ---
function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// --- Push-to-talk voice ---
// Two pipelines run off the same mic stream:
//   • Live path — an AudioWorklet posts raw Int16 PCM frames (mono, LIVE_RATE Hz) that are
//     relayed as binary WS frames and scheduled straight into listeners' AudioContext.
//     No containers, no MSE, no codec negotiation — works identically on every browser,
//     including iOS in BOTH directions.
//   • Archive path — MediaRecorder produces the durable compressed clip for history,
//     seeking, and transcription. Its chunks upload to the server but are never relayed.
// Recording support (drives whether the PTT button shows) still keys off MediaRecorder,
// since a hold that can't produce a committed clip shouldn't happen at all.
let pttMime = '';
(function probePtt() {
  if (typeof MediaRecorder === 'undefined') return;
  const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'];
  pttMime = candidates.find(m => { try { return MediaRecorder.isTypeSupported(m); } catch { return false; } }) || '';
})();
// Transcription is server-side (Azure AI Speech) — see server.js. Clips arrive with a transcript
// shortly after they commit, via the `transcript` WS message handled in onTranscript().

const LIVE_RATE = 16000; // Hz — phone-call quality; ~32 KB/s upstream per talker
const LIVE_FRAME = 960;  // samples per binary frame (60 ms at 16 kHz)

// Live-path debug counters — inspect `__lc` from the console on a misbehaving device.
// framesDropped = shed by the talker on a congested uplink; txRatio/txStepScale = capture
// rate calibration; rxLead = current jitter-buffer lead in seconds.
const __lc = { framesSent: 0, framesHeard: 0, framesDropped: 0, underruns: 0 };
window.__lc = __lc;

// --- Voice QoS reporting ---
// Every transmission carries a txId (in ptt_start, per-frame seq numbers, and the
// committed message). Talker and every live listener each POST a per-stream report to
// /api/qos on stream end, so one voice message correlates the capture experience with
// every playback experience. Surfaced in the UI via the "Show voice QoS" setting.
let showQos = localStorage.getItem('showQos') === 'on';

function pctl(sortedSource, p) {
  if (!sortedSource.length) return 0;
  const s = [...sortedSource].sort((a, b) => a - b);
  return Math.round(s[Math.min(s.length - 1, Math.floor(s.length * p))]);
}

function postQos(report) {
  try {
    fetch('/api/qos', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(report),
      keepalive: true // survives the page closing right after a hold
    }).catch(() => {});
  } catch {}
}

// Shows every report for one voice message — the talker's capture report plus one
// playback report per listener who heard it live — with a Copy button so the whole
// bundle can be pasted into a bug report.
function openQosModal(txId) {
  document.getElementById('qos-modal')?.remove();
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.id = 'qos-modal';
  overlay.innerHTML = `
    <div class="modal qos-modal">
      <h2>Voice QoS</h2>
      <pre class="qos-pre">Loading…</pre>
      <div class="modal-actions">
        <button type="button" class="modal-cancel" id="qos-close">Close</button>
        <button type="button" id="qos-copy">Copy</button>
      </div>
    </div>
  `;
  document.getElementById('app').appendChild(overlay);
  const close = () => overlay.remove();
  overlay.querySelector('#qos-close').addEventListener('click', close);
  overlay.addEventListener('pointerdown', (e) => { if (e.target === overlay) close(); });

  let payload = '';
  fetch(`/api/qos/${encodeURIComponent(txId)}`)
    .then(r => r.json())
    .then(rows => {
      const summary = rows.map(r => r.role === 'tx'
        ? `🎙 ${r.user}: ${r.framesSent}/${r.framesEmitted} frames sent, ${r.framesShed} shed, ratio ${r.txRatio ? r.txRatio.toFixed(3) : '—'}`
        : `🔊 ${r.user}: ${r.frames} frames, ${r.seqShed} shed upstream, ${r.underruns} underruns (${r.insertedGapMs}ms gaps), servo ${r.servo ? r.servo.mean : '—'}`
      ).join('\n');
      payload = JSON.stringify({ txId, thisDevice: { ...__lc, ua: navigator.userAgent }, reports: rows }, null, 2);
      overlay.querySelector('.qos-pre').textContent =
        (rows.length ? summary : 'No reports for this transmission (recorded before QoS existed, or reports not yet posted).') +
        '\n\n' + payload;
    })
    .catch(() => { overlay.querySelector('.qos-pre').textContent = 'Failed to load QoS reports.'; });

  overlay.querySelector('#qos-copy').addEventListener('click', () => {
    navigator.clipboard?.writeText(payload).then(
      () => showToast('QoS copied to clipboard'),
      () => showToast('Copy failed')
    );
  });
}

// ONE shared AudioContext drives both live capture and live playback. Capture must NOT
// get its own context: a second context with no real output demand can receive render
// callbacks faster than the mic delivers samples, so the media-stream source pads the
// gaps with silence — heard as chopped audio on every platform. iOS creates the context
// 'suspended' until a user gesture resumes it, and flips it to 'interrupted' when the
// audio session changes (e.g. after a recording) — unlockAudio() and startRx() re-kick it.
let audioCtx = null;
let workletReady = null;

function getAudioCtx() {
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return null;
  if (!audioCtx) audioCtx = new AC();
  if (audioCtx.state !== 'running') audioCtx.resume().catch(() => {});
  return audioCtx;
}

function ensureWorklet() {
  const ctx = getAudioCtx();
  if (!ctx || !ctx.audioWorklet || typeof AudioWorkletNode === 'undefined') return Promise.resolve(false);
  if (!workletReady) {
    workletReady = ctx.audioWorklet.addModule('pcm-capture-worklet.js').then(() => true, () => false);
  }
  return workletReady;
}

// The worklet's resample step assumes mic samples arrive at the context's rate. That
// assumption breaks on iOS: the hardware rate changes when the mic session starts (e.g.
// 48 kHz → 24 kHz on some routes) while the context's rate stays locked at creation, so
// captured audio comes out at the wrong speed. Rather than model WebKit's session
// behavior (rebuilding the context mid-hold corrupts MediaRecorder's clip), the capture
// path SELF-CALIBRATES: measure emitted-audio-seconds against the wall clock early in
// each hold and scale the worklet's step by the observed ratio. The learned scale
// persists across holds, so only the first hold on a mismatched route drifts briefly.
let txStepScale = 1;

// iOS mutes Web Audio's output with the ring/silent switch UNLESS the page's audio
// session is in playback mode — which any playing media element provides (observed
// directly: live audio through ctx.destination was silent until a clip played through an
// <audio> element, then worked). So a silent, looping "keeper" element holds the session
// in playback mode from the first gesture on. Live playback itself stays on
// ctx.destination — playing the live mix through a media element instead adds buffering
// and glitch-loops the last chunk when the stream stalls between transmissions.
let keeper = null;

function silentWavUrl(seconds = 1) {
  const rate = 8000, n = rate * seconds;
  const buf = new ArrayBuffer(44 + n), v = new DataView(buf);
  const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); v.setUint32(4, 36 + n, true); w(8, 'WAVEfmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate, true); v.setUint16(32, 1, true);
  v.setUint16(34, 8, true); w(36, 'data'); v.setUint32(40, n, true);
  new Uint8Array(buf, 44).fill(0x80); // 8-bit PCM silence
  return URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
}

// Re-kick on every gesture and on each incoming transmission: needs a gesture once, and
// iOS pauses the element when the audio session is interrupted (e.g. after recording).
function keepSessionAlive() {
  getAudioCtx();
  if (!keeper) {
    keeper = new Audio();
    keeper.setAttribute('playsinline', '');
    keeper.loop = true;
    keeper.src = silentWavUrl();
  }
  if (keeper.paused) keeper.play().catch(() => {});
}

let micStream = null;
let recorder = null;
let liveTx = null; // { src, node, mute } — active worklet capture graph
let transmitting = false;
let txHadData = false; // did the current transmission actually capture any audio?
let chunkChain = Promise.resolve();
const rxAudio = new Map(); // userId → { gain, rate, nextTime, started, pending }

// --- Auto-play of incoming clips ---
// iOS only permits audio that originates from a user gesture, and blocks/queues a fresh <audio>
// element each time — so we play every auto-played clip through ONE persistent element that we
// "unlock" on the first gesture, then reuse. A serial queue keeps clips one-at-a-time (no overlap,
// no backlog flushing all at once).
const player = new Audio();
player.setAttribute('playsinline', '');
let playQueue = [];
let playing = false;

const SILENT_CLIP = 'data:audio/mp4;base64,AAAAHGZ0eXBNNEEgAAAAAE00QSBpc29tbXA0MgAAAAhmcmVlAAAAGm1kYXQAAAAA';
let audioUnlocked = false;
function unlockAudio() {
  keepSessionAlive(); // create/resume the AudioContext + keeper element during a gesture
  if (audioUnlocked) return;
  audioUnlocked = true;
  try {
    player.muted = true;
    player.src = SILENT_CLIP;
    player.play().then(() => {
      player.pause();
      player.currentTime = 0;
      player.muted = false;
    }).catch(() => { player.muted = false; });
  } catch {}
}

function enqueuePlay(url) {
  playQueue.push(url);
  if (!playing) playNext();
}

function playNext() {
  if (!playQueue.length) { playing = false; return; }
  playing = true;
  player.src = playQueue.shift();
  let advanced = false;
  const advance = () => {
    if (advanced) return; // guard: ended/error/rejection could all fire for one item
    advanced = true;
    player.onended = null;
    player.onerror = null;
    playNext();
  };
  player.onended = advance;
  player.onerror = advance;
  player.play().catch(advance);
}

// --- Transmit (hold PTT) ---
async function startTransmit() {
  if (transmitting || !pttMime) return;
  unlockAudio(); // this hold is a user gesture — also unlock playback for incoming voice
  transmitting = true;
  document.getElementById('ptt-btn')?.classList.add('recording');

  try {
    if (!micStream) micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch {
    transmitting = false;
    document.getElementById('ptt-btn')?.classList.remove('recording');
    showToast('Microphone access denied');
    return;
  }
  if (!transmitting) { releaseMic(); return; } // released before permission resolved

  const liveOk = await ensureWorklet(); // instant when the module is already loaded
  if (!transmitting) { releaseMic(); return; }

  const txId = crypto.randomUUID().slice(0, 8);
  wsSend({ type: 'ptt_start', mime: pttMime, live: liveOk, rate: LIVE_RATE, codec: 'ulaw', txId });
  txHadData = false;
  recorder = new MediaRecorder(micStream, { mimeType: pttMime });
  recorder.ondataavailable = (e) => {
    if (!e.data || !e.data.size) return;
    txHadData = true;
    // Serialize encodes so chunks (and the final ptt_end) stay in order.
    chunkChain = chunkChain.then(async () => {
      const data = await blobToBase64(e.data);
      wsSend({ type: 'ptt_chunk', data });
    });
  };
  recorder.onstop = () => {
    chunkChain = chunkChain.then(() => wsSend({ type: 'ptt_end' }));
    releaseMic(); // fires after the final ondataavailable, so no audio is truncated
    if (!txHadData) showToast('Couldn’t record — try again'); // mic never produced audio
  };
  // Archive recorder only — live audio rides the worklet PCM path, not these chunks.
  // WebM uploads progressively via timeslice so long holds don't burst on release; MP4 (iOS)
  // is only valid as one complete blob (its sample index is written at the end), so it
  // records in one piece and uploads on stop.
  if (pttMime.includes('webm')) recorder.start(250);
  else recorder.start();

  if (liveOk) startLiveTx(txId);
}

// Mic → worklet (resample to LIVE_RATE Int16 frames) → binary WS frames, all on the
// SHARED context. The worklet's output is muted into the destination only to keep the
// graph pulled — nothing is audible locally.
function startLiveTx(txId) {
  const ctx = getAudioCtx();
  if (!ctx || !micStream) return;
  try {
    const src = ctx.createMediaStreamSource(micStream);
    const node = new AudioWorkletNode(ctx, 'pcm-capture', {
      processorOptions: { targetRate: LIVE_RATE, frameSize: LIVE_FRAME }
    });
    if (txStepScale !== 1) node.port.postMessage({ type: 'stepScale', value: txStepScale });
    // Capture-side QoS: emission cadence (worklet→main gaps expose main-thread or context
    // stalls), shed counts, and socket backpressure — reported to /api/qos on release.
    const stats = {
      txId, t0: performance.now(), emitted: 0, sent: 0, shed: 0,
      maxBuffered: 0, emitGaps: [], lastEmitAt: 0, seq: 0
    };
    // Continuous self-calibration: compare audio-seconds emitted to wall time over rolling
    // ~750 ms windows for the whole hold. A healthy pipeline reads ~1.0; a stale-rate mic
    // feed reads ~0.5 or ~2 — and a previous one-shot correction can leave a few-percent
    // residual that drains the listener's buffer into an underrun every few seconds, so
    // small persistent drift matters too. A correction is applied only when TWO
    // consecutive windows agree (same direction, within 25%) — a single main-thread stall
    // would otherwise skew one window and persist a bogus correction.
    let winStart = 0, winStartFrames = 0, prevRatio = 0;
    const frameMs = LIVE_FRAME / LIVE_RATE * 1000;
    node.port.onmessage = (e) => {
      const frame = e.data; // Uint8Array of µ-law bytes

      const now = performance.now();
      stats.emitted++;
      if (stats.lastEmitAt && stats.emitGaps.length < 4000) stats.emitGaps.push(now - stats.lastEmitAt);
      stats.lastEmitAt = now;
      if (!winStart) { winStart = now; winStartFrames = 0; }
      winStartFrames++;
      if (now - winStart >= 750 && winStartFrames > 2) {
        const ratio = (winStartFrames - 1) * frameMs / (now - winStart);
        __lc.txRatio = ratio;
        const off = (r) => r < 0.97 || r > 1.03;
        if (prevRatio && off(ratio) && off(prevRatio) && (ratio < 1) === (prevRatio < 1) &&
            Math.abs(ratio - prevRatio) < 0.25 * Math.max(ratio, prevRatio)) {
          txStepScale = Math.min(2.5, Math.max(0.4, txStepScale * (ratio + prevRatio) / 2));
          node.port.postMessage({ type: 'stepScale', value: txStepScale });
          __lc.txStepScale = txStepScale;
          __lc.txCal = (__lc.txCal || 0) + 1;
          prevRatio = 0; // emission rate just changed; require a fresh agreeing pair
        } else {
          prevRatio = ratio;
        }
        // This frame anchors the next window and counts as its first (the ratio divides
        // frame INTERVALS by elapsed time, so the anchor must be included).
        winStart = now;
        winStartFrames = 1;
      }

      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      if (ws.bufferedAmount > stats.maxBuffered) stats.maxBuffered = ws.bufferedAmount;
      // Every frame carries a sequence number (even shed ones burn one), so listeners can
      // tell sender-shed gaps from their own underruns.
      const seq = stats.seq++ & 0xffff;
      // Live audio over TCP must shed when behind, not queue: a slow uplink otherwise
      // delays frames by seconds and every one arrives too late to play. The archive
      // clip is lossless regardless.
      if (ws.bufferedAmount > 12000) { __lc.framesDropped++; stats.shed++; return; }
      const out = new Uint8Array(3 + frame.length);
      out[0] = 0x01;
      out[1] = seq & 0xff;
      out[2] = seq >> 8;
      out.set(frame, 3);
      ws.send(out);
      __lc.framesSent++;
      stats.sent++;
    };
    const mute = ctx.createGain();
    mute.gain.value = 0;
    src.connect(node);
    node.connect(mute);
    mute.connect(ctx.destination);
    liveTx = { src, node, mute, stats };
  } catch {
    liveTx = null; // listeners fall back to hearing the committed clip
  }
}

function stopLiveTx() {
  if (!liveTx) return;
  try { liveTx.node.port.onmessage = null; } catch {}
  try { liveTx.src.disconnect(); } catch {}
  try { liveTx.node.disconnect(); } catch {}
  try { liveTx.mute.disconnect(); } catch {}
  const s = liveTx.stats;
  liveTx = null;
  if (!s || !s.emitted) return;
  postQos({
    txId: s.txId, role: 'tx', user: userName, ua: navigator.userAgent,
    holdMs: Math.round(performance.now() - s.t0),
    audioMs: Math.round(s.emitted * LIVE_FRAME / LIVE_RATE * 1000),
    framesEmitted: s.emitted, framesSent: s.sent, framesShed: s.shed,
    maxBufferedKB: Math.round(s.maxBuffered / 1024),
    emitGapMs: { p50: pctl(s.emitGaps, 0.5), p95: pctl(s.emitGaps, 0.95), max: pctl(s.emitGaps, 1) },
    txRatio: __lc.txRatio, txStepScale, txCal: __lc.txCal || 0,
    ctxRate: audioCtx ? audioCtx.sampleRate : 0
  });
}

function stopTransmit() {
  if (!transmitting) return;
  transmitting = false;
  document.getElementById('ptt-btn')?.classList.remove('recording');
  const rec = recorder;
  recorder = null;
  if (rec && rec.state !== 'inactive') {
    rec.stop(); // fires final ondataavailable, then onstop → ptt_end + releaseMic
  } else {
    releaseMic(); // released before recording started
  }
}

// Stop the mic so the OS audio session returns to playback mode (iOS otherwise keeps the mic hot,
// which ducks/blocks incoming clip playback and turns off the recording indicator) and so the next
// transmission gets a FRESH stream — a cached iOS track can silently die and record a 0s clip.
function releaseMic() {
  stopLiveTx();
  if (!micStream) return;
  micStream.getTracks().forEach(t => t.stop());
  micStream = null;
}

function blobToBase64(blob) {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(String(reader.result).split(',')[1] || '');
    reader.readAsDataURL(blob);
  });
}

// --- Receive (other users' transmissions) ---
function onPttStart(msg) {
  if (msg.userId === userId) return;
  showTransmitBubble(msg.userId, msg.name);
  if (msg.live && msg.rate) startRx(msg.userId, msg.rate, msg.codec, msg.txId);
}

function showTransmitBubble(uid, name) {
  const history = document.getElementById('history');
  if (!history) return;
  let bubble = document.getElementById(`draft-${uid}`);
  if (!bubble) {
    bubble = document.createElement('div');
    bubble.id = `draft-${uid}`;
    bubble.className = 'message theirs draft-bubble';
    history.appendChild(bubble);
  }
  bubble.innerHTML = `
    <span class="msg-name">${escHtml(name)}<span class="live-badge">live</span></span>
    <span class="msg-text ptt-live"><span class="ptt-bars"><i></i><i></i><i></i></span>🔴 transmitting…</span>
  `;
  scrollHistory();
}

// Jitter buffer: hold this much audio before starting playback. Adaptive — grows when the
// network stalls mid-stream (smoothness), decays a little on each healthy new transmission
// so latency creeps back down (snappiness).
const RX_MIN_LEAD = 0.15, RX_MAX_LEAD = 0.5; // seconds
let rxLead = RX_MIN_LEAD;

function startRx(uid, rate, codec, txId) {
  if (playbackMode !== 'full') return;
  if (!(rate >= 8000 && rate <= 96000)) return; // AudioBuffer's supported range
  const ctx = getAudioCtx();
  if (!ctx) return; // no Web Audio → fall back to playing the committed clip
  teardownRx(uid);
  keepSessionAlive(); // best-effort: re-kick after an iOS audio-session interruption
  rxLead = Math.max(RX_MIN_LEAD, rxLead * 0.9);
  __lc.rxLead = rxLead;
  const gain = ctx.createGain();
  gain.connect(ctx.destination);
  __lc.rxCodec = codec; // what the last live stream advertised — undefined means Int16
  const stats = {
    txId, t0: performance.now(), frames: 0, bytes: 0,
    seqNext: -1, seqShed: 0, reorders: 0,
    arriveGaps: [], lastArriveAt: 0, bursts: 0,
    underruns: 0, insertedGapMs: 0, lateDrops: 0,
    leadStart: rxLead, leadMax: rxLead,
    rateMin: 1, rateMax: 1, rateSum: 0, rateN: 0, pinned: 0
  };
  rxAudio.set(uid, { gain, rate, codec, txId, stats, nextTime: 0, started: false, pending: [] });
}

// G.711 µ-law byte → float sample, precomputed for the decode path.
const ULAW_TABLE = (() => {
  const t = new Float32Array(256);
  for (let i = 0; i < 256; i++) {
    const u = ~i & 0xff;
    const sign = u & 0x80, exp = (u >> 4) & 7, mant = u & 0x0f;
    const s = ((((mant << 3) + 132) << exp) - 132);
    t[i] = (sign ? -s : s) / 32768;
  }
  return t;
})();

// A binary WS frame arrived: [0x01][uidLen][uid utf8][µ-law bytes] (Int16 if the talker
// didn't advertise a codec).
const utf8 = new TextDecoder();
function onLiveFrame(buf) {
  const view = new Uint8Array(buf);
  if (view.length < 4 || view[0] !== 0x01) return;
  const uidLen = view[1];
  if (view.length < 2 + uidLen + 2) return;
  const rx = rxAudio.get(utf8.decode(view.subarray(2, 2 + uidLen)));
  if (!rx) return; // not in full mode, or transmission already torn down

  // Streams with a txId carry a u16 sequence number ahead of the audio bytes — gaps mean
  // the sender shed those frames (uplink congestion), distinct from local underruns.
  let payloadAt = 2 + uidLen;
  const s = rx.stats;
  const now = performance.now();
  if (s.lastArriveAt) {
    const gap = now - s.lastArriveAt;
    if (s.arriveGaps.length < 4000) s.arriveGaps.push(gap);
    if (gap < 5) s.bursts++;
  }
  s.lastArriveAt = now;
  if (rx.txId) {
    const seq = view[payloadAt] | (view[payloadAt + 1] << 8);
    payloadAt += 2;
    if (s.seqNext >= 0 && seq !== s.seqNext) {
      const ahead = (seq - s.seqNext) & 0xffff;
      if (ahead > 0 && ahead < 1000) s.seqShed += ahead;
      else s.reorders++;
    }
    s.seqNext = (seq + 1) & 0xffff;
  }
  s.frames++;
  s.bytes += view.length;

  let ch;
  if (rx.codec === 'ulaw') {
    const bytes = view.subarray(payloadAt);
    ch = new Float32Array(bytes.length);
    for (let i = 0; i < bytes.length; i++) ch[i] = ULAW_TABLE[bytes[i]];
  } else {
    const pcm = new Int16Array(buf.slice(payloadAt)); // slice() realigns the odd offset
    ch = new Float32Array(pcm.length);
    for (let i = 0; i < pcm.length; i++) ch[i] = pcm[i] / 32768;
  }
  // Roughness diagnostic: mean |sample-to-sample jump| per frame. Real audio reads well
  // under 0.2 (occasional clicks barely move a mean); a codec mismatch (µ-law read as
  // Int16, or vice versa) decodes to white noise and reads ~0.6+.
  let rough = 0;
  for (let i = 1; i < ch.length; i++) rough += Math.abs(ch[i] - ch[i - 1]);
  rough /= Math.max(1, ch.length - 1);
  if (!(__lc.rxRough >= rough)) __lc.rxRough = rough;
  const ab = audioCtx.createBuffer(1, ch.length, rx.rate);
  ab.getChannelData(0).set(ch);
  __lc.framesHeard++;

  if (rx.started) return scheduleRx(rx, ab);
  // Pre-buffer until we're rxLead ahead, then release the backlog in one go.
  rx.pending.push(ab);
  let buffered = 0;
  for (const b of rx.pending) buffered += b.duration;
  if (buffered >= rxLead) flushPending(rx);
}

function flushPending(rx) {
  rx.started = true;
  rx.nextTime = audioCtx.currentTime + 0.02;
  for (const b of rx.pending) scheduleRx(rx, b);
  rx.pending = [];
}

function scheduleRx(rx, buf) {
  const now = audioCtx.currentTime;
  // A sender producing more audio than real time (e.g. a mis-clocked capture context)
  // would otherwise push the backlog — and the listening delay — up without bound.
  if (rx.nextTime - now > 1.5) { rx.stats.lateDrops++; return; }
  if (rx.nextTime < now + 0.005) {
    // Underrun: playback caught up with the network. Grow the lead and resume that far
    // ahead — re-anchoring any tighter (e.g. a fixed 50 ms) leaves less headroom than the
    // jitter that caused the underrun, and playback then underruns every couple of frames.
    if (rx.nextTime > 0) {
      rxLead = Math.min(rxLead * 1.5, RX_MAX_LEAD);
      __lc.underruns++;
      __lc.rxLead = rxLead;
      if (!__lc.underrunLog) __lc.underrunLog = [];
      if (__lc.underrunLog.length < 50) {
        __lc.underrunLog.push({ frame: __lc.framesHeard, deficitMs: Math.round((now - rx.nextTime) * 1000) });
      }
      rx.stats.underruns++;
      rx.stats.insertedGapMs += Math.round((now + rxLead - rx.nextTime) * 1000);
      if (rxLead > rx.stats.leadMax) rx.stats.leadMax = rxLead;
    }
    rx.nextTime = now + rxLead;
  }
  // Playout servo: steer the buffered backlog toward rxLead by playing up to ±3% fast or
  // slow (inaudible for voice). Absorbs residual clock drift between sender and listener
  // — even perfectly calibrated devices tick a little differently, and un-absorbed drift
  // drains the buffer into an underrun every few seconds.
  const backlog = rx.nextTime - now;
  const rate = Math.max(0.97, Math.min(1.03, 1 + (backlog - rxLead) * 0.15));
  __lc.rxRate = rate;
  const s = rx.stats;
  if (rate < s.rateMin) s.rateMin = rate;
  if (rate > s.rateMax) s.rateMax = rate;
  s.rateSum += rate; s.rateN++;
  if (rate <= 0.97 || rate >= 1.03) s.pinned++;
  const src = audioCtx.createBufferSource();
  src.buffer = buf;
  src.playbackRate.value = rate;
  src.connect(rx.gain);
  src.start(rx.nextTime);
  rx.nextTime += buf.duration / rate;
}

// Clip committed: flush anything still pre-buffering (clips shorter than the jitter lead),
// let the scheduled tail play out, then release the node.
function finishRx(uid) {
  const rx = rxAudio.get(uid);
  if (!rx) return;
  rxAudio.delete(uid);
  if (!rx.started && rx.pending.length) flushPending(rx);
  const tail = audioCtx ? Math.max(0, rx.nextTime - audioCtx.currentTime) : 0;
  setTimeout(() => { try { rx.gain.disconnect(); } catch {} }, (tail + 0.2) * 1000);
  sendRxQos(rx, 'commit');
}

function sendRxQos(rx, ended) {
  const s = rx.stats;
  if (!s || !s.txId || !s.frames) return;
  postQos({
    txId: s.txId, role: 'rx', user: userName, ua: navigator.userAgent,
    durMs: Math.round(performance.now() - s.t0),
    frames: s.frames, bytes: s.bytes, seqShed: s.seqShed, reorders: s.reorders,
    arriveGapMs: { p50: pctl(s.arriveGaps, 0.5), p95: pctl(s.arriveGaps, 0.95), max: pctl(s.arriveGaps, 1) },
    bursts: s.bursts,
    underruns: s.underruns, insertedGapMs: s.insertedGapMs, lateDrops: s.lateDrops,
    lead: { start: +s.leadStart.toFixed(3), end: +rxLead.toFixed(3), max: +s.leadMax.toFixed(3) },
    servo: {
      min: +s.rateMin.toFixed(4), max: +s.rateMax.toFixed(4),
      mean: s.rateN ? +(s.rateSum / s.rateN).toFixed(4) : 1,
      pinnedPct: s.rateN ? Math.round(100 * s.pinned / s.rateN) : 0
    },
    codec: rx.codec, rate: rx.rate,
    ctxState: audioCtx ? audioCtx.state : 'none',
    ended
  });
}

// Transmitter left/disconnected mid-clip: drop the live bubble + playback, no commit coming.
function cancelTransmit(uid) {
  teardownRx(uid);
  document.getElementById(`draft-${uid}`)?.remove();
}

function teardownRx(uid) {
  const rx = rxAudio.get(uid);
  if (!rx) return;
  rxAudio.delete(uid);
  try { rx.gain.disconnect(); } catch {} // also silences any already-scheduled sources
  sendRxQos(rx, 'cancel');
}

// --- Toast ---
function showToast(text) {
  let t = document.getElementById('toast');
  if (!t) {
    t = document.createElement('div');
    t.id = 'toast';
    t.className = 'toast';
    document.body.appendChild(t);
  }
  t.textContent = text;
  t.classList.add('show');
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.remove('show'), 2500);
}

// --- Viewport: keep #app sized to visible area so iOS keyboard doesn't push content off screen ---
function setupViewport() {
  if (!window.visualViewport) return;
  const update = () => {
    document.getElementById('app').style.height = window.visualViewport.height + 'px';
    window.scrollTo(0, 0); // prevent iOS from offsetting the page when keyboard opens
    scrollHistory();
  };
  window.visualViewport.addEventListener('resize', update);
  window.visualViewport.addEventListener('scroll', update);
  update();
}

// Navigate when the URL hash changes (back/forward, or manual edit).
function onHashChange() {
  const id = location.hash.slice(1);
  if (!id || id === currentChannelId) return;
  const ch = channels.find(c => c.id === id);
  if (ch) openRoom(ch.id, ch.name);
}

// --- Boot ---
setupViewport();
setupMessageMenu();
setupSpacePtt();
window.addEventListener('hashchange', onHashChange);
// Unlock audio playback on the very first user interaction (covers pure listeners who never hold PTT).
document.addEventListener('pointerdown', unlockAudio, { once: true });
if (userName) {
  connectWS(renderLayout);
} else {
  renderEntry();
}
