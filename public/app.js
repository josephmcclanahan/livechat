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
  ws.onopen = () => {
    ws.send(JSON.stringify({ type: 'identify', userId, name: userName }));
    if (onOpen) onOpen();
  };
  ws.onmessage = (e) => handleMessage(JSON.parse(e.data));
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
    case 'channel_deleted': onChannelDeleted(msg.channelId); break;
    case 'ptt_start':    onPttStart(msg); break;
    case 'ptt_chunk':    pushRx(msg.userId, msg.data); break;
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

  document.getElementById('new-channel-btn').addEventListener('click', createChannel);

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
  li.appendChild(del);
  list.appendChild(li);
}

function setActiveChannel(channelId) {
  document.querySelectorAll('.channel-btn').forEach(btn => btn.classList.remove('active'));
  const li = document.getElementById(`ch-${channelId}`);
  if (li) li.querySelector('.channel-btn').classList.add('active');
}

// New-channel dialog: asks for the channel's settings — name and default mode (voice first
// or chat first) — before creating it.
function createChannel() {
  document.getElementById('channel-modal')?.remove();
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.id = 'channel-modal';
  overlay.innerHTML = `
    <form class="modal" id="channel-form">
      <h2>New channel</h2>
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
        <button type="submit">Create</button>
      </div>
    </form>
  `;
  document.body.appendChild(overlay);

  const form = overlay.querySelector('#channel-form');
  const nameInput = overlay.querySelector('#channel-name-input');
  nameInput.focus();

  const close = () => overlay.remove();
  overlay.querySelector('#channel-cancel').addEventListener('click', close);
  overlay.addEventListener('pointerdown', (e) => { if (e.target === overlay) close(); });
  overlay.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const name = nameInput.value.trim();
    if (!name) { nameInput.focus(); return; }
    const defaultMode = form.querySelector('input[name="default-mode"]:checked').value;
    fetch('/api/channels', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, defaultMode })
    })
      .then(r => r.json())
      .then(channel => {
        close();
        onChannelCreated(channel); // don't wait on the WS broadcast — openRoom needs the settings
        document.getElementById('sidebar').classList.remove('open');
        openRoom(channel.id, channel.name);
      });
  });
}

function onChannelCreated(channel) {
  // The creator hears about the channel twice (POST response + WS broadcast) — add it once.
  if (!channels.find(c => c.id === channel.id)) channels.push(channel);
  addChannelToSidebar(channel);
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

// Re-render just the composer in place (e.g. when the voice-first setting is toggled mid-channel).
function renderComposer() {
  const form = document.getElementById('msg-form');
  if (!form || !currentChannelName) return;
  form.outerHTML = composerMarkup(currentChannelName);
  wireComposer();
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
    // Auto-play on commit unless playback is off, it's our own clip, or we already heard it live.
    const playedLive = live && rxAudio.has(msg.userId);
    shouldAutoplay = playbackMode !== 'off' && live && !isMine && !playedLive;
    const dur = msg.duration ? `${msg.duration.toFixed(1)}s` : '';
    // Empty placeholder (hidden via :empty) that the async `transcript` event fills in.
    const transcript = msg.transcript
      ? `<span class="audio-transcript">${escHtml(msg.transcript)}</span>`
      : '<span class="audio-transcript"></span>';
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
// Recording support (drives whether the PTT button shows). Live playback is decided
// per-incoming-stream via MediaSource.isTypeSupported(senderMime).
let pttMime = '';
(function probePtt() {
  if (typeof MediaRecorder === 'undefined') return;
  const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'];
  pttMime = candidates.find(m => { try { return MediaRecorder.isTypeSupported(m); } catch { return false; } }) || '';
})();
// Transcription is server-side (Azure AI Speech) — see server.js. Clips arrive with a transcript
// shortly after they commit, via the `transcript` WS message handled in onTranscript().

let micStream = null;
let recorder = null;
let transmitting = false;
let txHadData = false; // did the current transmission actually capture any audio?
let chunkChain = Promise.resolve();
const rxAudio = new Map(); // userId → { ms, audio, sb, queue, open }

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
  if (!transmitting) return; // released before permission resolved

  wsSend({ type: 'ptt_start', mime: pttMime });
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
  // Only WebM concatenates into a valid file from timeslice fragments (and streams via MSE).
  // MP4 (iOS) must be recorded in one piece, or the assembled file's index is corrupt — so no
  // timeslice: a single complete, valid blob is emitted on stop (plays on release, no live stream).
  if (pttMime.includes('webm')) recorder.start(250);
  else recorder.start();
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
  startRx(msg.userId, msg.mime);
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

function startRx(uid, mime) {
  // Live streaming only in 'full' mode, only for WebM (MP4 fragments from MediaRecorder don't
  // append cleanly to a SourceBuffer → chopped/skipping), and only if this browser can decode it.
  // Anything else falls back to playing the committed clip on release.
  if (playbackMode !== 'full') return;
  if (!mime || !mime.includes('webm')) return;
  if (!('MediaSource' in window)) return;
  try { if (!MediaSource.isTypeSupported(mime)) return; } catch { return; }

  teardownRx(uid);
  const ms = new MediaSource();
  const audio = new Audio();
  audio.src = URL.createObjectURL(ms);
  const ctx = { ms, audio, sb: null, queue: [], open: false };
  rxAudio.set(uid, ctx);

  ms.addEventListener('sourceopen', () => {
    try {
      ctx.sb = ms.addSourceBuffer(mime);
      ctx.open = true;
      ctx.sb.addEventListener('updateend', () => flushRx(ctx));
      flushRx(ctx);
    } catch { /* codec rejected mid-stream; fallback clip will play on commit */ }
  });
  audio.play().catch(() => {}); // best-effort; page already has user interaction
}

function pushRx(uid, base64) {
  const ctx = rxAudio.get(uid);
  if (!ctx || !base64) return;
  ctx.queue.push(base64ToBytes(base64));
  flushRx(ctx);
}

function flushRx(ctx) {
  if (!ctx.open || !ctx.sb || ctx.sb.updating || !ctx.queue.length) return;
  try { ctx.sb.appendBuffer(ctx.queue.shift()); } catch { /* buffer full / closed */ }
}

// Clip committed: let the buffered tail finish, then release the MediaSource.
function finishRx(uid) {
  const ctx = rxAudio.get(uid);
  if (!ctx) return;
  rxAudio.delete(uid);
  ctx.audio.addEventListener('ended', () => { try { URL.revokeObjectURL(ctx.audio.src); } catch {} }, { once: true });
  const end = () => { try { if (ctx.ms.readyState === 'open') ctx.ms.endOfStream(); } catch {} };
  if (ctx.sb && ctx.sb.updating) ctx.sb.addEventListener('updateend', end, { once: true });
  else end();
}

// Transmitter left/disconnected mid-clip: drop the live bubble + playback, no commit coming.
function cancelTransmit(uid) {
  teardownRx(uid);
  document.getElementById(`draft-${uid}`)?.remove();
}

function teardownRx(uid) {
  const ctx = rxAudio.get(uid);
  if (!ctx) return;
  rxAudio.delete(uid);
  try { ctx.audio.pause(); } catch {}
  try { if (ctx.ms.readyState === 'open') ctx.ms.endOfStream(); } catch {}
  try { URL.revokeObjectURL(ctx.audio.src); } catch {}
}

function base64ToBytes(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
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
