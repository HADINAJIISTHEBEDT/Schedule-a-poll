const $ = (sel) => document.querySelector(sel);

const state = {
  searchResults: [],
  selectedChats: new Set(),
  selectedChatMeta: new Map(),
  options: ['', ''],
  chatFilter: 'all',
  connectionState: 'disconnected',
  hasSession: false,
  searching: false,
  lastSearchQuery: '',
  connectInFlight: false,
  qrDismissed: false,
};

const els = {
  statusDot: $('#statusDot'),
  statusText: $('#statusText'),
  connectBtn: $('#connectBtn'),
  qrOverlay: $('#qrOverlay'),
  qrImage: $('#qrImage'),
  qrLoading: $('#qrLoading'),
  closeQrBtn: $('#closeQrBtn'),
  question: $('#question'),
  optionsList: $('#optionsList'),
  addOptionBtn: $('#addOptionBtn'),
  allowMultiple: $('#allowMultiple'),
  repeatDaily: $('#repeatDaily'),
  chatSearch: $('#chatSearch'),
  chatSearchWrap: $('#chatSearchWrap'),
  chatList: $('#chatList'),
  qrPanel: $('#qrPanel'),
  qrInlineImage: $('#qrInlineImage'),
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
let lastQrUrl = null;
let statusPollTimer = null;

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

function renderChatCheckbox(chat, checked = false) {
  return `
    <label class="chat-item ${checked ? 'selected' : ''}" data-id="${chat.id}">
      <input type="checkbox" ${checked ? 'checked' : ''} />
      <div class="chat-item-box">
        <div class="chat-name">${escapeHtml(chat.name)}</div>
        <div class="chat-meta">${chat.isGroup ? 'Group' : 'Contact'}</div>
      </div>
    </label>`;
}

function setSearchDropdownOpen(open) {
  if (els.chatSearchWrap) {
    els.chatSearchWrap.classList.toggle('has-results', open);
  }
}

function renderChats() {
  const query = els.chatSearch.value.trim();
  const previousScroll = els.chatList?.scrollTop || 0;
  const preserveScroll = state.searchResults.length > 0 && query === state.lastSearchQuery;
  let html = '';
  const canSearchOffline = state.hasSession && query.length >= 1;

  if (state.connectionState !== 'ready' && !canSearchOffline) {
    setSearchDropdownOpen(false);
    const emptyMessage =
      state.connectionState === 'qr'
        ? 'Scan the QR code with your phone'
        : state.connectionState === 'authenticated' || state.connectionState === 'connecting'
          ? 'Syncing with WhatsApp...'
          : 'Connect WhatsApp first';
    html = `<p class="placeholder">${emptyMessage}</p>`;
    if (
      !state.qrDismissed &&
      lastQrUrl &&
      (state.connectionState === 'qr' || state.connectionState === 'connecting')
    ) {
      html += `<div class="qr-inline"><img src="${lastQrUrl}" alt="WhatsApp QR code" /></div>`;
    }
    els.chatList.innerHTML = html;
    updateSelectedCount();
    return;
  }

  if (query.length < 1) {
    setSearchDropdownOpen(false);
    els.chatList.innerHTML = '';
    updateSelectedCount();
    return;
  }

  setSearchDropdownOpen(true);

  if (state.searching) {
    html = `<p class="placeholder">Searching...</p>`;
    els.chatList.innerHTML = html;
    return;
  }

  if (!state.searchResults.length) {
    html = `<p class="placeholder">No match for "${escapeHtml(query)}"</p>`;
    els.chatList.innerHTML = html;
    updateSelectedCount();
    return;
  }

  html = state.searchResults
    .map((chat) => renderChatCheckbox(chat, state.selectedChats.has(chat.id)))
    .join('');

  els.chatList.innerHTML = html;
  if (preserveScroll && previousScroll > 0) {
    els.chatList.scrollTop = previousScroll;
  }
  updateSelectedCount();
}

function toggleChat(id, selected, chatMeta = null) {
  if (selected) {
    state.selectedChats.add(id);
    if (chatMeta) state.selectedChatMeta.set(id, chatMeta);
  } else {
    state.selectedChats.delete(id);
    state.selectedChatMeta.delete(id);
  }
  renderChats();
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

function showQrLoading() {
  if (state.qrDismissed) return;
  els.qrOverlay.classList.remove('hidden');
  if (els.qrLoading) els.qrLoading.classList.remove('hidden');
  if (els.qrImage) els.qrImage.classList.add('hidden');
  if (els.qrPanel) els.qrPanel.classList.remove('hidden');
}

function showQrOverlay(qr, { force = false } = {}) {
  if (!qr) return;
  lastQrUrl = qr;
  if (els.qrLoading) els.qrLoading.classList.add('hidden');
  els.qrImage.src = qr;
  els.qrImage.classList.remove('hidden');
  if (els.qrInlineImage) els.qrInlineImage.src = qr;
  if (!state.qrDismissed || force) {
    els.qrOverlay.classList.remove('hidden');
    if (els.qrPanel) els.qrPanel.classList.remove('hidden');
  }
}

function hideQrOverlay({ dismiss = false } = {}) {
  if (dismiss) state.qrDismissed = true;
  els.qrOverlay.classList.add('hidden');
  if (els.qrPanel) els.qrPanel.classList.add('hidden');
}

function openQrOverlay() {
  state.qrDismissed = false;
  els.qrOverlay.classList.remove('hidden');
  if (lastQrUrl) {
    if (els.qrLoading) els.qrLoading.classList.add('hidden');
    els.qrImage.src = lastQrUrl;
    els.qrImage.classList.remove('hidden');
    if (els.qrInlineImage) els.qrInlineImage.src = lastQrUrl;
    if (els.qrPanel) els.qrPanel.classList.remove('hidden');
  } else if (state.connectionState === 'connecting' || state.connectionState === 'authenticated') {
    showQrLoading();
  }
}

function applySavedLoginHint() {
  if (typeof getSavedWhatsAppLogin !== 'function') return;
  const saved = getSavedWhatsAppLogin();
  if (!saved.linked) return;
  const profile = saved.profile;
  const name = profile?.pushname || 'WhatsApp';
  if (state.connectionState === 'disconnected' || state.connectionState === 'connecting') {
    els.statusText.textContent = profile?.phone
      ? `Restoring ${name} (+${profile.phone})…`
      : `Restoring ${name}…`;
    els.statusDot.className = 'status-dot connecting';
  }
}

function updateConnectionUI({ state: connState, qr, connectedInfo, hasSession, restoring }) {
  const wasReady = state.connectionState === 'ready';
  state.connectionState = connState;
  state.hasSession = Boolean(hasSession);
  els.statusDot.className = `status-dot ${connState}`;

  const labels = {
    disconnected: 'Disconnected',
    connecting: 'Connecting...',
    qr: 'Scan QR Code',
    authenticated: 'Linked on phone — opening in app...',
    ready: connectedInfo ? `Connected as ${connectedInfo.pushname}` : 'Connected',
    auth_failure: 'Auth failed',
  };

  const isRestoring =
    restoring ||
    ((connState === 'connecting' || connState === 'authenticated') && hasSession && !qr);

  if (isRestoring) {
    const saved =
      typeof getSavedWhatsAppLogin === 'function' ? getSavedWhatsAppLogin() : { profile: null };
    if (connState === 'authenticated') {
      els.statusText.textContent = connectedInfo?.pushname
        ? `Linked as ${connectedInfo.pushname} — opening…`
        : saved.profile?.pushname
          ? `Linked as ${saved.profile.pushname} — opening…`
          : 'Linked on phone — opening in app...';
    } else {
      els.statusText.textContent = saved.profile?.pushname
        ? `Restoring ${saved.profile.pushname}…`
        : 'Restoring saved login...';
    }
  } else {
    els.statusText.textContent = labels[connState] || connState;
  }

  // Save login locally whenever WhatsApp is ready (server also keeps LocalAuth on disk)
  if (connState === 'ready' && typeof saveWhatsAppLogin === 'function') {
    saveWhatsAppLogin(connectedInfo);
  }
  if (connState === 'auth_failure' && typeof clearWhatsAppLogin === 'function') {
    clearWhatsAppLogin();
  }

  if (connState === 'qr' && qr) {
    showQrOverlay(qr);
    renderChats();
  } else if (connState === 'ready') {
    state.qrDismissed = false;
    hideQrOverlay();
    if (!wasReady) {
      const name = connectedInfo?.pushname || 'WhatsApp';
      showToast(`WhatsApp connected as ${name}`);
    }
  } else if (connState === 'connecting' || connState === 'authenticated') {
    if (isRestoring || connState === 'authenticated') {
      hideQrOverlay();
    } else if (!state.qrDismissed) {
      if (connState === 'connecting' && !qr && !lastQrUrl) {
        showQrLoading();
      } else if (lastQrUrl) {
        showQrOverlay(lastQrUrl);
      }
    }
  } else if (connState === 'disconnected' || connState === 'auth_failure') {
    state.qrDismissed = false;
    hideQrOverlay();
    lastQrUrl = null;
  }

  if (connState === 'ready') {
    els.connectBtn.textContent = 'Disconnect';
    renderChats();
  } else {
    els.connectBtn.textContent =
      connState === 'qr' ? 'Show QR Code' : connState === 'disconnected' ? 'Connect WhatsApp' : 'Connecting...';
    if (connState === 'disconnected') {
      state.searchResults = [];
      state.lastSearchQuery = '';
    }
    renderChats();
  }
}

async function fetchStatus() {
  try {
    const res = await apiFetch('/api/status');
    const data = await res.json();
    updateConnectionUI(data);
    if (data.state === 'connecting' || data.state === 'qr' || data.state === 'authenticated') {
      pollStatus(true);
    }
  } catch {
    updateConnectionUI({ state: 'disconnected' });
  }
}

async function connect() {
  if (state.connectInFlight) return;

  try {
    state.connectInFlight = true;
    els.connectBtn.disabled = true;
    els.connectBtn.textContent = 'Connecting...';

    const statusRes = await apiFetch('/api/status');
    const status = await readApiJson(statusRes);

    if (status.state === 'ready') {
      await apiFetch('/api/disconnect', { method: 'POST' });
      if (typeof clearWhatsAppLogin === 'function') clearWhatsAppLogin();
      state.searchResults = [];
      state.selectedChats.clear();
      state.selectedChatMeta.clear();
      state.lastSearchQuery = '';
      els.chatSearch.value = '';
      renderChats();
      showToast('Disconnected');
      return fetchStatus();
    }

    if (status.state === 'qr' && status.qr) {
      openQrOverlay();
      updateConnectionUI(status);
      showToast('Scan the QR code with your phone');
      pollStatus(true);
      return;
    }

    if (status.state === 'connecting' || status.state === 'authenticated') {
      if (state.qrDismissed) {
        pollStatus(true);
        return;
      }
    }

    state.qrDismissed = false;
    showQrLoading();
    updateConnectionUI({ state: 'connecting' });
    pollStatus(true);

    const stuckConnecting = status.state === 'connecting' && !status.qr;
    // Never reset/wipe the saved WhatsApp login here — only Disconnect clears it.
    // Force-retry is OK when stuck; reset would make users re-scan after every deploy.
    const connectRes = await apiFetch('/api/connect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ force: stuckConnecting, reset: false }),
    });
    let connectData = await readApiJson(connectRes);

    if (!connectRes.ok && /detached|session closed|target closed/i.test(connectData.error || '')) {
      const retryRes = await apiFetch('/api/connect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ force: true, reset: false }),
      });
      connectData = await readApiJson(retryRes);
      if (!retryRes.ok) {
        showToast(connectData.error || 'Failed to connect. Tap Connect again.', 'error');
        hideQrOverlay();
        return;
      }
    } else if (!connectRes.ok) {
      showToast(connectData.error || 'Failed to connect', 'error');
      hideQrOverlay();
      return;
    }

    updateConnectionUI(connectData);
    if (connectData.qr) {
      showToast('Scan the QR code');
    } else if (connectData.restoring) {
      showToast('Restoring saved WhatsApp login...');
    } else {
      showToast('Starting WhatsApp — QR will appear shortly');
    }
  } catch (err) {
    showToast(err.message || 'Could not reach server', 'error');
    updateConnectionUI({ state: 'disconnected' });
    hideQrOverlay();
  } finally {
    state.connectInFlight = false;
    els.connectBtn.disabled = false;
    if (state.connectionState !== 'ready') {
      els.connectBtn.textContent =
        state.connectionState === 'qr' ? 'Show QR Code' : 'Connect WhatsApp';
    }
  }
}

function pollStatus(fast = false) {
  if (statusPollTimer) clearInterval(statusPollTimer);

  const tick = async () => {
    try {
      const res = await apiFetch('/api/status');
      const data = await res.json();
      updateConnectionUI(data);
      const waiting =
        data.state === 'connecting' || data.state === 'qr' || data.state === 'authenticated';
      if (!waiting) {
        clearInterval(statusPollTimer);
        statusPollTimer = null;
      }
    } catch {
      // keep polling through transient network errors
    }
  };

  const interval = fast ? 500 : 1500;
  tick();
  statusPollTimer = setInterval(tick, interval);
}

async function searchChats(query) {
  const term = query.trim();
  if (term.length < 1) {
    state.searchResults = [];
    state.lastSearchQuery = '';
    renderChats();
    return;
  }

  // Allow search while reconnecting if a saved session exists (Firestore contact cache)
  if (state.connectionState !== 'ready' && !state.hasSession) {
    renderChats();
    return;
  }

  state.searching = true;
  state.lastSearchQuery = term;
  renderChats();

  try {
    const params = new URLSearchParams({ q: term, type: state.chatFilter });
    const res = await apiFetch(`/api/chats/search?${params}`);
    const data = await readApiJson(res);
    if (!res.ok) throw new Error(data?.error || 'Search failed');

    if (els.chatSearch.value.trim() === term) {
      state.searchResults = Array.isArray(data) ? data : [];
    }
  } catch (err) {
    if (els.chatSearch.value.trim() === term) {
      state.searchResults = [];
      const message = err.message || 'Search failed';
      showToast(
        /502|504|timed out|not ready|collections/i.test(message)
          ? 'Search failed — wait a moment and try again'
          : /JSON|Invalid response|Request failed/i.test(message)
            ? 'Search failed — try again in a few seconds'
            : message,
        'error'
      );
    }
  } finally {
    state.searching = false;
    renderChats();
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
        ${p.repeatDaily ? ' · <span class="repeat-badge">Repeats daily</span>' : ''}
        ${p.sentAt ? ` · Last sent: ${formatDate(p.sentAt)}` : ''}
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
  if (options.length > 12) return showToast('Maximum 12 options', 'error');
  const unique = new Set(options.map((o) => o.toLowerCase()));
  if (unique.size !== options.length) {
    return showToast('Each poll option must be unique', 'error');
  }
  if (options.some((o) => o.length > 100)) {
    return showToast('Each option must be 100 characters or less', 'error');
  }
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
    repeatDaily: els.repeatDaily.checked,
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
    const data = await readApiJson(res);
    if (!res.ok) throw new Error(data?.error || 'Failed to save poll');

    showToast(sendNow ? 'Poll is being sent naturally...' : 'Poll scheduled!');
    els.question.value = '';
    els.allowMultiple.checked = false;
    els.repeatDaily.checked = false;
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
  const item = e.target.closest('.chat-item');
  if (!item) return;

  const id = item.dataset.id;
  const name = item.querySelector('.chat-name')?.textContent || 'Unknown';
  const isGroup = item.querySelector('.chat-meta')?.textContent === 'Group';

  if (e.target.tagName !== 'INPUT') {
    const checkbox = item.querySelector('input');
    checkbox.checked = !checkbox.checked;
    toggleChat(id, checkbox.checked, { id, name, isGroup });
  }
});

els.chatList.addEventListener('change', (e) => {
  const item = e.target.closest('.chat-item');
  if (!item || e.target.tagName !== 'INPUT') return;
  const id = item.dataset.id;
  const name = item.querySelector('.chat-name')?.textContent || 'Unknown';
  const isGroup = item.querySelector('.chat-meta')?.textContent === 'Group';
  toggleChat(id, e.target.checked, { id, name, isGroup });
});

els.connectBtn.addEventListener('click', connect);
els.closeQrBtn.addEventListener('click', () => hideQrOverlay({ dismiss: true }));
els.addOptionBtn.addEventListener('click', () => {
  if (state.options.length >= 12) return showToast('Maximum 12 options', 'error');
  state.options.push('');
  renderOptions();
});

els.chatSearch.addEventListener('input', (e) => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    searchChats(e.target.value);
  }, 400);
});

document.querySelectorAll('.chat-filter').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.chat-filter').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    state.chatFilter = btn.dataset.filter;
    if (els.chatSearch.value.trim().length >= 1) {
      searchChats(els.chatSearch.value);
    } else {
      renderChats();
    }
  });
});
els.scheduleBtn.addEventListener('click', () => submitPoll(false));
els.sendNowBtn.addEventListener('click', () => submitPoll(true));
els.refreshPollsBtn.addEventListener('click', loadPolls);

function openServerSettings() {
  const base = getApiBase() || DEFAULT_API_BASE || 'https://schedule-a-poll.onrender.com';
  els.serverUrlInput.value = base;
  els.serverOverlay.classList.remove('hidden');
}

function closeServerSettings() {
  els.serverOverlay.classList.add('hidden');
}

function saveServerSettings() {
  const url = els.serverUrlInput.value.trim();
  if (!url || !/^https?:\/\//i.test(url)) {
    return showToast('Enter https://schedule-a-poll.onrender.com', 'error');
  }
  setApiBase(url);
  closeServerSettings();
  showToast('Server saved');
  bootstrapSession();
  loadPolls();
}

els.serverSettingsBtn.addEventListener('click', openServerSettings);
els.saveServerBtn.addEventListener('click', saveServerSettings);
els.closeServerBtn.addEventListener('click', closeServerSettings);

if (!isCapacitorApp()) {
  els.serverSettingsBtn.classList.add('hidden');
}

renderOptions();
setDefaultSchedule();
applySavedLoginHint();

async function bootstrapSession() {
  applySavedLoginHint();
  try {
    const res = await apiFetch('/api/status');
    const data = await readApiJson(res);
    updateConnectionUI(data);

    const saved =
      typeof getSavedWhatsAppLogin === 'function' ? getSavedWhatsAppLogin() : { linked: false };
    const waiting =
      data.state === 'connecting' || data.state === 'qr' || data.state === 'authenticated';

    if (waiting) {
      pollStatus(true);
      return;
    }

    // Auto-restore permanent WhatsApp login from server disk (+ localStorage hint)
    if (data.state !== 'ready' && (data.hasSession || saved.linked)) {
      updateConnectionUI({
        state: 'connecting',
        hasSession: true,
        restoring: true,
        connectedInfo: saved.profile || null,
      });
      try {
        const connectRes = await apiFetch('/api/connect', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ force: false, reset: false }),
        });
        const connectData = await readApiJson(connectRes);
        updateConnectionUI({ ...connectData, restoring: connectData.restoring ?? true });
        pollStatus(true);
        showToast('Restoring saved WhatsApp login…');
      } catch {
        // user can tap Connect
      }
    }
  } catch {
    applySavedLoginHint();
  }
}

if (isCapacitorApp()) {
  if (!getApiBase()) {
    openServerSettings();
  } else {
    bootstrapSession();
    if (typeof window.initFirebaseRealtime === 'function') {
      window.initFirebaseRealtime(renderPolls);
    } else {
      loadPolls();
    }
  }
} else {
  bootstrapSession();
  if (typeof window.initFirebaseRealtime === 'function') {
    window.initFirebaseRealtime(renderPolls);
  } else {
    loadPolls();
  }
}

setInterval(() => {
  if (document.hidden) return;
  fetchStatus();
}, 30000);

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) {
    fetchStatus();
    if (typeof window.initFirebaseRealtime !== 'function') {
      loadPolls();
    }
  }
});
