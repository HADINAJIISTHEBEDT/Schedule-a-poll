const { Client, LocalAuth, Poll } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const fs = require('fs');
const path = require('path');
const { humanLikeDelay, staggeredChatDelay, sleep, randomBetween } = require('./humanSend');

const CHROME_CANDIDATES = [
  process.env.PUPPETEER_EXECUTABLE_PATH,
  '/usr/local/bin/google-chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].filter(Boolean);

const SESSION_PATH = path.join(__dirname, '..', 'data', 'whatsapp-session');
const WEB_CACHE_PATH = path.join(__dirname, '..', 'data', 'wwebjs_cache');
const PINNED_WEB_VERSION = '2.3000.1017054665';

const PUPPETEER_ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
  '--disable-gpu',
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-extensions',
  '--disable-sync',
  '--disable-translate',
  '--mute-audio',
  '--disable-component-update',
  '--disable-features=IsolateOrigins,site-per-process,MemorySaverMode',
  '--disable-site-isolation-trials',
  '--memory-pressure-off',
  '--disable-background-timer-throttling',
  '--disable-renderer-backgrounding',
  '--disable-backgrounding-occluded-windows',
  '--no-zygote',
];

function isDetachedFrameError(err) {
  const message = String(err?.message || err || '');
  return /detached frame|frame was detached|session closed|target closed/i.test(message);
}

function resolveChromePath() {
  for (const candidate of CHROME_CANDIDATES) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return undefined;
}

let client = null;
let connectionState = 'disconnected';
let lastQr = null;
let lastQrDataUrl = null;
let connectedInfo = null;
let cachedChats = [];
let cachedContacts = null;
let chatsLoading = false;
let chatsCacheTime = 0;
let connectingSince = 0;
let initInProgress = false;
let warmupStarted = false;
let readyCheckTimer = null;
let keepaliveTimer = null;
const CHATS_CACHE_TTL = 5 * 60 * 1000;
const CONNECTING_TIMEOUT_MS = 45 * 1000;
const QR_TARGET_MS = 10000;

function stopKeepalive() {
  if (keepaliveTimer) {
    clearInterval(keepaliveTimer);
    keepaliveTimer = null;
  }
}

function startKeepalive(instance) {
  stopKeepalive();

  keepaliveTimer = setInterval(async () => {
    if (!instance || connectionState !== 'ready') {
      stopKeepalive();
      return;
    }

    try {
      const waState = await instance.getState();
      if (waState !== 'CONNECTED') {
        console.warn('WhatsApp session dropped:', waState);
        stopKeepalive();
        connectionState = 'disconnected';
        connectedInfo = null;
        const deadClient = client;
        client = null;
        resetWarmup();
        if (deadClient) {
          try {
            await deadClient.destroy();
          } catch {
            // ignore
          }
        }
        setTimeout(() => startConnection({ force: true }), 3000);
        return;
      }

      await instance.sendPresenceAvailable();
    } catch (err) {
      console.error('WhatsApp keepalive error:', err.message);
    }
  }, 25000);
}

function stopReadyCheck() {
  if (readyCheckTimer) {
    clearInterval(readyCheckTimer);
    readyCheckTimer = null;
  }
}

async function readConnectedInfo(instance) {
  try {
    if (instance.info?.pushname) {
      const info = instance.info;
      return {
        pushname: info.pushname,
        phone: info.wid?.user,
        platform: info.platform,
      };
    }
  } catch {
    // fall through to page evaluate
  }

  try {
    return await instance.pupPage.evaluate(() => {
      const conn = window.require('WAWebConnModel').Conn;
      const wid =
        window.require('WAWebUserPrefsMeUser').getMaybeMePnUser() ||
        window.require('WAWebUserPrefsMeUser').getMaybeMeLidUser();
      return {
        pushname: conn?.pushname || wid?.user || 'Connected',
        phone: wid?.user,
        platform: conn?.platform,
      };
    });
  } catch {
    return { pushname: 'Connected' };
  }
}

async function isClientFullyReady(instance) {
  if (!instance?.pupPage) return false;

  try {
    const waState = await instance.getState();
    if (waState !== 'CONNECTED') return false;

    return await instance.pupPage.evaluate(() => {
      if (typeof window.WWebJS === 'undefined') return false;
      try {
        const collections = window.require('WAWebCollections');
        return Boolean(collections?.Chat?.getModelsArray);
      } catch {
        return false;
      }
    });
  } catch {
    return false;
  }
}

async function tryFinalizeReady(instance) {
  if (!instance || connectionState === 'ready') return true;

  const fullyReady = await isClientFullyReady(instance);
  if (!fullyReady) return false;

  connectionState = 'ready';
  connectingSince = 0;
  lastQr = null;
  lastQrDataUrl = null;
  connectedInfo = await readConnectedInfo(instance);
  stopReadyCheck();
  startKeepalive(instance);
  emit('ready', connectedInfo);
  console.log('WhatsApp linked as', connectedInfo.pushname);
  fetchAndCacheChats({ refresh: false, includeContacts: true }).catch((err) => {
    console.error('Chat cache warmup failed:', err.message);
  });
  return true;
}

function startReadyCheck(instance) {
  stopReadyCheck();
  let attempts = 0;
  const maxAttempts = 180;

  const check = async () => {
    if (!instance || connectionState === 'ready' || connectionState === 'disconnected') {
      stopReadyCheck();
      return;
    }

    attempts++;
    await tryFinalizeReady(instance);

    if (attempts >= maxAttempts) {
      stopReadyCheck();
      console.warn('Ready check timed out after scan — still syncing');
    }
  };

  check();
  readyCheckTimer = setInterval(check, 1000);
}

function formatChat(chat) {
  const name = chat.name || chat.id?.user || chat.id?._serialized || 'Unknown chat';
  return {
    id: chat.id._serialized,
    name,
    isGroup: Boolean(chat.isGroup),
    unreadCount: chat.unreadCount || 0,
    lastMessage: chat.lastMessage?.body?.slice(0, 60) || '',
  };
}

function formatDirectChat(chat) {
  return {
    id: chat.id,
    name: chat.name || 'Unknown chat',
    isGroup: Boolean(chat.isGroup),
    unreadCount: chat.unreadCount || 0,
    lastMessage: chat.lastMessage || '',
  };
}

async function fetchChatsDirect({ includeContacts = false } = {}) {
  const result = await client.pupPage.evaluate((withContacts) => {
    const collections = window.require('WAWebCollections');
    const chats = collections.Chat.getModelsArray();
    const seen = new Set();
    const items = [];

    const addItem = (id, name, isGroup, isReadOnly) => {
      if (!id || seen.has(id) || isReadOnly) return;
      seen.add(id);
      items.push({ id, name, isGroup });
    };

    for (const chat of chats) {
      const id = chat.id?._serialized || String(chat.id);
      const name =
        chat.formattedTitle ||
        chat.name ||
        chat.contact?.pushname ||
        chat.contact?.name ||
        (id.includes('@') ? id.split('@')[0] : id) ||
        'Unknown';

      const isGroup = Boolean(chat.groupMetadata) || id.endsWith('@g.us');
      const isReadOnly = Boolean(chat.groupMetadata?.announce);
      addItem(id, name, isGroup, isReadOnly);
    }

    if (withContacts) {
      const contacts = collections.Contact?.getModelsArray?.() || [];
      for (const contact of contacts) {
        const id = contact.id?._serialized || String(contact.id);
        if (!id || id.endsWith('@g.us') || contact.isMe) continue;

        const name =
          contact.pushname ||
          contact.name ||
          contact.shortName ||
          (id.includes('@') ? id.split('@')[0] : id) ||
          'Unknown';

        addItem(id, name, false, false);
      }
    }

    return items;
  }, includeContacts);

  return result
    .map((chat) => ({
      id: chat.id,
      name: chat.name || 'Unknown chat',
      isGroup: Boolean(chat.isGroup),
    }))
    .sort((a, b) => {
      if (a.isGroup !== b.isGroup) return a.isGroup ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
}

function mergeChatLists(base, extra) {
  const seen = new Set(base.map((c) => c.id));
  const merged = [...base];
  for (const item of extra) {
    if (!seen.has(item.id)) {
      seen.add(item.id);
      merged.push(item);
    }
  }
  return merged.sort((a, b) => {
    if (a.isGroup !== b.isGroup) return a.isGroup ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

async function fetchAndCacheChats({ refresh = false, includeContacts = false } = {}) {
  if (!client || connectionState !== 'ready') {
    throw new Error('WhatsApp is not connected');
  }

  const cacheValid =
    !refresh &&
    cachedChats.length > 0 &&
    Date.now() - chatsCacheTime < CHATS_CACHE_TTL &&
    (!includeContacts || cachedContacts);

  if (cacheValid) {
    return includeContacts ? mergeChatLists(cachedChats, cachedContacts) : cachedChats;
  }

  let lastError = null;

  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const chats = await fetchChatsDirect({ includeContacts: false });
      cachedChats = chats;
      chatsCacheTime = Date.now();

      if (includeContacts) {
        cachedContacts = (await fetchChatsDirect({ includeContacts: true })).filter((c) => !c.isGroup);
        return mergeChatLists(cachedChats, cachedContacts);
      }

      return cachedChats;
    } catch (err) {
      lastError = err;
      console.error(`Chat fetch attempt ${attempt}/4 failed:`, err.message);
    }

    if (attempt < 4) {
      await new Promise((r) => setTimeout(r, 1500 * attempt));
    }
  }

  if (cachedChats.length > 0) {
    return includeContacts && cachedContacts
      ? mergeChatLists(cachedChats, cachedContacts)
      : cachedChats;
  }

  throw lastError || new Error('Failed to load chats. Try clicking Refresh.');
}

const eventListeners = {
  qr: [],
  ready: [],
  disconnected: [],
  auth_failure: [],
};

function on(event, handler) {
  if (eventListeners[event]) {
    eventListeners[event].push(handler);
  }
}

function emit(event, data) {
  if (eventListeners[event]) {
    eventListeners[event].forEach((handler) => handler(data));
  }
}

function getStatus() {
  if (connectionState === 'authenticated' && client) {
    tryFinalizeReady(client).catch(() => {});
  }
  return {
    state: connectionState,
    qr: lastQrDataUrl,
    connectedInfo,
  };
}

function clearSessionData() {
  if (fs.existsSync(SESSION_PATH)) {
    fs.rmSync(SESSION_PATH, { recursive: true, force: true });
  }
}

function clearBrowserLocks() {
  const lockFiles = ['SingletonLock', 'SingletonSocket', 'SingletonCookie'];
  for (const file of lockFiles) {
    const lockPath = path.join(SESSION_PATH, 'session', file);
    if (fs.existsSync(lockPath)) {
      try {
        fs.rmSync(lockPath, { force: true });
      } catch {
        // ignore
      }
    }
  }
}

function createClient() {
  const chromePath = resolveChromePath();
  if (!chromePath) {
    console.warn('No Chrome/Chromium binary found — Puppeteer will use its bundled browser');
  }

  const instance = new Client({
    authStrategy: new LocalAuth({
      dataPath: SESSION_PATH,
    }),
    takeoverOnConflict: true,
    takeoverTimeoutMs: 5000,
    deviceName: 'Poll Scheduler',
    browserName: 'Chrome',
    authTimeoutMs: 120000,
    webVersion: PINNED_WEB_VERSION,
    webVersionCache: {
      type: 'local',
      path: WEB_CACHE_PATH,
      strict: false,
    },
    puppeteer: {
      headless: true,
      executablePath: chromePath,
      protocolTimeout: 60000,
      args: PUPPETEER_ARGS,
    },
  });

  instance.on('qr', async (qr) => {
    try {
      connectionState = 'qr';
      connectingSince = 0;
      lastQr = qr;
      lastQrDataUrl = await qrcode.toDataURL(qr, {
        errorCorrectionLevel: 'M',
        margin: 1,
        scale: 5,
      });
      emit('qr', lastQrDataUrl);
    } catch (err) {
      console.error('QR handler error:', err.message);
    }
  });

  instance.on('authenticated', () => {
    connectionState = 'authenticated';
    lastQr = null;
    lastQrDataUrl = null;
    startReadyCheck(instance);
    instance.sendPresenceAvailable().catch(() => {});
  });

  instance.on('loading_screen', (percent) => {
    if (percent >= 99) {
      setTimeout(() => tryFinalizeReady(instance), 1500);
    }
  });

  instance.on('ready', async () => {
    stopReadyCheck();
    connectionState = 'ready';
    connectingSince = 0;
    lastQr = null;
    lastQrDataUrl = null;

    try {
      const info = instance.info;
      connectedInfo = {
        pushname: info.pushname,
        phone: info.wid?.user,
        platform: info.platform,
      };
    } catch {
      connectedInfo = { pushname: 'Connected' };
    }

    startKeepalive(instance);
    emit('ready', connectedInfo);
    fetchAndCacheChats({ refresh: false, includeContacts: true }).catch((err) => {
      console.error('Chat cache warmup failed:', err.message);
    });
  });

  instance.on('change_state', (state) => {
    console.log('WhatsApp state:', state);
    if (state === 'CONNECTED' && connectionState === 'authenticated') {
      tryFinalizeReady(instance).catch(() => {});
    }
  });

  instance.on('disconnected', (reason) => {
    stopReadyCheck();
    stopKeepalive();
    connectionState = 'disconnected';
    connectedInfo = null;
    client = null;
    connectingSince = 0;
    resetWarmup();
    emit('disconnected', reason);

    if (reason !== 'LOGOUT') {
      console.log('WhatsApp disconnected, reconnecting in 5s:', reason);
      setTimeout(() => startConnection({ force: true }), 5000);
    }
  });

  instance.on('auth_failure', (msg) => {
    stopReadyCheck();
    connectionState = 'auth_failure';
    connectingSince = 0;
    emit('auth_failure', msg);
  });

  return instance;
}

async function initialize({ force = false, resetSession = false } = {}) {
  const connectingTimedOut =
    connectionState === 'connecting' &&
    connectingSince > 0 &&
    Date.now() - connectingSince > CONNECTING_TIMEOUT_MS;

  if (client && !force && !connectingTimedOut && !resetSession) {
    if (connectionState === 'ready') return;
    if (connectionState === 'qr' && lastQrDataUrl) return;
    if (connectionState === 'authenticated') return;
    if (connectionState === 'connecting') return;
  }

  if (resetSession) {
    clearSessionData();
  } else if (client) {
    clearBrowserLocks();
  }

  connectionState = 'connecting';
  connectingSince = Date.now();

  if (client) {
    await disconnect({ preserveState: true });
  }

  let lastError = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    client = createClient();

    try {
      await client.initialize();
      return;
    } catch (err) {
      lastError = err;
      console.error(`WhatsApp init attempt ${attempt}/2 failed:`, err.message);
      if (client) {
        await disconnect({ preserveState: true });
      }

      if (!isDetachedFrameError(err) || attempt === 2) {
        break;
      }

      if (attempt === 1) {
        clearSessionData();
      }

      await sleep(500);
    }
  }

  connectionState = 'disconnected';
  connectingSince = 0;
  client = null;

  const message = isDetachedFrameError(lastError)
    ? 'Browser connection failed. Tap Connect again — it will retry automatically.'
    : lastError?.message || 'Failed to start WhatsApp connection';

  throw new Error(message);
}

async function disconnect({ preserveState = false } = {}) {
  stopReadyCheck();
  stopKeepalive();
  if (client) {
    try {
      await client.destroy();
    } catch (err) {
      console.error('WhatsApp disconnect error:', err.message);
    }
    client = null;
  }
  clearBrowserLocks();
  if (!preserveState) {
    connectionState = 'disconnected';
    connectingSince = 0;
    lastQr = null;
    lastQrDataUrl = null;
    resetWarmup();
  }
  connectedInfo = null;
  cachedChats = [];
  cachedContacts = null;
  chatsCacheTime = 0;
}

async function searchChats({ query = '', filter = 'all', includeContacts = true } = {}) {
  if (!client || connectionState !== 'ready') {
    throw new Error('WhatsApp is not connected');
  }

  const fullyReady = await isClientFullyReady(client);
  if (!fullyReady) {
    throw new Error('WhatsApp is still syncing — wait a few seconds and try again');
  }

  const term = query.trim().toLowerCase();
  if (term.length < 1) {
    return [];
  }

  try {
    if (cachedChats.length === 0) {
      await fetchAndCacheChats({ refresh: false, includeContacts: false });
    }

    if (includeContacts && !cachedContacts) {
      try {
        cachedContacts = (await fetchChatsDirect({ includeContacts: true })).filter((c) => !c.isGroup);
      } catch (err) {
        console.error('Contact search load failed:', err.message);
      }
    }
  } catch (err) {
    throw new Error(err.message || 'Could not load chats for search');
  }

  let pool = includeContacts && cachedContacts
    ? mergeChatLists(cachedChats, cachedContacts)
    : cachedChats;

  if (filter === 'groups') {
    pool = pool.filter((c) => c.isGroup);
  } else if (filter === 'contacts') {
    pool = pool.filter((c) => !c.isGroup);
  }

  return pool
    .filter((c) => c.name.toLowerCase().includes(term))
    .slice(0, 50);
}

async function getChats({ refresh = false, includeContacts = false } = {}) {
  if (!client || connectionState !== 'ready') {
    throw new Error('WhatsApp is not connected');
  }

  if (!refresh && cachedChats.length > 0) {
    if (!includeContacts) return cachedChats;
    if (cachedContacts) return mergeChatLists(cachedChats, cachedContacts);
  }

  if (chatsLoading) {
    await new Promise((resolve) => {
      const check = setInterval(() => {
        if (!chatsLoading) {
          clearInterval(check);
          resolve();
        }
      }, 200);
    });
    if (cachedChats.length > 0) return cachedChats;
  }

  chatsLoading = true;
  try {
    return await fetchAndCacheChats({ refresh, includeContacts });
  } finally {
    chatsLoading = false;
  }
}

async function sendPollToChats({
  question,
  options,
  chatIds,
  allowMultiple = false,
  humanDelayMin = 3,
  humanDelayMax = 12,
}) {
  if (!client || connectionState !== 'ready') {
    throw new Error('WhatsApp is not connected');
  }

  if (!options || options.length < 2) {
    throw new Error('A poll needs at least 2 options');
  }

  if (options.length > 12) {
    throw new Error('WhatsApp polls support up to 12 options');
  }

  const poll = new Poll(question, options, {
    allowMultipleAnswers: allowMultiple,
  });

  const results = [];

  for (let i = 0; i < chatIds.length; i++) {
    const chatId = chatIds[i];

    try {
      await staggeredChatDelay(i, {
        minSeconds: humanDelayMin,
        maxSeconds: humanDelayMax,
      });

      let chat = null;
      try {
        chat = await client.getChatById(chatId);
      } catch (err) {
        console.warn(`getChatById failed for ${chatId}:`, err.message);
      }

      if (chat) {
        await humanLikeDelay(chat, question, {
          minSeconds: humanDelayMin,
          maxSeconds: humanDelayMax,
        });
      } else {
        await sleep(randomBetween(humanDelayMin * 1000, humanDelayMax * 1000));
      }

      await client.sendMessage(chatId, poll, {
        sendSeen: false,
        waitUntilMsgSent: true,
      });

      results.push({ chatId, success: true });
    } catch (err) {
      results.push({ chatId, success: false, error: err.message });
    }
  }

  const failed = results.filter((r) => !r.success);
  if (failed.length === results.length) {
    throw new Error(failed.map((f) => f.error).join('; '));
  }

  return results;
}

function isReady() {
  return connectionState === 'ready' && client !== null;
}

function startConnection({ force = false, resetSession = false } = {}) {
  if (isReady()) return;

  const connectingTimedOut =
    connectionState === 'connecting' &&
    connectingSince > 0 &&
    Date.now() - connectingSince > CONNECTING_TIMEOUT_MS;

  const stuckWithoutQr =
    connectionState === 'connecting' &&
    connectingSince > 0 &&
    Date.now() - connectingSince > QR_TARGET_MS &&
    !lastQrDataUrl;

  const shouldForce = force || resetSession || connectingTimedOut || stuckWithoutQr;

  if (initInProgress && !shouldForce) return;
  if (connectionState === 'qr' && lastQrDataUrl && !shouldForce) return;

  initInProgress = true;
  connectionState = 'connecting';
  connectingSince = Date.now();

  initialize({ force: shouldForce, resetSession })
    .catch((err) => {
      console.error('WhatsApp connection failed:', err.message);
      if (connectionState === 'connecting' || connectionState === 'authenticated') {
        connectionState = 'disconnected';
        connectingSince = 0;
      }
    })
    .finally(() => {
      initInProgress = false;
    });
}

/** Start browser in background when page loads so QR is ready faster on Connect. */
function warmupConnection() {
  if (warmupStarted || isReady() || initInProgress) return;
  if (connectionState === 'qr' || connectionState === 'connecting' || connectionState === 'authenticated') {
    return;
  }
  warmupStarted = true;
  startConnection();
}

function resetWarmup() {
  warmupStarted = false;
}

module.exports = {
  initialize,
  startConnection,
  warmupConnection,
  disconnect,
  getStatus,
  getChats,
  searchChats,
  sendPollToChats,
  isReady,
  on,
};
