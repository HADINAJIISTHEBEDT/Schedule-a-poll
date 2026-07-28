/**
 * Local-first backend (like `npm start` → http://localhost:3000).
 * WhatsApp login is saved on the SERVER disk under data/whatsapp-session/.
 * The APK only stores the server URL + a UI hint of who is linked.
 */
const DEFAULT_API_BASE = 'http://localhost:3000';

const STORAGE_KEYS = {
  apiBase: 'apiBase',
  ingressToken: 'ingressToken',
  waLinked: 'waLinked',
  waProfile: 'waProfile',
  lastReadyAt: 'waLastReadyAt',
};

function isCapacitorApp() {
  return window.Capacitor?.isNativePlatform?.() || /Capacitor/i.test(navigator.userAgent);
}

function storageGet(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function storageSet(key, value) {
  try {
    if (value == null || value === '') localStorage.removeItem(key);
    else localStorage.setItem(key, String(value));
  } catch {
    // private mode / blocked storage
  }
}

function normalizeApiBase(url) {
  return String(url || '')
    .trim()
    .replace(/\/$/, '')
    .replace(/\?.*$/, '');
}

function isEphemeralAgentUrl(url) {
  return /agent\.cvm\.dev/i.test(String(url || ''));
}

function isRenderUrl(url) {
  return /onrender\.com/i.test(String(url || ''));
}

/** Prefer localhost / LAN. Drop expired cloud-agent hosts. Keep Render only if user chose it. */
function migrateAwayFromExpiredHosts() {
  try {
    const saved = normalizeApiBase(storageGet(STORAGE_KEYS.apiBase) || '');
    if (isEphemeralAgentUrl(saved)) {
      storageSet(STORAGE_KEYS.apiBase, DEFAULT_API_BASE);
      storageSet(STORAGE_KEYS.ingressToken, '');
    }
  } catch {
    // ignore
  }
}

function getIngressToken() {
  const base = getApiBase();
  if (!isEphemeralAgentUrl(base)) return '';
  return String(storageGet(STORAGE_KEYS.ingressToken) || '').trim();
}

function setIngressToken(token) {
  storageSet(STORAGE_KEYS.ingressToken, String(token || '').trim());
}

function getApiBase() {
  // Browser on the same machine/server as the app → same-origin (true localhost feel)
  if (!isCapacitorApp()) return '';

  migrateAwayFromExpiredHosts();
  const saved = normalizeApiBase(storageGet(STORAGE_KEYS.apiBase) || '');
  if (saved && !isEphemeralAgentUrl(saved)) return saved;
  return DEFAULT_API_BASE;
}

function setApiBase(url) {
  const raw = String(url || '').trim();
  try {
    const parsed = new URL(raw);
    const token = parsed.searchParams.get('_ingress_token');
    if (token) setIngressToken(token);
    else if (!isEphemeralAgentUrl(parsed.origin)) setIngressToken('');

    let value = normalizeApiBase(
      `${parsed.origin}${parsed.pathname}`.replace(/\/download\/apk\/?$/i, '')
    );
    if (isEphemeralAgentUrl(value)) value = DEFAULT_API_BASE;

    storageSet(STORAGE_KEYS.apiBase, value);
    return;
  } catch {
    // not a full URL
  }

  let value = normalizeApiBase(raw);
  if (isEphemeralAgentUrl(value)) value = DEFAULT_API_BASE;
  storageSet(STORAGE_KEYS.apiBase, value);
}

/** Persist linked WhatsApp profile in localStorage (UI restore hint). */
function saveWhatsAppLogin(connectedInfo) {
  storageSet(STORAGE_KEYS.waLinked, '1');
  storageSet(STORAGE_KEYS.lastReadyAt, new Date().toISOString());
  if (connectedInfo && typeof connectedInfo === 'object') {
    try {
      storageSet(
        STORAGE_KEYS.waProfile,
        JSON.stringify({
          pushname: connectedInfo.pushname || null,
          phone: connectedInfo.phone || null,
          platform: connectedInfo.platform || null,
        })
      );
    } catch {
      // ignore
    }
  }
}

function clearWhatsAppLogin() {
  storageSet(STORAGE_KEYS.waLinked, '');
  storageSet(STORAGE_KEYS.waProfile, '');
  storageSet(STORAGE_KEYS.lastReadyAt, '');
}

function getSavedWhatsAppLogin() {
  const linked = storageGet(STORAGE_KEYS.waLinked) === '1';
  let profile = null;
  try {
    profile = JSON.parse(storageGet(STORAGE_KEYS.waProfile) || 'null');
  } catch {
    profile = null;
  }
  return {
    linked,
    profile,
    lastReadyAt: storageGet(STORAGE_KEYS.lastReadyAt) || null,
  };
}

function apiUrl(path) {
  return `${getApiBase()}${path}`;
}

function buildNativeHeaders(options = {}) {
  const headers = {};
  const incoming = options.headers || {};
  if (incoming instanceof Headers) {
    incoming.forEach((value, key) => {
      headers[key] = value;
    });
  } else {
    Object.assign(headers, incoming);
  }

  const token = getIngressToken();
  if (token) {
    headers.Cookie = `_ingress_token=${token}`;
  }
  return headers;
}

function toResponseLike(status, data) {
  const text =
    typeof data === 'string' ? data : data == null ? '' : JSON.stringify(data);
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      if (typeof data === 'object' && data !== null) return data;
      if (!text) return null;
      return JSON.parse(text);
    },
    async text() {
      return text;
    },
  };
}

async function apiFetch(path, options = {}) {
  const base = getApiBase();
  const url = apiUrl(path);
  const method = (options.method || 'GET').toUpperCase();
  const headers = buildNativeHeaders(options);
  const token = getIngressToken();

  const Http = window.Capacitor?.Plugins?.CapacitorHttp;
  if (isCapacitorApp() && Http?.request) {
    try {
      const request = {
        url,
        method,
        headers,
        connectTimeout: 60000,
        readTimeout: 60000,
      };

      if (options.body != null) {
        if (typeof options.body === 'string') {
          try {
            request.data = JSON.parse(options.body);
            if (!headers['Content-Type'] && !headers['content-type']) {
              headers['Content-Type'] = 'application/json';
            }
          } catch {
            request.data = options.body;
          }
        } else {
          request.data = options.body;
        }
      }

      const result = await Http.request(request);
      return toResponseLike(result.status, result.data);
    } catch (err) {
      throw new Error(
        base
          ? `Unable to reach server (${base}). Is npm start running on your PC?`
          : err.message || 'Unable to reach server'
      );
    }
  }

  let finalUrl = url;
  if (token) {
    finalUrl += (finalUrl.includes('?') ? '&' : '?') + `_ingress_token=${encodeURIComponent(token)}`;
  }

  try {
    return await fetch(finalUrl, {
      ...options,
      credentials: 'include',
      headers,
    });
  } catch (err) {
    throw new Error(
      base
        ? `Unable to reach server (${base}). For local use start the app with npm start, then open http://localhost:3000`
        : err.message || 'Unable to reach server'
    );
  }
}

async function readApiJson(res) {
  const text = await res.text();
  if (!text) {
    if (!res.ok) throw new Error(`Request failed (${res.status})`);
    return null;
  }

  if (/^\s*</.test(text) || /Redirecting to login|Cloud Agent Login|network token/i.test(text)) {
    throw new Error(
      'Unable to reach server — set Server settings to your PC address (e.g. http://192.168.1.10:3000 or http://localhost:3000)'
    );
  }

  try {
    return JSON.parse(text);
  } catch {
    throw new Error(res.ok ? 'Invalid response from server' : `Request failed (${res.status})`);
  }
}

migrateAwayFromExpiredHosts();
