const { Client, LocalAuth, Poll } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const path = require('path');
const { humanLikeDelay, staggeredChatDelay } = require('./humanSend');

let client = null;
let connectionState = 'disconnected';
let lastQr = null;
let lastQrDataUrl = null;
let connectedInfo = null;

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
  lastQr = null;
  lastQrDataUrl = null;
}

async function getChats() {
  if (!client || connectionState !== 'ready') {
    throw new Error('WhatsApp is not connected');
  }

  const chats = await client.getChats();
  return chats
    .filter((chat) => !chat.isReadOnly)
    .map((chat) => ({
      id: chat.id._serialized,
      name: chat.name || chat.id.user,
      isGroup: chat.isGroup,
      unreadCount: chat.unreadCount,
      lastMessage: chat.lastMessage?.body?.slice(0, 60) || '',
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
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
