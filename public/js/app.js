const $ = (s) => document.querySelector(s);
const PAGE = 50;

const state = {
  chats: [],
  visibleChats: [],
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

function toast(msg, type = 'success') {
  els.toast.textContent = msg;
  els.toast.className = `toast ${type}`;
  els.toast.classList.remove('hidden');
  setTimeout(() => els.toast.classList.add('hidden'), 4000);
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
    els.chatSummary.textContent = `${state.chats.length} contacts · ${groups.length} groups · ${dms.length} chats`;
  } else {
    els.chatSummary.textContent = state.loading ? 'Loading contacts...' : 'Connect WhatsApp to load contacts';
  }

  if (!list.length) {
    const msg = state.chats.length
      ? 'No matches for your search'
      : state.conn === 'ready'
        ? 'Loading contacts... tap Refresh if empty'
        : state.conn === 'qr'
          ? 'Scan the QR code first'
          : 'Click Connect WhatsApp above';
    els.chatList.innerHTML = `<p class="placeholder">${msg}</p>`;
    state.visibleChats = [];
    return;
  }

  const ordered = state.filter === 'all' ? [...groups, ...dms] : list;
  const shown = ordered.slice(0, state.visible);
  state.visibleChats = shown;

  let html = '';
  for (let i = 0; i < shown.length; i++) {
    const c = shown[i];
    const sel = state.selected.has(c.id);
    html += `<div class="chat-item${sel ? ' selected' : ''}" data-idx="${i}" role="button" tabindex="0">
      <span class="tick-box" aria-hidden="true">${sel ? '✓' : ''}</span>
      <div class="chat-info">
        <span class="chat-name">${esc(c.name)}</span>
        <span class="chat-meta">${c.isGroup ? 'Group' : 'Chat'}</span>
      </div>
    </div>`;
  }

  if (ordered.length > state.visible) {
    const left = ordered.length - state.visible;
    html += `<button type="button" class="btn btn-ghost btn-sm load-more">Show ${Math.min(left, PAGE)} more (${left} left)</button>`;
  }

  els.chatList.innerHTML = html;
  els.selectedCount.textContent = `${state.selected.size} contact${state.selected.size !== 1 ? 's' : ''} selected`;
}

function scrollToChats() {
  document.getElementById('chatSelectSection')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function toggleChatSelection(idx) {
  const chat = state.visibleChats[idx];
  if (!chat) return;
  if (state.selected.has(chat.id)) state.selected.delete(chat.id);
  else state.selected.add(chat.id);
  renderChats(els.chatSearch.value);
}

function setConn(data) {
  const wasReady = state.conn === 'ready';
  state.conn = data.state;

  const labels = {
    disconnected: 'Disconnected',
    connecting: 'Starting...',
    qr: 'Scan QR Code with phone',
    authenticated: 'QR scanned — syncing...',
    ready: data.connectedInfo ? `Connected as ${data.connectedInfo.pushname}` : 'Connected',
    auth_failure: 'Auth failed — try again',
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
    if (!wasReady) {
      toast(`Connected! Loading contacts...`);
      loadChats(true);
    } else {
      renderChats(els.chatSearch.value);
    }
  } else {
    els.connectBtn.textContent = data.state === 'disconnected' ? 'Connect WhatsApp' : 'Connecting...';
    if (data.state === 'disconnected') {
      state.chats = [];
      state.visibleChats = [];
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
    if (data.state === 'ready' && !state.chats.length && !state.loading) {
      loadChats(true);
    }
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
      els.statusText.textContent = 'Disconnecting...';
      await apiFetch('/api/disconnect', { method: 'POST' });
      state.chats = [];
      state.visibleChats = [];
      state.selected.clear();
      toast('Disconnected — you must scan QR to connect again');
      return getStatus();
    }

    if (data.state === 'qr' && data.qr) {
      setConn(data);
      startPoll();
      return;
    }

    els.statusText.textContent = 'Starting — QR will appear...';
    const res = await apiFetch('/api/connect', { method: 'POST' });
    const body = await res.json();

    if (!res.ok) {
      toast(body.error || 'Connect failed', 'error');
      return getStatus();
    }

    setConn(body);
    if (body.qr) {
      toast('Scan the QR code with WhatsApp → Linked Devices');
    } else if (body.state === 'ready') {
      toast('Connected without QR — if this is wrong, disconnect and try again', 'error');
    } else {
      toast('Waiting for QR code...');
    }
    startPoll();
  } finally {
    els.connectBtn.disabled = false;
  }
}

async function loadChats(refresh = false, attempt = 1) {
  if (state.conn !== 'ready') return;
  if (state.loading && attempt === 1) return;

  state.loading = true;
  state.visible = PAGE;
  els.chatList.innerHTML = `<p class="placeholder">Loading contacts... (${attempt})</p>`;

  try {
    const needsRefresh = refresh || attempt > 1;
    const url = `/api/chats?refresh=${needsRefresh ? 1 : 0}`;
    const res = await apiFetch(url);
    const body = await res.json();

    if (!res.ok) throw new Error(body.error || 'Failed to load contacts');

    state.chats = Array.isArray(body) ? body : [];
    renderChats(els.chatSearch.value);
    scrollToChats();

    if (state.chats.length > 0) {
      toast(`Loaded ${state.chats.length} contacts`);
      return;
    }

    if (attempt < 8) {
      await new Promise((r) => setTimeout(r, 4000));
      state.loading = false;
      return loadChats(true, attempt + 1);
    }

    els.chatList.innerHTML = '<p class="placeholder">No contacts found — tap Refresh or reconnect</p>';
    toast('No contacts loaded — try Refresh', 'error');
  } catch (e) {
    if (attempt < 8) {
      await new Promise((r) => setTimeout(r, 4000));
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
  if (!chatIds.length) return toast('Select at least one contact', 'error');

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

els.chatList.addEventListener('click', (e) => {
  if (e.target.closest('.load-more')) {
    state.visible += PAGE;
    renderChats(els.chatSearch.value);
    return;
  }
  const row = e.target.closest('.chat-item');
  if (!row) return;
  const idx = parseInt(row.dataset.idx, 10);
  if (Number.isNaN(idx)) return;
  toggleChatSelection(idx);
});

els.chatList.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' && e.key !== ' ') return;
  const row = e.target.closest('.chat-item');
  if (!row) return;
  e.preventDefault();
  const idx = parseInt(row.dataset.idx, 10);
  if (!Number.isNaN(idx)) toggleChatSelection(idx);
});

document.querySelectorAll('.chat-filter').forEach((btn) => {
  btn.onclick = () => {
    document.querySelectorAll('.chat-filter').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    state.filter = btn.dataset.filter;
    state.visible = PAGE;
    renderChats(els.chatSearch.value);
  };
});

const sched = new Date();
sched.setMinutes(sched.getMinutes() + 30);
sched.setSeconds(0);
els.scheduledAt.value = sched.toISOString().slice(0, 16);
renderOptions();
getStatus();
loadPolls();
