const $ = (sel) => document.querySelector(sel);

const state = {
  chats: [],
  selectedChats: new Set(),
  options: ['', ''],
  chatFilter: 'all',
};

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

function showToast(message, type = 'success') {
  els.toast.textContent = message;
  els.toast.className = `toast ${type}`;
  setTimeout(() => els.toast.classList.add('hidden'), 3500);
}

function renderOptions() {
  els.optionsList.innerHTML = state.options
    .map(
      (opt, i) => `
    <div class="option-row">
      <input type="text" value="${escapeHtml(opt)}" data-index="${i}" placeholder="Option ${i + 1}" maxlength="100" />
      ${state.options.length > 2 ? `<button type="button" class="remove-option" data-index="${i}">×</button>` : ''}
    </div>`
    )
    .join('');

  els.optionsList.querySelectorAll('input').forEach((input) => {
    input.addEventListener('input', (e) => {
      state.options[Number(e.target.dataset.index)] = e.target.value;
    });
  });

  els.optionsList.querySelectorAll('.remove-option').forEach((btn) => {
    btn.addEventListener('click', () => {
      const idx = Number(btn.dataset.index);
      state.options.splice(idx, 1);
      renderOptions();
    });
  });
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function renderChats(filter = '') {
  const term = filter.toLowerCase();
  let filtered = state.chats.filter((c) => c.name.toLowerCase().includes(term));

  if (state.chatFilter === 'groups') {
    filtered = filtered.filter((c) => c.isGroup);
  } else if (state.chatFilter === 'contacts') {
    filtered = filtered.filter((c) => !c.isGroup);
  }

  const groups = filtered.filter((c) => c.isGroup);
  const contacts = filtered.filter((c) => !c.isGroup);
  updateChatSummary(groups.length, contacts.length);

  if (filtered.length === 0) {
    els.chatList.innerHTML = `<p class="placeholder">${state.chats.length ? 'No chats match your search' : 'Connect WhatsApp to load your chats'}</p>`;
    return;
  }

  const renderItem = (chat) => `
    <label class="chat-item ${state.selectedChats.has(chat.id) ? 'selected' : ''}" data-id="${chat.id}">
      <input type="checkbox" ${state.selectedChats.has(chat.id) ? 'checked' : ''} />
      <div>
        <div class="chat-name">${escapeHtml(chat.name)}</div>
        <div class="chat-meta">${chat.isGroup ? 'Group' : 'Contact'}</div>
      </div>
    </label>`;

  let html = '';

  if (state.chatFilter === 'all') {
    if (groups.length) {
      html += `<div class="chat-section-title">Groups (${groups.length})</div>`;
      html += groups.map(renderItem).join('');
    }
    if (contacts.length) {
      html += `<div class="chat-section-title">Contacts (${contacts.length})</div>`;
      html += contacts.map(renderItem).join('');
    }
  } else {
    html = filtered.map(renderItem).join('');
  }

  els.chatList.innerHTML = html;

  els.chatList.querySelectorAll('.chat-item').forEach((item) => {
    item.addEventListener('click', (e) => {
      if (e.target.tagName === 'INPUT') return;
      const id = item.dataset.id;
      const checkbox = item.querySelector('input');
      checkbox.checked = !checkbox.checked;
      toggleChat(id, checkbox.checked);
      item.classList.toggle('selected', checkbox.checked);
    });

    item.querySelector('input').addEventListener('change', (e) => {
      toggleChat(item.dataset.id, e.target.checked);
      item.classList.toggle('selected', e.target.checked);
    });
  });

  updateSelectedCount();
}

function updateChatSummary(groupCount, contactCount) {
  const totalGroups = state.chats.filter((c) => c.isGroup).length;
  const totalContacts = state.chats.filter((c) => !c.isGroup).length;
  els.chatSummary.textContent = `${totalGroups} groups · ${totalContacts} contacts available`;
}

function toggleChat(id, selected) {
  if (selected) state.selectedChats.add(id);
  else state.selectedChats.delete(id);
  updateSelectedCount();
}

function updateSelectedCount() {
  const n = state.selectedChats.size;
  els.selectedCount.textContent = `${n} chat${n !== 1 ? 's' : ''} selected`;
}

function setDefaultSchedule() {
  const now = new Date();
  now.setMinutes(now.getMinutes() + 30);
  now.setSeconds(0);
  els.scheduledAt.value = toLocalDatetime(now);
}

function toLocalDatetime(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

async function fetchStatus() {
  try {
    const res = await fetch('/api/status');
    const data = await res.json();
    updateConnectionUI(data);
  } catch {
    updateConnectionUI({ state: 'disconnected' });
  }
}

function updateConnectionUI({ state: connState, qr, connectedInfo }) {
  els.statusDot.className = `status-dot ${connState}`;

  const labels = {
    disconnected: 'Disconnected',
    connecting: 'Connecting...',
    qr: 'Scan QR Code',
    authenticated: 'Authenticating...',
    ready: connectedInfo ? `Connected as ${connectedInfo.pushname}` : 'Connected',
    auth_failure: 'Auth failed',
  };

  els.statusText.textContent = labels[connState] || connState;

  if (connState === 'qr' && qr) {
    els.qrImage.src = qr;
    els.qrOverlay.classList.remove('hidden');
  }

  if (connState === 'ready') {
    els.qrOverlay.classList.add('hidden');
    els.connectBtn.textContent = 'Disconnect';
    loadChats();
    setTimeout(() => {
      if (state.chats.length === 0) loadChats(true);
    }, 4000);
  } else {
    els.connectBtn.textContent = connState === 'disconnected' ? 'Connect WhatsApp' : 'Connecting...';
  }
}

async function connect() {
  const status = await fetch('/api/status').then((r) => r.json());

  if (status.state === 'ready') {
    await fetch('/api/disconnect', { method: 'POST' });
    state.chats = [];
    state.selectedChats.clear();
    renderChats();
    showToast('Disconnected');
    return fetchStatus();
  }

  await fetch('/api/connect', { method: 'POST' });
  showToast('Connecting — scan the QR code');
  pollStatus();
}

function pollStatus() {
  const interval = setInterval(async () => {
    const res = await fetch('/api/status');
    const data = await res.json();
    updateConnectionUI(data);
    if (data.state === 'ready' || data.state === 'disconnected' || data.state === 'auth_failure') {
      clearInterval(interval);
    }
  }, 2000);
}

async function loadChats(refresh = false) {
  els.chatList.innerHTML = '<p class="placeholder">Loading chats...</p>';
  try {
    const url = refresh ? '/api/chats?refresh=1' : '/api/chats';
    const res = await fetch(url);
    if (!res.ok) throw new Error((await res.json()).error || 'Failed to load chats');
    state.chats = await res.json();
    renderChats(els.chatSearch.value);
    if (state.chats.length === 0) {
      showToast('No chats found — try Refresh', 'error');
    }
  } catch (err) {
    els.chatList.innerHTML = `<p class="placeholder">Could not load chats. Click Refresh to try again.</p>`;
    showToast(err.message || 'Failed to load chats', 'error');
  }
}

async function loadPolls() {
  try {
    const res = await fetch('/api/polls');
    const polls = await res.json();
    renderPolls(polls);
  } catch {
    els.pollsList.innerHTML = '<p class="placeholder">Failed to load polls</p>';
  }
}

function renderPolls(polls) {
  if (!polls.length) {
    els.pollsList.innerHTML = '<p class="placeholder">No polls yet</p>';
    return;
  }

  els.pollsList.innerHTML = polls
    .map(
      (p) => `
    <div class="poll-card">
      <div class="poll-question">${escapeHtml(p.question)}</div>
      <div class="poll-meta">
        ${p.chatIds.length} chat(s) · Scheduled: ${formatDate(p.scheduledAt)}
        ${p.sentAt ? ` · Sent: ${formatDate(p.sentAt)}` : ''}
      </div>
      <div class="poll-options-preview">
        ${p.options.map((o) => `<span class="option-tag">${escapeHtml(o)}</span>`).join('')}
      </div>
      ${p.error ? `<div class="poll-meta" style="color:var(--danger)">${escapeHtml(p.error)}</div>` : ''}
      <div class="poll-footer">
        <span class="status-badge ${p.status}">${p.status}</span>
        <div class="poll-actions">
          ${p.status === 'pending' ? `<button class="btn btn-ghost btn-sm send-now" data-id="${p.id}">Send now</button>` : ''}
          ${p.status === 'pending' ? `<button class="btn btn-danger delete-poll" data-id="${p.id}">Delete</button>` : ''}
        </div>
      </div>
    </div>`
    )
    .join('');

  els.pollsList.querySelectorAll('.send-now').forEach((btn) => {
    btn.addEventListener('click', () => sendPollNow(btn.dataset.id));
  });

  els.pollsList.querySelectorAll('.delete-poll').forEach((btn) => {
    btn.addEventListener('click', () => deletePoll(btn.dataset.id));
  });
}

function formatDate(str) {
  if (!str) return '';
  const d = new Date(str);
  if (Number.isNaN(d.getTime())) return str;
  return d.toLocaleString();
}

async function submitPoll(sendNow = false) {
  const question = els.question.value.trim();
  const options = state.options.map((o) => o.trim()).filter(Boolean);
  const chatIds = [...state.selectedChats];
  const delayMin = Number(els.delayMin.value);
  const delayMax = Number(els.delayMax.value);

  if (!question) return showToast('Enter a poll question', 'error');
  if (options.length < 2) return showToast('Add at least 2 options', 'error');
  if (!chatIds.length) return showToast('Select at least one chat', 'error');
  if (delayMin > delayMax) return showToast('Min delay must be ≤ max delay', 'error');

  const scheduledAt = sendNow ? null : new Date(els.scheduledAt.value).toISOString();

  if (!sendNow && (!scheduledAt || Number.isNaN(new Date(scheduledAt).getTime()))) {
    return showToast('Pick a valid schedule time', 'error');
  }

  if (!sendNow && new Date(scheduledAt) <= new Date()) {
    return showToast('Schedule time must be in the future', 'error');
  }

  const body = {
    question,
    options,
    chatIds,
    allowMultiple: els.allowMultiple.checked,
    scheduledAt,
    humanDelayMin: delayMin,
    humanDelayMax: delayMax,
    sendNow,
  };

  try {
    const res = await fetch('/api/polls', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);

    showToast(sendNow ? 'Poll is being sent naturally...' : 'Poll scheduled!');
    els.question.value = '';
    state.options = ['', ''];
    renderOptions();
    loadPolls();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function sendPollNow(id) {
  try {
    const res = await fetch(`/api/polls/${id}/send-now`, { method: 'POST' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    showToast('Poll sent!');
    loadPolls();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function deletePoll(id) {
  try {
    const res = await fetch(`/api/polls/${id}`, { method: 'DELETE' });
    if (!res.ok) throw new Error((await res.json()).error);
    showToast('Poll deleted');
    loadPolls();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

els.connectBtn.addEventListener('click', connect);
els.closeQrBtn.addEventListener('click', () => els.qrOverlay.classList.add('hidden'));
els.addOptionBtn.addEventListener('click', () => {
  if (state.options.length >= 12) return showToast('Maximum 12 options', 'error');
  state.options.push('');
  renderOptions();
});
els.chatSearch.addEventListener('input', (e) => renderChats(e.target.value));
document.querySelectorAll('.chat-filter').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.chat-filter').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    state.chatFilter = btn.dataset.filter;
    renderChats(els.chatSearch.value);
  });
});
els.refreshChatsBtn.addEventListener('click', () => loadChats(true));
els.scheduleBtn.addEventListener('click', () => submitPoll(false));
els.sendNowBtn.addEventListener('click', () => submitPoll(true));
els.refreshPollsBtn.addEventListener('click', loadPolls);

renderOptions();
setDefaultSchedule();
fetchStatus();
loadPolls();
setInterval(fetchStatus, 10000);
setInterval(loadPolls, 15000);
