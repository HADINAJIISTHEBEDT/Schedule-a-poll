const { Client, NoAuth, Poll } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const fs = require('fs');
const path = require('path');
const { humanLikeDelay, staggeredChatDelay, sleep, randomBetween } = require('./humanSend');

const SESSION_PATH = path.join(__dirname, '..', 'data', 'whatsapp-session');
const LEGACY_AUTH_PATH = path.join(__dirname, '..', '.wwebjs_auth');

const CHROME_PATHS = [
  process.env.PUPPETEER_EXECUTABLE_PATH,
  '/usr/bin/chromium',
  '/usr/local/bin/google-chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium-browser',
].filter(Boolean);

let client = null;
let connectionState = 'disconnected';
let lastQrDataUrl = null;
let connectedInfo = null;
let cachedChats = [];
let chatsLoading = false;
let chatsCacheTime = 0;
let initPromise = null;

function resolveChrome() {
  for (const p of CHROME_PATHS) {
    if (fs.existsSync(p)) return p;
  }
  return undefined;
}

function clearSession() {
  for (const dir of [SESSION_PATH, LEGACY_AUTH_PATH]) {
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
}

function getStatus() {
  return { state: connectionState, qr: lastQrDataUrl, connectedInfo };
}

function isReady() {
  return connectionState === 'ready' && client !== null;
}

function formatChat(chat) {
  const id = chat.id?._serialized || String(chat.id);
  const isGroup = Boolean(chat.isGroup);
  const name =
    chat.name ||
    chat.formattedTitle ||
    chat.contact?.pushname ||
    chat.contact?.name ||
    id.split('@')[0] ||
    'Unknown';
  return { id, name, isGroup };
}

async function fetchChatsFromWhatsApp() {
  const rawChats = await client.getChats();
  const seen = new Set();
  const result = [];

  for (const chat of rawChats) {
    const item = formatChat(chat);
    if (!item.id || seen.has(item.id)) continue;
    if (chat.isReadOnly) continue;
    seen.add(item.id);
    result.push(item);
  }

  if (result.length > 0) {
    return result.sort((a, b) => {
      if (a.isGroup !== b.isGroup) return a.isGroup ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
  }

  const items = await client.pupPage.evaluate(() => {
    const chats = window.require('WAWebCollections').Chat.getModelsArray();
    const seen = new Set();
    const out = [];

    for (const chat of chats) {
      const id = chat.id?._serialized || String(chat.id);
      if (!id || seen.has(id)) continue;
      seen.add(id);
      const isGroup = Boolean(chat.groupMetadata) || id.endsWith('@g.us');
      const name =
        chat.formattedTitle ||
        chat.name ||
        chat.contact?.pushname ||
        chat.contact?.name ||
        id.split('@')[0] ||
        'Unknown';
      out.push({ id, name, isGroup });
    }
    return out;
  });

  return items
    .map((c) => ({ id: c.id, name: c.name || 'Unknown', isGroup: Boolean(c.isGroup) }))
    .sort((a, b) => {
      if (a.isGroup !== b.isGroup) return a.isGroup ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
}

async function loadAndCacheChats() {
  if (!isReady()) throw new Error('WhatsApp is not connected');

  let lastError = null;
  for (let attempt = 1; attempt <= 8; attempt++) {
    try {
      await sleep(attempt === 1 ? 4000 : 2000 * attempt);
      const chats = await fetchChatsFromWhatsApp();
      if (chats.length > 0) {
        cachedChats = chats;
        chatsCacheTime = Date.now();
        console.log(`Loaded ${chats.length} chats (attempt ${attempt})`);
        return cachedChats;
      }
      console.log(`Chat load attempt ${attempt}: 0 chats, retrying...`);
    } catch (err) {
      lastError = err;
      console.error(`Chat load attempt ${attempt}/8:`, err.message);
    }
  }

  if (cachedChats.length > 0) return cachedChats;
  throw lastError || new Error('Chats not ready yet — tap Refresh');
}

async function getChats({ refresh = false } = {}) {
  if (!isReady()) throw new Error('WhatsApp is not connected');

  const cacheValid = !refresh && cachedChats.length > 0 && Date.now() - chatsCacheTime < 5 * 60 * 1000;
  if (cacheValid) return cachedChats;

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
    return await loadAndCacheChats();
  } finally {
    chatsLoading = false;
  }
}

function setupClientEvents() {
  client.on('qr', async (qr) => {
    connectionState = 'qr';
    lastQrDataUrl = await qrcode.toDataURL(qr);
    console.log('QR code ready');
  });

  client.on('authenticated', () => {
    connectionState = 'authenticated';
    lastQrDataUrl = null;
    console.log('Authenticated');
  });

  client.on('ready', () => {
    connectionState = 'ready';
    lastQrDataUrl = null;
    try {
      const info = client.info;
      connectedInfo = { pushname: info.pushname, phone: info.wid?.user };
    } catch {
      connectedInfo = { pushname: 'Connected' };
    }
    console.log(`WhatsApp ready as ${connectedInfo.pushname}`);
    loadAndCacheChats()
      .then((chats) => console.log(`Preloaded ${chats.length} chats`))
      .catch((err) => console.error('Chat preload failed:', err.message));
    listeners.ready.forEach((fn) => fn());
  });

  client.on('disconnected', () => {
    connectionState = 'disconnected';
    connectedInfo = null;
    client = null;
    cachedChats = [];
    chatsCacheTime = 0;
    lastQrDataUrl = null;
    initPromise = null;
  });

  client.on('auth_failure', () => {
    connectionState = 'auth_failure';
    lastQrDataUrl = null;
    initPromise = null;
  });
}

async function initialize() {
  if (initPromise) return initPromise;

  initPromise = (async () => {
    await disconnect();

    clearSession();

    lastQrDataUrl = null;
    connectedInfo = null;
    cachedChats = [];
    chatsCacheTime = 0;
    connectionState = 'connecting';

    client = new Client({
      authStrategy: new NoAuth(),
      webVersionCache: {
        type: 'remote',
        remotePath: 'https://raw.githubusercontent.com/wwebjs/whatsapp-web.js/main/web-version.json',
      },
      puppeteer: {
        headless: true,
        executablePath: resolveChrome(),
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
      },
    });

    setupClientEvents();
    await client.initialize();
  })();

  try {
    await initPromise;
  } catch (err) {
    initPromise = null;
    throw err;
  }
}

async function waitForQrOrReady(timeoutMs = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const status = getStatus();
    if (status.state === 'qr' && status.qr) return status;
    if (status.state === 'ready') return status;
    if (status.state === 'auth_failure' || status.state === 'disconnected') return status;
    await sleep(500);
  }
  return getStatus();
}

async function disconnect() {
  initPromise = null;

  if (client) {
    try { await client.destroy(); } catch { /* ignore */ }
    client = null;
  }

  clearSession();
  connectionState = 'disconnected';
  connectedInfo = null;
  cachedChats = [];
  chatsCacheTime = 0;
  lastQrDataUrl = null;
}

async function sendPollToChats({ question, options, chatIds, allowMultiple = false, humanDelayMin = 3, humanDelayMax = 12 }) {
  if (!isReady()) throw new Error('WhatsApp is not connected');
  if (!options || options.length < 2) throw new Error('A poll needs at least 2 options');
  if (options.length > 12) throw new Error('WhatsApp polls support up to 12 options');

  const poll = new Poll(question, options, { allowMultipleAnswers: allowMultiple });
  const results = [];

  for (let i = 0; i < chatIds.length; i++) {
    const chatId = chatIds[i];
    try {
      await staggeredChatDelay(i, { minSeconds: humanDelayMin, maxSeconds: humanDelayMax });
      let chat = null;
      try { chat = await client.getChatById(chatId); } catch { /* ignore */ }
      if (chat) {
        await humanLikeDelay(chat, question, { minSeconds: humanDelayMin, maxSeconds: humanDelayMax });
      } else {
        await sleep(randomBetween(humanDelayMin * 1000, humanDelayMax * 1000));
      }
      await client.sendMessage(chatId, poll, { sendSeen: false, waitUntilMsgSent: true });
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

const listeners = { ready: [] };
function on(event, handler) {
  if (listeners[event]) listeners[event].push(handler);
}

module.exports = {
  initialize,
  disconnect,
  waitForQrOrReady,
  getStatus,
  getChats,
  sendPollToChats,
  isReady,
  on,
};
