const $ = (sel) => document.querySelector(sel);

const PAGE_SIZE = 40;

const state = {
  chats: [],
  selectedChats: new Set(),
  options: ['', ''],
  chatFilter: 'all',
  visibleCount: PAGE_SIZE,
  contactsLoaded: false,
  chatsLoaded: false,
  connectionState: 'disconnected',
  loadingChats: false,
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
  serverSettingsBtn: $('#serverSettingsBtn'),
  serverOverlay: $('#serverOverlay'),
  serverUrlInput: $('#serverUrlInput'),
  saveServerBtn: $('#saveServerBtn'),
  closeServerBtn: $('#closeServerBtn'),
};

let searchTimer = null;
let chatCounts = { groups: 0, contacts: 0 };

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

function getFilteredChats(term = '') {
  const search = term.toLowerCase();
  let filtered = state.chats;

  if (search) {
    filtered = filtered.filter((c) => c.name.toLowerCase().includes(search));
  }

  if (state.chatFilter === 'groups') {
    filtered = filtered.filter((c) => c.isGroup);
  } else if (state.chatFilter === 'contacts') {
    filtered = filtered.filter((c) => !c.isGroup);
  }

  return filtered;
}

function renderChats(filter = '') {
  const filtered = getFilteredChats(filter);
  const groups = filtered.filter((c) => c.isGroup);
  const contacts = filtered.filter((c) => !c.isGroup);
  updateChatSummary();

  if (filtered.length === 0) {
    els.chatList.innerHTML = `<p class="placeholder">${state.chats.length ? 'No chats match your search' : 'Connect WhatsApp, then tap Load chats'}</p>`;
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

  let list = [];
  if (state.chatFilter === 'all') {
    list = [...groups, ...contacts];
  } else {
    list = filtered;
  }

  const visible = list.slice(0, state.visibleCount);
  let html = '';

  if (state.chatFilter === 'all' && !filter) {
    const visibleGroups = visible.filter((c) => c.isGroup);
    const visibleContacts = visible.filter((c) => !c.isGroup);
    if (visibleGroups.length) {
      html += `<div class="chat-section-title">Groups (${groups.length})</div>`;
      html += visibleGroups.map(renderItem).join('');
    }
    if (visibleContacts.length) {
      html += `<div class="chat-section-title">Contacts (${contacts.length})</div>`;
      html += visibleContacts.map(renderItem).join('');
    }
  } else {
    html = visible.map(renderItem).join('');
  }

  if (list.length > state.visibleCount) {
    const remaining = list.length - state.visibleCount;
    html += `<button type="button" class="btn btn-ghost btn-sm load-more-chats">Show ${Math.min(remaining, PAGE_SIZE)} more (${remaining} left)</button>`;
  }

  els.chatList.innerHTML = html;
  updateSelectedCount();
}

function updateChatSummary() {
  if (!state.chats.length) {
    els.chatSummary.textContent = state.loadingChats ? 'Loading...' : 'Tap Refresh to load chats';
    return;
  }
  els.chatSummary.textContent = `${chatCounts.groups} groups · ${chatCounts.contacts} contacts`;
}

function toggleChat(id, selected) {
  if (selected) state.selectedChats.add(id);
  else state.selectedChats.delete(id);
  updateSelectedCount();
  els.chatList.querySelectorAll(`.chat-item[data-id="${CSS.escape(id)}"]`).forEach((item) => {
    item.classList.toggle('selected', selected);
    const input = item.querySelector('input');
    if (input) input.checked = selected;
  });
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

function updateConnectionUI({ state: connState, qr, connectedInfo }) {
  const wasReady = state.connectionState === 'ready';
  state.connectionState = connState;
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
    if (!wasReady && !state.chatsLoaded && !state.loadingChats) {
      loadChats(false);
    }
  } else {
    els.connectBtn.textContent = connState === 'disconnected' ? 'Connect WhatsApp' : 'Connecting...';
    if (connState === 'disconnected') {
      state.chatsLoaded = false;
      state.contactsLoaded = false;
      state.chats = [];
      chatCounts = { groups: 0, contacts: 0 };
    }
  }
}

async function fetchStatus() {
  try {
    const res = await apiFetch('/api/status');
    const data = await res.json();
    updateConnectionUI(data);
  } catch {
    updateConnectionUI({ state: 'disconnected' });
  }
}

async function connect() {
  const status = await apiFetch('/api/status').then((r) => r.json());

  if (status.state === 'ready') {
    await apiFetch('/api/disconnect', { method: 'POST' });
    state.chats = [];
    state.selectedChats.clear();
    state.chatsLoaded = false;
    state.contactsLoaded = false;
    chatCounts = { groups: 0, contacts: 0 };
    renderChats();
    showToast('Disconnected');
    return fetchStatus();
  }

  await apiFetch('/api/connect', { method: 'POST' });
  showToast('Connecting — scan the QR code');
  pollStatus();
}

function pollStatus() {
  const interval = setInterval(async () => {
    const res = await apiFetch('/api/status');
    const data = await res.json();
    updateConnectionUI(data);
    if (data.state === 'ready' || data.state === 'disconnected' || data.state === 'auth_failure') {
      clearInterval(interval);
    }
  }, 3000);
}

function needsContacts() {
  return state.chatFilter === 'contacts' || state.chatFilter === 'all';
}

async function loadChats(refresh = false) {
  if (state.loadingChats) return;

  state.loadingChats = true;
  state.visibleCount = PAGE_SIZE;
  els.chatList.innerHTML = '<p class="placeholder">Loading chats...</p>';
  updateChatSummary();

  try {
    const params = new URLSearchParams();
    if (refresh) params.set('refresh', '1');
    if (refresh && needsContacts()) params.set('contacts', '1');

    const res = await apiFetch(`/api/chats?${params}`);
    if (!res.ok) throw new Error((await res.json()).error || 'Failed to load chats');

    state.chats = await res.json();
    state.chatsLoaded = true;
    state.contactsLoaded = refresh && needsContacts();
    chatCounts = {
      groups: state.chats.filter((c) => c.isGroup).length,
      contacts: state.chats.filter((c) => !c.isGroup).length,
    };
    renderChats(els.chatSearch.value);
  } catch (err) {
    els.chatList.innerHTML = '<p class="placeholder">Could not load chats. Tap Refresh to try again.</p>';
    showToast(err.message || 'Failed to load chats', 'error');
  } finally {
    state.loadingChats = false;
  }
}

async function ensureContactsLoaded() {
  if (state.contactsLoaded || state.loadingChats) return;
  state.loadingChats = true;
  try {
    const res = await apiFetch('/api/chats?contacts=1');
    if (!res.ok) throw new Error((await res.json()).error || 'Failed to load contacts');
    state.chats = await res.json();
    state.contactsLoaded = true;
    chatCounts = {
      groups: state.chats.filter((c) => c.isGroup).length,
      contacts: state.chats.filter((c) => !c.isGroup).length,
    };
    renderChats(els.chatSearch.value);
  } catch (err) {
    showToast(err.message || 'Failed to load contacts', 'error');
  } finally {
    state.loadingChats = false;
  }
}

async function loadPolls() {
  try {
    const res = await apiFetch('/api/polls');
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
    const res = await apiFetch('/api/polls', {
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
    const res = await apiFetch(`/api/polls/${id}/send-now`, { method: 'POST' });
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
    const res = await apiFetch(`/api/polls/${id}`, { method: 'DELETE' });
    if (!res.ok) throw new Error((await res.json()).error);
    showToast('Poll deleted');
    loadPolls();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

els.chatList.addEventListener('click', (e) => {
  const loadMore = e.target.closest('.load-more-chats');
  if (loadMore) {
    state.visibleCount += PAGE_SIZE;
    renderChats(els.chatSearch.value);
    return;
  }

  const item = e.target.closest('.chat-item');
  if (!item) return;

  if (e.target.tagName !== 'INPUT') {
    const checkbox = item.querySelector('input');
    checkbox.checked = !checkbox.checked;
    toggleChat(item.dataset.id, checkbox.checked);
  }
});

els.chatList.addEventListener('change', (e) => {
  const item = e.target.closest('.chat-item');
  if (!item || e.target.tagName !== 'INPUT') return;
  toggleChat(item.dataset.id, e.target.checked);
});

els.connectBtn.addEventListener('click', connect);
els.closeQrBtn.addEventListener('click', () => els.qrOverlay.classList.add('hidden'));
els.addOptionBtn.addEventListener('click', () => {
  if (state.options.length >= 12) return showToast('Maximum 12 options', 'error');
  state.options.push('');
  renderOptions();
});

els.chatSearch.addEventListener('input', (e) => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    state.visibleCount = PAGE_SIZE;
    renderChats(e.target.value);
  }, 250);
});

document.querySelectorAll('.chat-filter').forEach((btn) => {
  btn.addEventListener('click', async () => {
    document.querySelectorAll('.chat-filter').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    state.chatFilter = btn.dataset.filter;
    state.visibleCount = PAGE_SIZE;

    if (needsContacts() && state.chatsLoaded && !state.contactsLoaded) {
      await ensureContactsLoaded();
    } else if (!state.chatsLoaded && state.connectionState === 'ready') {
      await loadChats(false);
    } else {
      renderChats(els.chatSearch.value);
    }
  });
});

els.refreshChatsBtn.addEventListener('click', () => loadChats(true));
els.scheduleBtn.addEventListener('click', () => submitPoll(false));
els.sendNowBtn.addEventListener('click', () => submitPoll(true));
els.refreshPollsBtn.addEventListener('click', loadPolls);

function openServerSettings() {
  els.serverUrlInput.value = getApiBase() || 'http://';
  els.serverOverlay.classList.remove('hidden');
}

function closeServerSettings() {
  els.serverOverlay.classList.add('hidden');
}

function saveServerSettings() {
  const url = els.serverUrlInput.value.trim();
  if (!url || !/^https?:\/\//i.test(url)) {
    return showToast('Enter a valid URL like http://192.168.1.5:3000', 'error');
  }
  setApiBase(url);
  closeServerSettings();
  showToast('Server saved');
  fetchStatus();
  loadPolls();
}

els.serverSettingsBtn.addEventListener('click', openServerSettings);
els.saveServerBtn.addEventListener('click', saveServerSettings);
els.closeServerBtn.addEventListener('click', closeServerSettings);

renderOptions();
setDefaultSchedule();
if (isCapacitorApp() && !getApiBase()) {
  openServerSettings();
} else {
  fetchStatus();
  loadPolls();
}

setInterval(() => {
  if (document.hidden) return;
  fetchStatus();
}, 30000);

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) {
    fetchStatus();
    loadPolls();
  }
});
