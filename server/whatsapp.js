const { Client, LocalAuth, Poll } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const path = require('path');
const { humanLikeDelay, staggeredChatDelay } = require('./humanSend');

let client = null;
let connectionState = 'disconnected';
let lastQr = null;
let lastQrDataUrl = null;
let connectedInfo = null;
let cachedChats = [];
let chatsLoading = false;

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

async function fetchAndCacheChats(retries = 3) {
  if (!client || connectionState !== 'ready') {
    throw new Error('WhatsApp is not connected');
  }

  let lastError = null;

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const chats = await client.getChats();
      cachedChats = chats
        .filter((chat) => !chat.isReadOnly)
        .map(formatChat)
        .sort((a, b) => a.name.localeCompare(b.name));
      return cachedChats;
    } catch (err) {
      lastError = err;
      console.error(`getChats attempt ${attempt}/${retries} failed:`, err.message);
      if (attempt < retries) {
        await new Promise((r) => setTimeout(r, 1500 * attempt));
      }
    }
  }

  throw lastError || new Error('Failed to load chats');
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
  return {
    state: connectionState,
    qr: lastQrDataUrl,
    connectedInfo,
  };
}

async function initialize() {
  if (client) return;

  client = new Client({
    authStrategy: new LocalAuth({
      dataPath: path.join(__dirname, '..', 'data', 'whatsapp-session'),
    }),
    webVersionCache: {
      type: 'remote',
      remotePath:
        'https://raw.githubusercontent.com/wwebjs/whatsapp-web.js/main/web-version.json',
    },
    puppeteer: {
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
      ],
    },
  });

  client.on('qr', async (qr) => {
    connectionState = 'qr';
    lastQr = qr;
    lastQrDataUrl = await qrcode.toDataURL(qr);
    emit('qr', lastQrDataUrl);
  });

  client.on('authenticated', () => {
    connectionState = 'authenticated';
    lastQr = null;
    lastQrDataUrl = null;
  });

  client.on('ready', async () => {
    connectionState = 'ready';
    lastQr = null;
    lastQrDataUrl = null;

    try {
      const info = client.info;
      connectedInfo = {
        pushname: info.pushname,
        phone: info.wid?.user,
        platform: info.platform,
      };
    } catch {
      connectedInfo = { pushname: 'Connected' };
    }

    emit('ready', connectedInfo);

    // Load chats immediately on ready — delays here can break getChats()
    chatsLoading = true;
    fetchAndCacheChats()
      .then((chats) => {
        console.log(`Loaded ${chats.length} chats`);
      })
      .catch((err) => {
        console.error('Initial chat load failed:', err.message);
      })
      .finally(() => {
        chatsLoading = false;
      });
  });

  client.on('disconnected', (reason) => {
    connectionState = 'disconnected';
    connectedInfo = null;
    client = null;
    emit('disconnected', reason);
  });

  client.on('auth_failure', (msg) => {
    connectionState = 'auth_failure';
    emit('auth_failure', msg);
  });

  connectionState = 'connecting';
  await client.initialize();
}

async function disconnect() {
  if (client) {
    await client.destroy();
    client = null;
  }
  connectionState = 'disconnected';
  connectedInfo = null;
  cachedChats = [];
  lastQr = null;
  lastQrDataUrl = null;
}

async function getChats({ refresh = false } = {}) {
  if (!client || connectionState !== 'ready') {
    throw new Error('WhatsApp is not connected');
  }

  if (!refresh && cachedChats.length > 0) {
    return cachedChats;
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
    return await fetchAndCacheChats();
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

      const chat = await client.getChatById(chatId);
      await humanLikeDelay(chat, question, {
        minSeconds: humanDelayMin,
        maxSeconds: humanDelayMax,
      });

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

module.exports = {
  initialize,
  disconnect,
  getStatus,
  getChats,
  sendPollToChats,
  isReady,
  on,
};
