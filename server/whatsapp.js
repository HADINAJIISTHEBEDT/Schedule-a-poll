const { Client, LocalAuth, Poll } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const path = require('path');
const { humanLikeDelay, staggeredChatDelay, sleep, randomBetween } = require('./humanSend');

let client = null;
let connectionState = 'disconnected';
let lastQr = null;
let lastQrDataUrl = null;
let connectedInfo = null;
let cachedChats = [];
let cachedContacts = null;
let chatsLoading = false;
let chatsCacheTime = 0;
const CHATS_CACHE_TTL = 5 * 60 * 1000;

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

  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      cachedChats = await fetchChatsDirect({ includeContacts: false });
      chatsCacheTime = Date.now();

      if (includeContacts) {
        cachedContacts = (await fetchChatsDirect({ includeContacts: true })).filter((c) => !c.isGroup);
        return mergeChatLists(cachedChats, cachedContacts);
      }

      return cachedChats;
    } catch (err) {
      lastError = err;
      console.error(`Chat fetch attempt ${attempt}/2 failed:`, err.message);
      if (attempt < 2) {
        await new Promise((r) => setTimeout(r, 1000));
      }
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
  cachedContacts = null;
  chatsCacheTime = 0;
  lastQr = null;
  lastQrDataUrl = null;
}

async function getChats({ refresh = false, includeContacts = false } = {}) {
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

module.exports = {
  initialize,
  disconnect,
  getStatus,
  getChats,
  sendPollToChats,
  isReady,
  on,
};
