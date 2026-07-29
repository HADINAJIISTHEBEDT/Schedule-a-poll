const { Client, LocalAuth, RemoteAuth, Poll } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { humanLikeDelay, staggeredChatDelay, sleep, randomBetween } = require('./humanSend');
const { isFirebaseConfigured, initFirebaseAdmin } = require('./firebase');
const { isMongoConfigured } = require('./mongo');
const {
  FirebaseSessionStore,
  ProtectedRemoteStore,
  SESSION_CLIENT_ID,
  SESSION_NAME,
} = require('./waSessionStore');
const { createMongoSessionStore } = require('./mongoSessionStore');
const contactStore = require('./contactStore');

const CHROME_CANDIDATES = [
  process.env.PUPPETEER_EXECUTABLE_PATH,
  '/usr/local/bin/google-chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].filter(Boolean);

const DATA_ROOT = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
// Prefer Firebase/Firestore (user's existing DB). Mongo only if explicitly requested.
const preferMongo = String(process.env.WA_SESSION_BACKEND || '').toLowerCase() === 'mongodb';
const USE_MONGO_AUTH = preferMongo && isMongoConfigured();
const USE_FIRESTORE_AUTH =
  !USE_MONGO_AUTH &&
  (process.env.WA_REMOTE_AUTH === 'true' ||
    (process.env.WA_REMOTE_AUTH !== 'false' && isFirebaseConfigured()));
const USE_REMOTE_AUTH = USE_MONGO_AUTH || USE_FIRESTORE_AUTH;
const SESSION_PATH = USE_REMOTE_AUTH
  ? path.join(os.tmpdir(), 'wwebjs_auth')
  : path.join(DATA_ROOT, 'whatsapp-session');
const WEB_CACHE_PATH = path.join(DATA_ROOT, 'wwebjs_cache');
const AUTH_MARKER_PATH = path.join(DATA_ROOT, 'whatsapp-session', '.authenticated');
const PINNED_WEB_VERSION = '2.3000.1017054665';

let remoteSessionStore = null;
let remoteSessionKnown = false;
let remoteBackend = USE_MONGO_AUTH ? 'mongodb' : USE_FIRESTORE_AUTH ? 'firestore' : 'local';
let contactsHydrated = false;

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
  '--disable-features=IsolateOrigins,site-per-process,MemorySaverMode,TranslateUI',
  '--disable-site-isolation-trials',
  '--memory-pressure-off',
  '--disable-background-timer-throttling',
  '--disable-renderer-backgrounding',
  '--disable-backgrounding-occluded-windows',
  '--no-zygote',
  // Helps WhatsApp Web start on low-RAM Render instances
  '--renderer-process-limit=2',
  '--js-flags=--max-old-space-size=256',
  '--font-render-hinting=none',
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
const RESTORE_TIMEOUT_MS = 3 * 60 * 1000;
const QR_TARGET_MS = 10000;
const SEARCH_TIMEOUT_MS = 25000;
const STATE_CHECK_TIMEOUT_MS = 8000;
let readyMisses = 0;

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

  // Fast path: page-level check (avoids hanging Client.getState on Render/cloud)
  try {
    const pageState = await withTimeout(
      instance.pupPage.evaluate(() => {
        try {
          const conn = window.require('WAWebConnModel')?.Conn;
          const state = conn?.state || conn?.stream || null;
          const hasMe = Boolean(
            window.require('WAWebUserPrefsMeUser')?.getMaybeMePnUser?.() ||
              window.require('WAWebUserPrefsMeUser')?.getMaybeMeLidUser?.()
          );
          const hasWWebJS = typeof window.WWebJS !== 'undefined';
          const chatReady = Boolean(
            window.require('WAWebCollections')?.Chat?.getModelsArray
          );
          return {
            state: state ? String(state) : null,
            hasMe,
            hasWWebJS,
            chatReady,
          };
        } catch {
          return { state: null, hasMe: false, hasWWebJS: false, chatReady: false };
        }
      }),
      STATE_CHECK_TIMEOUT_MS,
      'Page state'
    );

    if (pageState?.hasMe && (pageState.chatReady || pageState.hasWWebJS)) {
      return true;
    }
    if (pageState?.state && /CONNECTED|OPENING|PAIRING|SYNCING|NORMAL/i.test(pageState.state)) {
      return true;
    }
  } catch {
    // fall through to getState
  }

  try {
    const waState = await withTimeout(
      instance.getState(),
      STATE_CHECK_TIMEOUT_MS,
      'WhatsApp getState'
    );
    return waState === 'CONNECTED' || waState === 'OPENING';
  } catch {
    return false;
  }
}

async function isClientFullyReady(instance) {
  if (!instance?.pupPage) return false;
  if (!(await isSessionConnected(instance))) return false;

  try {
    return await withTimeout(
      instance.pupPage.evaluate(() => {
        if (typeof window.WWebJS === 'undefined') return false;
        try {
          const collections = window.require('WAWebCollections');
          return Boolean(collections?.Chat?.getModelsArray);
        } catch {
          return false;
        }
      }),
      STATE_CHECK_TIMEOUT_MS,
      'Ready probe'
    );
  } catch {
    // If Connected on phone but Store is still warming, still treat as ready enough for UI
    return connectionState === 'authenticated' || connectionState === 'ready';
  }
}

async function tryFinalizeReady(instance) {
  if (!instance || connectionState === 'ready') return true;

  const connected = await isSessionConnected(instance);
  if (!connected) {
    // After QR scan WhatsApp may report authenticated before getState is CONNECTED
    if (connectionState === 'authenticated') {
      try {
        const info = await readConnectedInfo(instance);
        if (info?.phone || info?.pushname) {
          connectedInfo = info;
          markAuthenticated(info);
        }
      } catch {
        // keep waiting
      }
    }
    return false;
  }

  connectionState = 'ready';
  connectingSince = 0;
  lastQr = null;
  lastQrDataUrl = null;
  readyMisses = 0;
  connectedInfo = await readConnectedInfo(instance);
  markAuthenticated(connectedInfo);
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
  const maxAttempts = 240;

  const check = async () => {
    if (!instance || connectionState === 'ready' || connectionState === 'disconnected') {
      stopReadyCheck();
      return;
    }

    attempts++;
    try {
      await tryFinalizeReady(instance);
    } catch (err) {
      console.warn('Ready check error:', err.message);
    }

    if (attempts >= maxAttempts) {
      stopReadyCheck();
      // Last resort: if WhatsApp already authenticated on phone, surface Connected
      if (connectionState === 'authenticated' && hasSavedSession()) {
        connectionState = 'ready';
        connectingSince = 0;
        connectedInfo = connectedInfo || { pushname: 'Connected' };
        markAuthenticated(connectedInfo);
        startKeepalive(instance);
        emit('ready', connectedInfo);
        console.warn('Ready check timed out — marking connected after authenticated session');
      } else {
        console.warn('Ready check timed out after scan — still syncing');
      }
    }
  };

  check();
  readyCheckTimer = setInterval(check, 1500);
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
        persistContactsToStore().catch((err) => {
          console.warn('persistContactsToStore failed:', err.message);
        });
        return mergeChatLists(cachedChats, cachedContacts);
      }

      persistContactsToStore().catch((err) => {
        console.warn('persistContactsToStore failed:', err.message);
      });
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
  const saved = hasSavedSession();
  return {
    state: connectionState,
    qr: lastQrDataUrl,
    connectedInfo,
    hasSession: saved,
    // True only while restoring a real saved login (not while waiting for first QR)
    restoring: saved && (connectionState === 'connecting' || connectionState === 'authenticated') && !lastQrDataUrl,
  };
}

async function refreshStatus() {
  if (client && connectionState !== 'ready' && connectionState !== 'disconnected') {
    await tryFinalizeReady(client).catch(() => {});
  } else if (client && connectionState === 'ready') {
    // Don't demote to "connecting" on a single flaky getState — require several misses
    const connected = await isSessionConnected(client);
    if (connected) {
      readyMisses = 0;
    } else {
      readyMisses += 1;
      if (readyMisses >= 3) {
        console.warn('WhatsApp ready probe missed 3 times — re-checking authenticated state');
        connectionState = 'authenticated';
        startReadyCheck(client);
        await tryFinalizeReady(client).catch(() => {});
      }
    }
  }
  return getStatus();
}

function clearSessionData() {
  clearAuthMarker();
  remoteSessionKnown = false;
  contactsHydrated = false;
  getRemoteSessionStore()?.setCachedExists?.(false);

  if (fs.existsSync(SESSION_PATH)) {
    fs.rmSync(SESSION_PATH, { recursive: true, force: true });
    console.log('WhatsApp local session cache cleared from', SESSION_PATH);
  }

  if (USE_REMOTE_AUTH) {
    const store = getRemoteSessionStore();
    if (store) {
      // Allow delete only for explicit Disconnect / logout wipe
      store.allowRemoteDelete?.(true);
      store
        .delete({ session: SESSION_NAME })
        .catch((err) => {
          console.warn(`Failed to delete ${remoteBackend} WhatsApp session:`, err.message);
        })
        .finally(() => store.allowRemoteDelete?.(false));
    }
  }

  contactStore.clearContacts().catch(() => {});
}

function markAuthenticated(info = {}) {
  try {
    ensureSessionDirs();
    fs.mkdirSync(path.dirname(AUTH_MARKER_PATH), { recursive: true });
    fs.writeFileSync(
      AUTH_MARKER_PATH,
      JSON.stringify(
        {
          authenticatedAt: new Date().toISOString(),
          pushname: info.pushname || null,
          phone: info.phone || null,
        },
        null,
        2
      )
    );
  } catch (err) {
    console.error('Failed to write auth marker:', err.message);
  }
}

function clearAuthMarker() {
  try {
    if (fs.existsSync(AUTH_MARKER_PATH)) fs.rmSync(AUTH_MARKER_PATH, { force: true });
  } catch {
    // ignore
  }
}

function ensureSessionDirs() {
  try {
    fs.mkdirSync(SESSION_PATH, { recursive: true });
    fs.mkdirSync(WEB_CACHE_PATH, { recursive: true });
  } catch (err) {
    console.error('Failed to create session dirs:', err.message);
  }
}

function clearBrowserLocks() {
  const lockFiles = ['SingletonLock', 'SingletonSocket', 'SingletonCookie'];
  // LocalAuth: data/whatsapp-session/session — RemoteAuth: tmp/wwebjs_auth/RemoteAuth-poll
  const profileDirs = [
    path.join(SESSION_PATH, 'session'),
    path.join(SESSION_PATH, SESSION_NAME),
    path.join(SESSION_PATH, 'RemoteAuth'),
  ];
  for (const profileDir of profileDirs) {
    for (const file of lockFiles) {
      const lockPath = path.join(profileDir, file);
      if (fs.existsSync(lockPath)) {
        try {
          fs.rmSync(lockPath, { force: true });
        } catch {
          // ignore
        }
      }
    }
  }
}

function getRemoteSessionStore() {
  return remoteSessionStore;
}

async function initRemoteSessionStore() {
  if (!USE_REMOTE_AUTH) return null;
  if (remoteSessionStore) return remoteSessionStore;
  fs.mkdirSync(SESSION_PATH, { recursive: true });

  let inner = null;
  if (USE_MONGO_AUTH) {
    inner = await createMongoSessionStore(SESSION_PATH);
    remoteBackend = 'mongodb';
  } else {
    const db = initFirebaseAdmin();
    if (!db) {
      throw new Error(
        'Firebase Admin failed to start — set FIREBASE_CLIENT_EMAIL and FIREBASE_PRIVATE_KEY on Render'
      );
    }
    inner = new FirebaseSessionStore({ dataPath: SESSION_PATH });
    remoteBackend = 'firestore';
  }

  remoteSessionStore = new ProtectedRemoteStore(inner);
  return remoteSessionStore;
}

async function refreshRemoteSessionCache() {
  if (!USE_REMOTE_AUTH) {
    remoteSessionKnown = false;
    return false;
  }
  try {
    const store = await initRemoteSessionStore();
    const exists = await store.sessionExists({ session: SESSION_NAME });
    remoteSessionKnown = exists;
    store.setCachedExists?.(exists);
    console.log(
      exists
        ? `Found WhatsApp session in ${remoteBackend} — will restore like localhost`
        : `No WhatsApp session in ${remoteBackend} yet — scan QR once to save it`
    );
    return exists;
  } catch (err) {
    console.warn(`Could not check ${remoteBackend} WhatsApp session:`, err.message);
    remoteSessionKnown = false;
    return false;
  }
}

async function hydrateContactsFromStore() {
  if (contactsHydrated && ((cachedContacts && cachedContacts.length) || cachedChats.length)) {
    return;
  }
  try {
    const rows = await contactStore.loadContacts();
    if (!rows.length) return;
    cachedChats = rows.filter((r) => r.isGroup);
    cachedContacts = rows.filter((r) => !r.isGroup);
    chatsCacheTime = Date.now();
    contactsHydrated = true;
    console.log(
      `Loaded ${rows.length} saved chats/contacts from ${USE_MONGO_AUTH ? 'MongoDB' : 'Firestore'}`
    );
  } catch (err) {
    console.warn('Could not hydrate contacts from store:', err.message);
  }
}

async function forceRemoteSessionBackup(instance = client) {
  if (!USE_REMOTE_AUTH || !instance?.authStrategy) return;
  const strategy = instance.authStrategy;
  if (typeof strategy.storeRemoteSession !== 'function') return;
  await strategy.storeRemoteSession({ emit: true });
  remoteSessionKnown = true;
  getRemoteSessionStore()?.setCachedExists?.(true);
  markAuthenticated(connectedInfo || {});
  console.log(`Forced WhatsApp session backup to ${remoteBackend}`);
}

async function persistContactsToStore() {
  const all = mergeChatLists(cachedChats || [], cachedContacts || []);
  if (!all.length) {
    console.warn('Contact persist skipped — nothing in memory to save yet');
    return 0;
  }
  const saved = await contactStore.saveContacts(all);
  if (!saved) {
    console.warn('Contact persist returned 0 — check Firebase Admin credentials');
  }
  return saved;
}

/** Merge live search / fetch hits into memory and write them to Firestore. */
function rememberChats(items = []) {
  const list = (items || []).filter((c) => c && c.id);
  if (!list.length) return;

  cachedChats = mergeChatLists(cachedChats || [], list);
  const people = list.filter((c) => !c.isGroup);
  if (people.length) {
    cachedContacts = mergeChatLists(cachedContacts || [], people);
  }
  chatsCacheTime = Date.now();
  persistContactsToStore().catch((err) => {
    console.warn('Contact persist failed:', err.message);
  });
}

function scheduleContactBackups(instance) {
  const delays = [8_000, 20_000, 45_000, 90_000];
  for (const ms of delays) {
    setTimeout(() => {
      if (!instance || client !== instance || connectionState !== 'ready') return;
      fetchAndCacheChats({ refresh: true, includeContacts: true })
        .then((rows) => {
          console.log(`Contact backup ok (${rows.length} rows in memory)`);
          return persistContactsToStore();
        })
        .catch((err) => {
          console.warn(`Contact backup at ${ms}ms failed:`, err.message);
        });
    }, ms);
  }
}

function getContactStats() {
  return {
    chatsCached: Array.isArray(cachedChats) ? cachedChats.length : 0,
    contactsCached: Array.isArray(cachedContacts) ? cachedContacts.length : 0,
    contactsHydrated,
  };
}


function createAuthStrategy() {
  if (USE_REMOTE_AUTH) {
    if (!remoteSessionStore) {
      throw new Error('Remote session store not initialized — call refreshRemoteSessionCache first');
    }
    console.log(`Using RemoteAuth via ${remoteBackend} (free — no Disk/Storage upgrade)`);
    return new RemoteAuth({
      clientId: SESSION_CLIENT_ID,
      dataPath: SESSION_PATH,
      store: remoteSessionStore,
      backupSyncIntervalMs: 60_000,
    });
  }

  console.log('Using LocalAuth under', SESSION_PATH);
  return new LocalAuth({
    dataPath: SESSION_PATH,
  });
}

function createClient() {
  const chromePath = resolveChromePath();
  if (!chromePath) {
    console.warn('No Chrome/Chromium binary found — Puppeteer will use its bundled browser');
  }

  ensureSessionDirs();

  const instance = new Client({
    authStrategy: createAuthStrategy(),
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
      protocolTimeout: 180000,
      args: PUPPETEER_ARGS,
    },
  });

  instance.on('remote_session_saved', () => {
    remoteSessionKnown = true;
    getRemoteSessionStore()?.setCachedExists?.(true);
    markAuthenticated(connectedInfo || {});
    console.log(`WhatsApp login saved to ${remoteBackend} (survives Render restarts)`);
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
      // Session files may exist but WhatsApp still wants a fresh scan
      if (fs.existsSync(AUTH_MARKER_PATH)) {
        console.warn('QR requested — previous login expired, scan once to refresh');
        clearAuthMarker();
      }
    } catch (err) {
      console.error('QR handler error:', err.message);
    }
  });

  instance.on('authenticated', () => {
    connectionState = 'authenticated';
    lastQr = null;
    lastQrDataUrl = null;
    markAuthenticated();
    startReadyCheck(instance);
    instance.sendPresenceAvailable().catch(() => {});
    // Phone already shows linked — promote to Connected in the app ASAP
    setTimeout(() => tryFinalizeReady(instance).catch(() => {}), 300);
    setTimeout(() => tryFinalizeReady(instance).catch(() => {}), 1000);
    setTimeout(() => tryFinalizeReady(instance).catch(() => {}), 3000);
    setTimeout(() => tryFinalizeReady(instance).catch(() => {}), 8000);
    console.log('WhatsApp authenticated — session saved under', SESSION_PATH);
  });

  instance.on('loading_screen', (percent) => {
    if (percent >= 80) {
      setTimeout(() => tryFinalizeReady(instance).catch(() => {}), 500);
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

    markAuthenticated(connectedInfo);
    startKeepalive(instance);
    emit('ready', connectedInfo);
    // Don't wait for library's 60s first backup — push to Firebase ASAP
    setTimeout(() => {
      forceRemoteSessionBackup(instance).catch((err) => {
        console.warn('Early Firebase session backup failed:', err.message);
      });
    }, 8000);
    setTimeout(() => {
      forceRemoteSessionBackup(instance).catch(() => {});
    }, 25000);
    // Contacts often are not synced at the exact ready moment — retry several times
    fetchAndCacheChats({ refresh: true, includeContacts: true })
      .then(() => persistContactsToStore())
      .catch((err) => {
        console.error('Chat/contact cache warmup failed:', err.message);
      });
    scheduleContactBackups(instance);
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

    // Only wipe disk if WhatsApp itself logged the device out.
    // Deploys / restarts keep the session so one QR scan lasts.
    if (String(reason).toUpperCase() === 'LOGOUT') {
      console.warn('WhatsApp logged out remotely — clearing saved session');
      clearSessionData();
    } else {
      console.log('WhatsApp disconnected:', reason, '— session kept until manual disconnect');
    }
  });

  instance.on('auth_failure', (msg) => {
    stopReadyCheck();
    connectionState = 'auth_failure';
    connectingSince = 0;
    emit('auth_failure', msg);
    console.error('WhatsApp auth_failure (session kept for retry):', msg);
  });

  return instance;
}

async function initialize({ force = false, resetSession = false } = {}) {
  if (USE_REMOTE_AUTH) {
    await initRemoteSessionStore();
  }

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

  // Always start from a clean ephemeral session folder for RemoteAuth extract,
  // but never wipe the remote DB unless resetSession/user disconnect.
  if (resetSession) {
    clearSessionData();
  } else {
    clearBrowserLocks();
    if (hasSavedSession()) {
      console.log('Restoring WhatsApp login from', remoteBackend);
    }
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
      setTimeout(() => {
        if (client) tryFinalizeReady(client).catch(() => {});
      }, 8000);
      return;
    } catch (err) {
      lastError = err;
      console.error(`WhatsApp init attempt ${attempt}/2 failed:`, err.message);

      // Auth may have succeeded before puppeteer timed out — don't throw away the link
      if (connectionState === 'ready') return;
      if (connectionState === 'authenticated' && client) {
        console.warn('Init timed out after authenticate — keeping session and waiting for ready');
        startReadyCheck(client);
        tryFinalizeReady(client).catch(() => {});
        return;
      }

      if (client) {
        await disconnect({ preserveState: true });
      }

      if (!isDetachedFrameError(err) || attempt === 2) {
        break;
      }

      await sleep(500);
    }
  }

  if (connectionState === 'ready' || connectionState === 'authenticated') {
    return;
  }

  connectionState = hasSavedSession() ? 'authenticated' : 'disconnected';
  connectingSince = 0;
  if (connectionState !== 'authenticated') {
    client = null;
  }

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
  const term = query.trim().toLowerCase();
  if (term.length < 1) return [];

  // Prefer live WhatsApp search when connected
  if (client && connectionState === 'ready') {
    const connected = await isSessionConnected(client);
    if (connected) {
      try {
        const live = await searchChatsDirect(term, filter, includeContacts);
        if (live.length > 0) {
          // THIS was missing — search hits never got written to Firebase
          rememberChats(live);
          return live;
        }
        if (cachedChats.length > 0 || (cachedContacts && cachedContacts.length)) {
          const cached = searchCachedChats(term, filter, includeContacts);
          if (cached.length > 0) return cached;
        }
        return live;
      } catch (err) {
        console.error('Direct search failed:', err.message);
        if (cachedChats.length > 0 || (cachedContacts && cachedContacts.length)) {
          return searchCachedChats(term, filter, includeContacts);
        }
      }
    }
  }

  // Fallback: saved contacts/chats from Firestore (works while reconnecting)
  await hydrateContactsFromStore();
  if (cachedChats.length > 0 || (cachedContacts && cachedContacts.length > 0)) {
    return searchCachedChats(term, filter, includeContacts);
  }

  throw new Error(
    'WhatsApp is not connected — tap Connect, scan QR once, then wait ~15–30 seconds so login + contacts are saved'
  );
}

async function getChats({ refresh = false, includeContacts = false } = {}) {
  if (!client || connectionState !== 'ready') {
    await hydrateContactsFromStore();
    if (cachedChats.length || (cachedContacts && cachedContacts.length)) {
      return includeContacts
        ? mergeChatLists(cachedChats, cachedContacts || [])
        : cachedChats;
    }
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

async function resolveChatId(chatId) {
  const id = String(chatId || '').trim();
  if (!id) return id;
  if (!id.endsWith('@lid') || !client?.pupPage) return id;

  try {
    const resolved = await withTimeout(
      client.pupPage.evaluate(async (lidId) => {
        const toId = (value) => {
          if (!value) return null;
          if (typeof value === 'string') return value;
          if (value._serialized) return value._serialized;
          if (value.user && value.server) return `${value.user}@${value.server}`;
          return null;
        };

        try {
          const wid = window.require('WAWebWidFactory').createWid(lidId);
          const phone = window.require('WAWebApiContact').getPhoneNumber(wid);
          const phoneId = toId(phone);
          if (phoneId && !phoneId.endsWith('@lid')) return phoneId;
        } catch {
          // continue
        }

        try {
          if (window.WWebJS?.enforceLidAndPnRetrieval) {
            const result = await window.WWebJS.enforceLidAndPnRetrieval(lidId);
            const phoneId = toId(result?.phone);
            if (phoneId && !phoneId.endsWith('@lid')) return phoneId;
          }
        } catch {
          // continue
        }

        try {
          const contact = window.require('WAWebCollections').Contact.get(lidId);
          const phoneId = toId(contact?.phoneNumber);
          if (phoneId && !phoneId.endsWith('@lid')) return phoneId;
        } catch {
          // continue
        }

        return lidId;
      }, id),
      10000,
      'Resolve chat id'
    );
    if (resolved && resolved !== id) {
      console.log(`Resolved chat id ${id} → ${resolved}`);
    }
    return resolved || id;
  } catch (err) {
    console.warn(`Could not resolve ${id}:`, err.message);
    return id;
  }
}

function normalizePollOptions(options) {
  const cleaned = (options || []).map((o) => String(o || '').trim()).filter(Boolean);
  if (cleaned.length < 2) {
    throw new Error('A poll needs at least 2 options');
  }
  if (cleaned.length > 12) {
    throw new Error('WhatsApp polls support up to 12 options');
  }

  const seen = new Set();
  for (const opt of cleaned) {
    if (opt.length > 100) {
      throw new Error(`Poll option is too long (max 100 characters): "${opt.slice(0, 40)}…"`);
    }
    const key = opt.toLowerCase();
    if (seen.has(key)) {
      throw new Error(`Duplicate poll option "${opt}". Each option must be unique for WhatsApp to send the poll.`);
    }
    seen.add(key);
  }

  return cleaned;
}

async function sendPollToChats({
  question,
  options,
  chatIds,
  allowMultiple = false,
  humanDelayMin = 3,
  humanDelayMax = 12,
}) {
  if (!client || (connectionState !== 'ready' && connectionState !== 'authenticated')) {
    throw new Error('WhatsApp is not connected');
  }

  // Prefer marking ready if we can — sending while only authenticated often works after link
  if (connectionState !== 'ready') {
    await tryFinalizeReady(client).catch(() => {});
  }
  if (!client) {
    throw new Error('WhatsApp is not connected');
  }

  const cleanQuestion = String(question || '').trim();
  if (!cleanQuestion) {
    throw new Error('Poll question is required');
  }
  if (cleanQuestion.length > 255) {
    throw new Error('Poll question is too long (max 255 characters)');
  }

  const cleanOptions = normalizePollOptions(options);
  if (!chatIds?.length) {
    throw new Error('Select at least one chat');
  }

  const poll = new Poll(cleanQuestion, cleanOptions, {
    allowMultipleAnswers: allowMultiple,
  });

  const results = [];

  for (let i = 0; i < chatIds.length; i++) {
    const originalId = chatIds[i];
    let chatId = originalId;

    try {
      chatId = await resolveChatId(originalId);

      await staggeredChatDelay(i, {
        minSeconds: humanDelayMin,
        maxSeconds: humanDelayMax,
      });

      let chat = null;
      try {
        chat = await withTimeout(client.getChatById(chatId), 15000, 'Load chat');
      } catch (err) {
        console.warn(`getChatById failed for ${chatId}:`, err.message);
        // Try opening/creating chat via WID find
        try {
          await client.pupPage.evaluate(async (id) => {
            const wid = window.require('WAWebWidFactory').createWid(id);
            await window.require('WAWebCollections').Chat.find(wid);
          }, chatId);
          chat = await client.getChatById(chatId).catch(() => null);
        } catch {
          // continue — sendMessage may still work
        }
      }

      if (chat) {
        await humanLikeDelay(chat, cleanQuestion, {
          minSeconds: Math.min(humanDelayMin, 3),
          maxSeconds: Math.min(humanDelayMax, 6),
        });
      } else {
        await sleep(randomBetween(800, 2000));
      }

      // waitUntilMsgSent:true can hang forever on some polls (esp. LID / duplicates)
      await withTimeout(
        client.sendMessage(chatId, poll, {
          sendSeen: false,
          waitUntilMsgSent: false,
        }),
        45000,
        'Send poll'
      );

      results.push({ chatId, success: true });
      console.log(`Poll sent to ${chatId}`);
    } catch (err) {
      console.error(`Poll send failed for ${originalId}:`, err.message);
      results.push({ chatId: originalId, success: false, error: err.message || 'Send failed' });
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

  // Connect/retry must never wipe a saved login. Only Disconnect may reset.
  if (resetSession) {
    console.warn('Ignoring resetSession on connect — use Disconnect to clear login');
    resetSession = false;
  }

  // Already authenticated with a live browser — never restart Chromium just to "force".
  // Restarting is what left the UI stuck on Connecting while WhatsApp stayed linked.
  if (client && connectionState === 'authenticated') {
    startReadyCheck(client);
    tryFinalizeReady(client).catch(() => {});
    return;
  }

  if (client && connectionState === 'qr' && lastQrDataUrl && !force) {
    return;
  }

  const timeoutMs = hasSavedSession() ? RESTORE_TIMEOUT_MS : CONNECTING_TIMEOUT_MS;
  const connectingTimedOut =
    connectionState === 'connecting' &&
    connectingSince > 0 &&
    Date.now() - connectingSince > timeoutMs;

  // Session restore can take longer than a fresh QR; don't thrash the browser.
  const restoreGraceMs = hasSavedSession() ? RESTORE_TIMEOUT_MS : QR_TARGET_MS;
  const stuckWithoutQr =
    connectionState === 'connecting' &&
    connectingSince > 0 &&
    Date.now() - connectingSince > restoreGraceMs &&
    !lastQrDataUrl &&
    !client;

  const shouldForce = (force || connectingTimedOut || stuckWithoutQr) && !(client && connectionState === 'authenticated');

  if (initInProgress && !shouldForce) return;
  if (connectionState === 'qr' && lastQrDataUrl && !shouldForce) return;

  initInProgress = true;
  if (connectionState !== 'authenticated') {
    connectionState = 'connecting';
    connectingSince = Date.now();
  }

  initialize({ force: shouldForce, resetSession: false })
    .catch((err) => {
      console.error('WhatsApp connection failed:', err.message);
      // Keep authenticated state if we already linked — UI can still recover
      if (connectionState === 'connecting') {
        connectionState = hasSavedSession() ? 'authenticated' : 'disconnected';
        connectingSince = 0;
        if (connectionState === 'authenticated' && client) {
          startReadyCheck(client);
        }
      }
    })
    .finally(() => {
      initInProgress = false;
    });
}

function hasSavedSession() {
  try {
    // Currently linked in this process
    if (connectionState === 'ready' || connectionState === 'authenticated') return true;

    // Firebase/Mongo RemoteAuth
    if (USE_REMOTE_AUTH && (remoteSessionKnown || getRemoteSessionStore()?.cachedExists)) {
      return true;
    }

    if (fs.existsSync(AUTH_MARKER_PATH)) return true;

    // LocalAuth migration fallback
    const waIdb = path.join(
      SESSION_PATH,
      'session',
      'Default',
      'IndexedDB',
      'https_web.whatsapp.com_0.indexeddb.leveldb'
    );
    const localStorageDir = path.join(
      SESSION_PATH,
      'session',
      'Default',
      'Local Storage',
      'leveldb'
    );
    if (!fs.existsSync(waIdb) || !fs.existsSync(localStorageDir)) return false;

    let total = 0;
    for (const file of fs.readdirSync(waIdb)) {
      try {
        total += fs.statSync(path.join(waIdb, file)).size;
      } catch {
        // ignore
      }
    }
    return total > 50_000;
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
  if (!hasSavedSession()) {
    return;
  }
  console.log('Saved WhatsApp session found — restoring login automatically');
  warmupStarted = true;
  startConnection({ force: false, resetSession: false });
}

function resetWarmup() {
  warmupStarted = false;
}

module.exports = {
  initialize,
  startConnection,
  warmupConnection,
  refreshRemoteSessionCache,
  hydrateContactsFromStore,
  disconnect,
  getStatus,
  refreshStatus,
  getChats,
  searchChats,
  sendPollToChats,
  isReady,
  hasSavedSession,
  getContactStats,
  on,
  USE_REMOTE_AUTH,
  remoteBackend: () => remoteBackend,
};
