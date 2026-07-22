const { Client, LocalAuth, Poll } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const fs = require('fs');
const path = require('path');
const { humanLikeDelay, staggeredChatDelay, sleep, randomBetween } = require('./humanSend');

const SESSION_PATH = path.join(__dirname, '..', 'data', 'whatsapp-session');

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

function resolveChrome() {
  for (const p of CHROME_PATHS) {
    if (fs.existsSync(p)) return p;
  }
  return undefined;
}

function clearSession() {
  if (fs.existsSync(SESSION_PATH)) {
    fs.rmSync(SESSION_PATH, { recursive: true, force: true });
  }
}

function getStatus() {
  return { state: connectionState, qr: lastQrDataUrl, connectedInfo };
}

function isReady() {
  return connectionState === 'ready' && client !== null;
}

async function fetchChatsFromWhatsApp() {
  const items = await client.pupPage.evaluate(() => {
    const chats = window.require('WAWebCollections').Chat.getModelsArray();
    const seen = new Set();
    const result = [];

    for (const chat of chats) {
      const id = chat.id?._serialized || String(chat.id);
      if (!id || seen.has(id)) continue;
      if (chat.groupMetadata?.announce) continue;

      seen.add(id);
      const isGroup = Boolean(chat.groupMetadata) || id.endsWith('@g.us');
      const name =
        chat.formattedTitle ||
        chat.name ||
        chat.contact?.pushname ||
        chat.contact?.name ||
        id.split('@')[0] ||
        'Unknown';

      result.push({ id, name, isGroup });
    }
    return result;
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
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const chats = await fetchChatsFromWhatsApp();
      if (chats.length > 0) {
        cachedChats = chats;
        chatsCacheTime = Date.now();
        return cachedChats;
      }
    } catch (err) {
      lastError = err;
      console.error(`Chat load attempt ${attempt}/4:`, err.message);
    }
    if (attempt < 4) await sleep(1500 * attempt);
  }

  if (cachedChats.length > 0) return cachedChats;
  throw lastError || new Error('Failed to load chats');
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

async function initialize() {
  if (client) {
    await disconnect();
  }

  clearSession();

  client = new Client({
    authStrategy: new LocalAuth({ dataPath: SESSION_PATH }),
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

  client.on('qr', async (qr) => {
    connectionState = 'qr';
    lastQrDataUrl = await qrcode.toDataURL(qr);
  });

  client.on('authenticated', () => {
    connectionState = 'authenticated';
    lastQrDataUrl = null;
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
    loadAndCacheChats()
      .then((chats) => console.log(`Loaded ${chats.length} chats`))
      .catch((err) => console.error('Chat preload failed:', err.message));
  });

  client.on('disconnected', () => {
    connectionState = 'disconnected';
    connectedInfo = null;
    client = null;
    cachedChats = [];
    lastQrDataUrl = null;
  });

  client.on('auth_failure', () => {
    connectionState = 'auth_failure';
    lastQrDataUrl = null;
  });

  connectionState = 'connecting';
  await client.initialize();
}

async function disconnect() {
  if (client) {
    try { await client.logout(); } catch { /* ignore */ }
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

module.exports = { initialize, disconnect, getStatus, getChats, sendPollToChats, isReady, on };
