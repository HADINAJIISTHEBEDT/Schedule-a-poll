const $ = (s) => document.querySelector(s);
const PAGE = 50;

const state = {
  chats: [],
  selected: new Set(),
  options: ['', ''],
  filter: 'all',
  visible: PAGE,
  conn: 'disconnected',
  loading: false,
};

let pollTimer = null;

const els = {
  statusDot: $('#statusDot'),
  statusText: $('#statusText'),
  connectBtn: $('#connectBtn'),
  qrOverlay: $('#qrOverlay'),
  qrImage: $('#qrImage'),
  closeQrBtn: $('#closeQrBtn'),
  question: $('#question'),
  optionsList: $('#optionsList'),
  addOptionBtn: $('#addOptionBtn'),
  allowMultiple: $('#allowMultiple'),
  chatSearch: $('#chatSearch'),
  chatList: $('#chatList'),
  chatSummary: $('#chatSummary'),
  refreshChatsBtn: $('#refreshChatsBtn'),
  selectedCount: $('#selectedCount'),
  scheduledAt: $('#scheduledAt'),
  delayMin: $('#delayMin'),
  delayMax: $('#delayMax'),
  scheduleBtn: $('#scheduleBtn'),
  sendNowBtn: $('#sendNowBtn'),
  pollsList: $('#pollsList'),
  refreshPollsBtn: $('#refreshPollsBtn'),
  toast: $('#toast'),
};

function esc(s) {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

function safeId(id) {
  return 'id-' + String(id).replace(/[^a-zA-Z0-9]/g, '_');
}

function toast(msg, type = 'success') {
  els.toast.textContent = msg;
  els.toast.className = `toast ${type}`;
  els.toast.classList.remove('hidden');
  setTimeout(() => els.toast.classList.add('hidden'), 3500);
}

function filteredChats(term = '') {
  const q = term.toLowerCase();
  return state.chats.filter((c) => {
    if (q && !c.name.toLowerCase().includes(q)) return false;
    if (state.filter === 'groups') return c.isGroup;
    if (state.filter === 'chats') return !c.isGroup;
    return true;
  });
}

function renderChats(term = '') {
  const list = filteredChats(term);
  const groups = list.filter((c) => c.isGroup);
  const dms = list.filter((c) => !c.isGroup);

  if (state.chats.length) {
    els.chatSummary.textContent = `${groups.length} groups · ${dms.length} chats`;
  } else {
    els.chatSummary.textContent = state.loading ? 'Loading...' : 'Connect WhatsApp to load chats';
  }

  if (!list.length) {
    const msg = state.chats.length
      ? 'No matches'
      : state.conn === 'ready'
        ? 'Tap Refresh to load chats'
        : state.conn === 'qr'
          ? 'Scan the QR code first'
          : 'Click Connect WhatsApp';
    els.chatList.innerHTML = `<p class="placeholder">${msg}</p>`;
    return;
  }

  const ordered = state.filter === 'all' ? [...groups, ...dms] : list;
  const shown = ordered.slice(0, state.visible);

  const item = (c) => {
    const id = safeId(c.id);
    const sel = state.selected.has(c.id);
    const attrId = c.id.replace(/"/g, '&quot;');
    return `<div class="chat-item${sel ? ' selected' : ''}" data-id="${attrId}">
      <input type="checkbox" class="chat-check" id="${id}" ${sel ? 'checked' : ''} />
      <label for="${id}"><span class="chat-name">${esc(c.name)}</span>
      <span class="chat-meta">${c.isGroup ? 'Group' : 'Chat'}</span></label>
    </div>`;
  };

  let html = '';
  if (state.filter === 'all' && !term) {
    const sg = shown.filter((c) => c.isGroup);
    const sd = shown.filter((c) => !c.isGroup);
    if (sg.length) html += `<div class="section-label">Groups (${groups.length})</div>` + sg.map(item).join('');
    if (sd.length) html += `<div class="section-label">Chats (${dms.length})</div>` + sd.map(item).join('');
    if (!html) html = shown.map(item).join('');
  } else {
    html = shown.map(item).join('');
  }

  if (ordered.length > state.visible) {
    const left = ordered.length - state.visible;
    html += `<button type="button" class="btn btn-ghost btn-sm load-more">Show ${Math.min(left, PAGE)} more (${left} left)</button>`;
  }

  els.chatList.innerHTML = html;
  els.selectedCount.textContent = `${state.selected.size} chat${state.selected.size !== 1 ? 's' : ''} selected`;
}

function scrollToChats() {
  document.getElementById('chatSelectSection')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function setConn(data) {
  const wasReady = state.conn === 'ready';
  state.conn = data.state;

  const labels = {
    disconnected: 'Disconnected',
    connecting: 'Connecting...',
    qr: 'Scan QR Code',
    authenticated: 'Authenticating...',
    ready: data.connectedInfo ? `Connected as ${data.connectedInfo.pushname}` : 'Connected',
    auth_failure: 'Auth failed',
  };
  els.statusDot.className = `status-dot ${data.state}`;
  els.statusText.textContent = labels[data.state] || data.state;

  if (data.state === 'qr' && data.qr) {
    els.qrImage.src = data.qr;
    els.qrOverlay.classList.remove('hidden');
    els.connectBtn.textContent = 'Show QR Code';
  } else if (data.state === 'ready') {
    els.qrOverlay.classList.add('hidden');
    els.connectBtn.textContent = 'Disconnect';
    if (!wasReady) loadChats(true);
    else renderChats(els.chatSearch.value);
  } else {
    els.connectBtn.textContent = data.state === 'disconnected' ? 'Connect WhatsApp' : 'Connecting...';
    if (data.state === 'disconnected') {
      state.chats = [];
      state.selected.clear();
      els.qrOverlay.classList.add('hidden');
      renderChats();
    }
  }
}

async function getStatus() {
  try {
    const data = await (await apiFetch('/api/status')).json();
    setConn(data);
    if (['connecting', 'qr', 'authenticated'].includes(data.state)) startPoll();
  } catch {
    setConn({ state: 'disconnected' });
  }
}

function startPoll() {
  if (pollTimer) clearInterval(pollTimer);
  const tick = async () => {
    try {
      const data = await (await apiFetch('/api/status')).json();
      setConn(data);
      if (['ready', 'disconnected', 'auth_failure'].includes(data.state)) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
    } catch {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  };
  tick();
  pollTimer = setInterval(tick, 1000);
}

async function toggleConnect() {
  els.connectBtn.disabled = true;

  try {
    const data = await (await apiFetch('/api/status')).json();

    if (data.state === 'ready') {
      await apiFetch('/api/disconnect', { method: 'POST' });
      state.chats = [];
      state.selected.clear();
      toast('Disconnected — scan QR to connect again');
      return getStatus();
    }

    if (data.state === 'qr' && data.qr) {
      setConn(data);
      startPoll();
      return;
    }

    els.statusText.textContent = 'Connecting...';
    const res = await apiFetch('/api/connect', { method: 'POST' });
    const body = await res.json();
    if (!res.ok) {
      toast(body.error || 'Connect failed', 'error');
      return getStatus();
    }
    setConn(body);
    if (body.qr) {
      toast('Scan the QR code with your phone');
    } else if (body.state === 'ready') {
      toast('Connected');
    } else {
      toast('Waiting for QR code...');
    }
    startPoll();
  } finally {
    els.connectBtn.disabled = false;
  }
}

async function loadChats(refresh = false, attempt = 1) {
  if (state.loading && attempt === 1) return;
  state.loading = true;
  state.visible = PAGE;
  els.chatList.innerHTML = '<p class="placeholder">Loading chats...</p>';

  try {
    const url = refresh || attempt > 1 ? '/api/chats?refresh=1' : '/api/chats';
    const res = await apiFetch(url);
    if (!res.ok) throw new Error((await res.json()).error || 'Failed');
    state.chats = await res.json();
    renderChats(els.chatSearch.value);
    scrollToChats();

    if (!state.chats.length && state.conn === 'ready' && attempt < 6) {
      els.chatList.innerHTML = `<p class="placeholder">Syncing chats... (${attempt}/6)</p>`;
      await new Promise((r) => setTimeout(r, 3000));
      state.loading = false;
      return loadChats(true, attempt + 1);
    }

    if (!state.chats.length && state.conn === 'ready') {
      els.chatList.innerHTML = '<p class="placeholder">No chats found — tap Refresh</p>';
    }
  } catch (e) {
    if (state.conn === 'ready' && attempt < 6) {
      els.chatList.innerHTML = `<p class="placeholder">Syncing chats... (${attempt}/6)</p>`;
      await new Promise((r) => setTimeout(r, 3000));
      state.loading = false;
      return loadChats(true, attempt + 1);
    }
    els.chatList.innerHTML = '<p class="placeholder">Failed — tap Refresh</p>';
    toast(e.message, 'error');
  } finally {
    state.loading = false;
  }
}

function renderOptions() {
  els.optionsList.innerHTML = state.options
    .map(
      (o, i) => `<div class="option-row">
      <input type="text" value="${esc(o)}" data-i="${i}" placeholder="Option ${i + 1}" maxlength="100" />
      ${state.options.length > 2 ? `<button type="button" class="remove-opt" data-i="${i}">×</button>` : ''}
    </div>`
    )
    .join('');

  els.optionsList.querySelectorAll('input').forEach((inp) => {
    inp.oninput = () => { state.options[+inp.dataset.i] = inp.value; };
  });
  els.optionsList.querySelectorAll('.remove-opt').forEach((btn) => {
    btn.onclick = () => { state.options.splice(+btn.dataset.i, 1); renderOptions(); };
  });
}

async function loadPolls() {
  try {
    const polls = await (await apiFetch('/api/polls')).json();
    if (!polls.length) {
      els.pollsList.innerHTML = '<p class="placeholder">No polls yet</p>';
      return;
    }
    els.pollsList.innerHTML = polls
      .map(
        (p) => `<div class="poll-card">
        <div class="poll-q">${esc(p.question)}</div>
        <div class="poll-meta">${p.chatIds.length} chats · ${new Date(p.scheduledAt).toLocaleString()}</div>
        <span class="badge ${p.status}">${p.status}</span>
        ${p.status === 'pending' ? `<button class="btn btn-sm send-now" data-id="${p.id}">Send now</button>` : ''}
      </div>`
      )
      .join('');
    els.pollsList.querySelectorAll('.send-now').forEach((b) => {
      b.onclick = async () => {
        const r = await apiFetch(`/api/polls/${b.dataset.id}/send-now`, { method: 'POST' });
        if (r.ok) { toast('Sent!'); loadPolls(); } else toast((await r.json()).error, 'error');
      };
    });
  } catch {
    els.pollsList.innerHTML = '<p class="placeholder">Failed to load</p>';
  }
}

async function submitPoll(now = false) {
  const question = els.question.value.trim();
  const options = state.options.map((o) => o.trim()).filter(Boolean);
  const chatIds = [...state.selected];
  if (!question) return toast('Enter a question', 'error');
  if (options.length < 2) return toast('Need 2+ options', 'error');
  if (!chatIds.length) return toast('Select at least one chat', 'error');

  const scheduledAt = now ? null : new Date(els.scheduledAt.value).toISOString();
  if (!now && (!scheduledAt || Number.isNaN(Date.parse(scheduledAt)))) {
    return toast('Pick a valid time', 'error');
  }

  const res = await apiFetch('/api/polls', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      question,
      options,
      chatIds,
      allowMultiple: els.allowMultiple.checked,
      scheduledAt,
      humanDelayMin: +els.delayMin.value,
      humanDelayMax: +els.delayMax.value,
      sendNow: now,
    }),
  });
  const body = await res.json();
  if (!res.ok) return toast(body.error, 'error');
  toast(now ? 'Sending...' : 'Scheduled!');
  els.question.value = '';
  state.options = ['', ''];
  renderOptions();
  loadPolls();
}

// Events
els.connectBtn.onclick = toggleConnect;
els.closeQrBtn.onclick = () => els.qrOverlay.classList.add('hidden');
els.addOptionBtn.onclick = () => {
  if (state.options.length >= 12) return toast('Max 12 options', 'error');
  state.options.push('');
  renderOptions();
};
els.chatSearch.oninput = () => { state.visible = PAGE; renderChats(els.chatSearch.value); };
els.refreshChatsBtn.onclick = () => loadChats(true);
els.scheduleBtn.onclick = () => submitPoll(false);
els.sendNowBtn.onclick = () => submitPoll(true);
els.refreshPollsBtn.onclick = loadPolls;

els.chatList.onclick = (e) => {
  if (e.target.closest('.load-more')) {
    state.visible += PAGE;
    renderChats(els.chatSearch.value);
    return;
  }
  const row = e.target.closest('.chat-item');
  if (!row) return;
  const chatId = row.getAttribute('data-id');
  const cb = row.querySelector('.chat-check');
  if (!cb || !chatId) return;
  if (e.target !== cb) cb.checked = !cb.checked;
  if (cb.checked) state.selected.add(chatId);
  else state.selected.delete(chatId);
  row.classList.toggle('selected', cb.checked);
  els.selectedCount.textContent = `${state.selected.size} chat${state.selected.size !== 1 ? 's' : ''} selected`;
};

els.chatList.addEventListener('change', (e) => {
  if (!e.target.classList.contains('chat-check')) return;
  const row = e.target.closest('.chat-item');
  if (!row) return;
  const chatId = row.getAttribute('data-id');
  if (!chatId) return;
  if (e.target.checked) state.selected.add(chatId);
  else state.selected.delete(chatId);
  row.classList.toggle('selected', e.target.checked);
  els.selectedCount.textContent = `${state.selected.size} chat${state.selected.size !== 1 ? 's' : ''} selected`;
});

document.querySelectorAll('.chat-filter').forEach((btn) => {
  btn.onclick = () => {
    document.querySelectorAll('.chat-filter').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    state.filter = btn.dataset.filter;
    state.visible = PAGE;
    if (state.conn === 'ready' && !state.chats.length) loadChats(true);
    else renderChats(els.chatSearch.value);
  };
});

// Init
const sched = new Date();
sched.setMinutes(sched.getMinutes() + 30);
sched.setSeconds(0);
els.scheduledAt.value = sched.toISOString().slice(0, 16);
renderOptions();
getStatus();
loadPolls();
