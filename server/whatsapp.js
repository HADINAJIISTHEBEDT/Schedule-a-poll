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
let keepaliveMisses = 0;
const CHATS_CACHE_TTL = 5 * 60 * 1000;
const FATAL_WA_STATES = new Set(['UNPAIRED', 'UNPAIRED_IDLE', 'DISCONNECTED', 'LOGOUT']);
const CONNECTING_TIMEOUT_MS = 45 * 1000;
const QR_TARGET_MS = 10000;
const SEARCH_TIMEOUT_MS = 25000;

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error(`${label} timed out — try again`)), ms);
    }),
  ]);
}

function stopKeepalive() {
  if (keepaliveTimer) {
    clearInterval(keepaliveTimer);
    keepaliveTimer = null;
  }
  keepaliveMisses = 0;
}

function startKeepalive(instance) {
  stopKeepalive();
  keepaliveMisses = 0;

  keepaliveTimer = setInterval(async () => {
    if (!instance || connectionState !== 'ready') {
      stopKeepalive();
      return;
    }

    try {
      const waState = await instance.getState();

      if (waState === 'CONNECTED') {
        keepaliveMisses = 0;
        await instance.sendPresenceAvailable();
        return;
      }

      if (FATAL_WA_STATES.has(waState)) {
        console.warn('WhatsApp session ended:', waState);
        await handleSessionLost();
        return;
      }

      keepaliveMisses++;
      if (keepaliveMisses >= 6) {
        console.warn('WhatsApp keepalive: session unstable:', waState);
        keepaliveMisses = 0;
      }
    } catch (err) {
      keepaliveMisses++;
      console.error('WhatsApp keepalive error:', err.message);
    }
  }, 25000);
}

async function handleSessionLost() {
  stopKeepalive();
  keepaliveMisses = 0;
  if (connectionState === 'disconnected') return;

  console.warn('WhatsApp session lost — tap Connect to restore (session saved on disk)');
  connectionState = 'disconnected';
  connectedInfo = null;
  if (client) {
    try {
      await client.destroy();
    } catch {
      // ignore
    }
    client = null;
  }
  resetWarmup();
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

async function isSessionConnected(instance) {
  if (!instance?.pupPage) return false;
  try {
    return (await instance.getState()) === 'CONNECTED';
  } catch {
    return false;
  }
}

async function isClientFullyReady(instance) {
  if (!instance?.pupPage) return false;
  if (!(await isSessionConnected(instance))) return false;

  try {
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

  const connected = await isSessionConnected(instance);
  if (!connected) return false;

  connectionState = 'ready';
  connectingSince = 0;
  lastQr = null;
  lastQrDataUrl = null;
  connectedInfo = await readConnectedInfo(instance);
  stopReadyCheck();
  startKeepalive(instance);
  emit('ready', connectedInfo);
  console.log('WhatsApp linked as', connectedInfo.pushname);
  fetchAndCacheChats({ refresh: false, includeContacts: false }).catch((err) => {
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

function matchSearchTerm(name, id, term) {
  const normalize = (value) =>
    String(value || '')
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .trim();
  const needle = normalize(term);
  const label = normalize(name);
  const idPart = String(id || '').split('@')[0];
  const digits = idPart.replace(/\D/g, '');
  const termDigits = String(term || '').replace(/\D/g, '');
  if (label.includes(needle) || normalize(idPart).includes(needle)) return true;
  if (termDigits.length >= 3 && digits.includes(termDigits)) return true;
  return false;
}

async function fetchChatsDirect({ includeContacts = false } = {}) {
  const result = await client.pupPage.evaluate((withContacts) => {
    const collections = window.require('WAWebCollections');
    const chats = collections.Chat.getModelsArray();
    const seen = new Set();
    const items = [];

    const toId = (value) => {
      if (!value) return null;
      if (typeof value === 'string') return value;
      if (value._serialized) return value._serialized;
      if (value.user && value.server) return `${value.user}@${value.server}`;
      return null;
    };

    const contactId = (contact) => {
      // Prefer phone number over LID so polls can be sent reliably
      const phoneId = toId(contact.phoneNumber);
      if (phoneId) return phoneId;

      const rawId = toId(contact.id);
      if (rawId && rawId.endsWith('@lid')) {
        try {
          const wid = window.require('WAWebWidFactory').createWidFromWidLike(contact.id);
          const phone = window.require('WAWebApiContact').getPhoneNumber(wid);
          const resolved = toId(phone);
          if (resolved) return resolved;
        } catch {
          // fall through — keep lid id as last resort
        }
      }

      return rawId;
    };

    const contactName = (contact, id) => {
      const names = [];
      const push = (value) => {
        if (value == null) return;
        const text = String(value).trim();
        if (text) names.push(text);
      };

      try {
        const frontend = window.require('WAWebFrontendContactGetters');
        push(frontend.getDisplayName?.(contact));
        push(frontend.getSearchName?.(contact));
        push(frontend.getFormattedName?.(contact));
        push(frontend.getFormattedShortName?.(contact));
      } catch {
        // optional
      }

      try {
        const getters = window.require('WAWebContactGetters');
        push(getters.getName?.(contact));
        push(getters.getPushname?.(contact));
        push(getters.getShortName?.(contact));
        push(getters.getVerifiedName?.(contact));
      } catch {
        // optional
      }

      const keys = ['name', 'pushname', 'shortName', 'verifiedName', 'notifyName', 'displayName', 'searchName', 'formattedName'];
      for (const key of keys) {
        push(contact[key]);
        try {
          if (typeof contact.get === 'function') push(contact.get(key));
        } catch {
          // ignore
        }
      }

      return names[0] || (id && id.includes('@') ? id.split('@')[0] : id) || 'Unknown';
    };

    const isMeContact = (contact) => {
      if (contact.isMe) return true;
      try {
        return Boolean(window.require('WAWebContactGetters').getIsMe?.(contact));
      } catch {
        return false;
      }
    };

    const addItem = (id, name, isGroup, isReadOnly) => {
      if (!id || typeof id !== 'string' || seen.has(id) || isReadOnly) return;
      if (id.endsWith('@broadcast') || id === 'status@broadcast') return;
      seen.add(id);
      items.push({ id, name: name || 'Unknown', isGroup: Boolean(isGroup) });
    };

    for (const chat of chats) {
      const id = toId(chat.id);
      if (!id) continue;
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
        if (isMeContact(contact)) continue;
        const id = contactId(contact);
        if (!id || id.endsWith('@g.us')) continue;
        addItem(id, contactName(contact, id), false, false);
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

async function searchChatsDirect(term, filter = 'all', includeContacts = true) {
  if (!client?.pupPage) {
    throw new Error('WhatsApp browser is not available');
  }

  return withTimeout(
    client.pupPage.evaluate(
      (searchTerm, chatFilter, withContacts) => {
        let collections;
        try {
          collections = window.require('WAWebCollections');
        } catch (err) {
          throw new Error('WhatsApp collections not ready');
        }

        let contactGetters = null;
        let frontendGetters = null;
        try {
          contactGetters = window.require('WAWebContactGetters');
        } catch {
          // optional
        }
        try {
          frontendGetters = window.require('WAWebFrontendContactGetters');
        } catch {
          // optional
        }

        const seen = new Set();
        const results = [];
        const rawNeedle = String(searchTerm || '');
        const needle = rawNeedle.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
        const needleDigits = needle.replace(/\D/g, '');
        const limit = 50;

        const normalize = (value) =>
          String(value || '')
            .toLowerCase()
            .normalize('NFKD')
            .replace(/[\u0300-\u036f]/g, '')
            .trim();

        const toId = (value) => {
          if (!value) return null;
          if (typeof value === 'string') return value;
          if (value._serialized) return value._serialized;
          if (value.user && value.server) return `${value.user}@${value.server}`;
          return null;
        };

        const contactId = (contact) => {
          const phoneId = toId(contact.phoneNumber);
          if (phoneId) return phoneId;

          const rawId = toId(contact.id);
          if (rawId && rawId.endsWith('@lid')) {
            try {
              const wid = window.require('WAWebWidFactory').createWidFromWidLike(contact.id);
              const phone = window.require('WAWebApiContact').getPhoneNumber(wid);
              const resolved = toId(phone);
              if (resolved) return resolved;
            } catch {
              // keep lid id
            }
          }

          return rawId;
        };

        const collectNames = (contact) => {
          const names = [];
          const push = (value) => {
            if (value == null) return;
            const text = String(value).trim();
            if (text) names.push(text);
          };

          if (frontendGetters) {
            try {
              push(frontendGetters.getDisplayName?.(contact));
              push(frontendGetters.getSearchName?.(contact));
              push(frontendGetters.getFormattedName?.(contact));
              push(frontendGetters.getFormattedShortName?.(contact));
              push(frontendGetters.getDisplayNameOrPnForLid?.(contact));
              push(frontendGetters.getMentionName?.(contact));
            } catch {
              // ignore
            }
          }

          if (contactGetters) {
            try {
              push(contactGetters.getName?.(contact));
              push(contactGetters.getPushname?.(contact));
              push(contactGetters.getShortName?.(contact));
              push(contactGetters.getVerifiedName?.(contact));
              push(contactGetters.getNotifyName?.(contact));
            } catch {
              // ignore
            }
          }

          const attrKeys = [
            'name',
            'pushname',
            'shortName',
            'verifiedName',
            'notifyName',
            'displayName',
            'searchName',
            'formattedName',
            'displayNameOrPnForLid',
          ];
          for (const key of attrKeys) {
            push(contact[key]);
            try {
              if (typeof contact.get === 'function') push(contact.get(key));
            } catch {
              // ignore
            }
          }

          try {
            const serialized = contact.serialize?.();
            if (serialized) {
              for (const key of attrKeys) push(serialized[key]);
            }
          } catch {
            // ignore
          }

          return names;
        };

        const bestContactName = (contact, id) => {
          const names = collectNames(contact);
          return names[0] || (id && id.includes('@') ? id.split('@')[0] : id) || 'Unknown';
        };

        const isMeContact = (contact) => {
          if (contact.isMe) return true;
          try {
            return Boolean(contactGetters?.getIsMe?.(contact));
          } catch {
            return false;
          }
        };

        const isGroupContact = (contact) => {
          try {
            if (contactGetters?.getIsGroup?.(contact)) return true;
          } catch {
            // ignore
          }
          return Boolean(contact.isGroup);
        };

        const textMatches = (values, id) => {
          for (const value of values) {
            if (normalize(value).includes(needle)) return true;
          }
          const idPart = String(id || '').split('@')[0];
          if (normalize(idPart).includes(needle)) return true;
          const digits = idPart.replace(/\D/g, '');
          if (needleDigits.length >= 3 && digits.includes(needleDigits)) return true;
          return false;
        };

        const contactMatches = (contact, names, id) => {
          // Native WhatsApp matcher (same as in-app search)
          try {
            if (typeof contact.searchMatch === 'function') {
              const hit = contact.searchMatch(rawNeedle) || contact.searchMatch(needle);
              if (hit) return true;
            }
          } catch {
            // ignore and fall back
          }
          return textMatches(names, id);
        };

        const tryAdd = (id, name, isGroup) => {
          if (!id || typeof id !== 'string' || seen.has(id) || results.length >= limit) {
            return false;
          }
          if (id.endsWith('@broadcast') || id === 'status@broadcast') return false;
          if (chatFilter === 'groups' && !isGroup) return false;
          if (chatFilter === 'contacts' && isGroup) return false;
          seen.add(id);
          results.push({ id, name: name || 'Unknown', isGroup: Boolean(isGroup) });
          return true;
        };

        // Contacts first so people aren't crowded out by groups
        const searchContacts = withContacts && chatFilter !== 'groups';
        if (searchContacts) {
          // Never call WWebJS.getContacts() here — it loads business profiles
          // for every contact and routinely times out / 502s on Render.
          const contacts = collections.Contact?.getModelsArray?.() || [];
          for (const contact of contacts) {
            if (results.length >= limit) break;
            if (isMeContact(contact) || isGroupContact(contact)) continue;
            const id = contactId(contact);
            if (!id || id.endsWith('@g.us')) continue;
            const names = collectNames(contact);
            if (!contactMatches(contact, names, id)) continue;
            tryAdd(id, names[0] || bestContactName(contact, id), false);
          }
        }

        // Always search chats too — Contacts filter previously skipped this,
        // so people you already chat with never appeared by their chat title.
        {
          const chats = collections.Chat?.getModelsArray?.() || [];
          for (const chat of chats) {
            if (results.length >= limit) break;
            const id = toId(chat.id);
            if (!id) continue;
            const isGroup = Boolean(chat.groupMetadata) || id.endsWith('@g.us');
            if (chatFilter === 'groups' && !isGroup) continue;
            if (chatFilter === 'contacts' && isGroup) continue;
            const isReadOnly = Boolean(chat.groupMetadata?.announce);
            if (isReadOnly) continue;

            const nameCandidates = [];
            const push = (value) => {
              if (value == null) return;
              const text = String(value).trim();
              if (text) nameCandidates.push(text);
            };

            push(chat.formattedTitle);
            push(chat.name);
            if (chat.contact) {
              for (const n of collectNames(chat.contact)) push(n);
            }

            if (!textMatches(nameCandidates, id)) continue;
            tryAdd(
              id,
              nameCandidates[0] || (id.includes('@') ? id.split('@')[0] : id) || 'Unknown',
              isGroup
            );
          }
        }

        return results.sort((a, b) => {
          if (a.isGroup !== b.isGroup) return a.isGroup ? -1 : 1;
          return a.name.localeCompare(b.name);
        });
      },
      term,
      filter,
      includeContacts
    ),
    SEARCH_TIMEOUT_MS,
    'Search'
  );
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

function searchCachedChats(term, filter, includeContacts) {
  let pool = includeContacts && cachedContacts
    ? mergeChatLists(cachedChats, cachedContacts)
    : cachedChats;

  if (filter === 'groups') {
    pool = pool.filter((c) => c.isGroup);
  } else if (filter === 'contacts') {
    pool = pool.filter((c) => !c.isGroup);
  }

  return pool
    .filter((c) => matchSearchTerm(c.name, c.id, term))
    .slice(0, 50);
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
  return {
    state: connectionState,
    qr: lastQrDataUrl,
    connectedInfo,
  };
}

async function refreshStatus() {
  if (client && connectionState !== 'ready' && connectionState !== 'disconnected') {
    await tryFinalizeReady(client);
  } else if (client && connectionState === 'ready') {
    const connected = await isSessionConnected(client);
    if (!connected) {
      connectionState = 'authenticated';
      await tryFinalizeReady(client);
    }
  }
  return getStatus();
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
    fetchAndCacheChats({ refresh: false, includeContacts: false }).catch((err) => {
      console.error('Chat cache warmup failed:', err.message);
    });
  });

  instance.on('change_state', (state) => {
    console.log('WhatsApp state:', state);
    if (state === 'CONNECTED' && connectionState !== 'ready') {
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
    console.log('WhatsApp disconnected:', reason, '— session kept until manual disconnect');
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
      setTimeout(() => {
        if (client) tryFinalizeReady(client).catch(() => {});
      }, 2000);
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

async function disconnect({ preserveState = false, userInitiated = false } = {}) {
  stopReadyCheck();
  stopKeepalive();

  if (client && userInitiated) {
    try {
      await client.logout();
    } catch {
      // ignore — destroy below still clears the runtime session
    }
  }

  if (client) {
    try {
      await client.destroy();
    } catch (err) {
      console.error('WhatsApp disconnect error:', err.message);
    }
    client = null;
  }

  clearBrowserLocks();
  connectedInfo = null;
  cachedChats = [];
  cachedContacts = null;
  chatsCacheTime = 0;

  if (userInitiated) {
    clearSessionData();
    connectionState = 'disconnected';
    connectingSince = 0;
    lastQr = null;
    lastQrDataUrl = null;
    resetWarmup();
  } else if (!preserveState) {
    connectionState = 'disconnected';
    connectingSince = 0;
    lastQr = null;
    lastQrDataUrl = null;
    resetWarmup();
  }
}

async function searchChats({ query = '', filter = 'all', includeContacts = true } = {}) {
  if (!client || connectionState !== 'ready') {
    throw new Error('WhatsApp is not connected');
  }

  const connected = await isSessionConnected(client);
  if (!connected) {
    // Still allow cache search if WhatsApp briefly flaps — avoids hard fail toasts
    const termEarly = query.trim().toLowerCase();
    if (termEarly && cachedChats.length > 0) {
      return searchCachedChats(termEarly, filter, includeContacts);
    }
    throw new Error('WhatsApp is not connected');
  }

  const term = query.trim().toLowerCase();
  if (term.length < 1) {
    return [];
  }

  try {
    const live = await searchChatsDirect(term, filter, includeContacts);
    if (live.length > 0) return live;

    // Live search returned nothing — try cache (may have older chats)
    if (cachedChats.length > 0) {
      const cached = searchCachedChats(term, filter, includeContacts);
      if (cached.length > 0) return cached;
    }
    return live;
  } catch (err) {
    console.error('Direct search failed:', err.message);
    if (cachedChats.length > 0 || (cachedContacts && cachedContacts.length > 0)) {
      return searchCachedChats(term, filter, includeContacts);
    }
    throw new Error(err.message || 'Search failed — try again in a few seconds');
  }
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

function hasSavedSession() {
  try {
    return fs.existsSync(SESSION_PATH) && fs.readdirSync(SESSION_PATH).length > 0;
  } catch {
    return false;
  }
}

/** Restore saved session on startup or when the app checks status. */
function warmupConnection() {
  if (warmupStarted || isReady() || initInProgress) return;
  if (connectionState === 'qr' || connectionState === 'connecting' || connectionState === 'authenticated') {
    return;
  }
  if (connectionState === 'disconnected' && !hasSavedSession()) {
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
  refreshStatus,
  getChats,
  searchChats,
  sendPollToChats,
  isReady,
  on,
};
