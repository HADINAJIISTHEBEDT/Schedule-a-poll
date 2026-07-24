/** Default backend for the Android APK (Capacitor). Web browser uses same-origin. */
const DEFAULT_API_BASE =
  'https://p-3000-pod-vdzcpbtkyndxlpcmjqfuozh5o4-8d6b3a75d5a0d05a8a0f-us3.agent.cvm.dev';

/** Cursor cloud ingress token — required for the APK to reach the agent URL. */
const DEFAULT_INGRESS_TOKEN = 'nto-frwbpiremvehxl25t44fr7nzpe';

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

function ensureLoginDefaultsInStorage() {
  // Write defaults once so APK/web keep the same server after restarts
  if (isCapacitorApp()) {
    if (!normalizeApiBase(storageGet(STORAGE_KEYS.apiBase) || '')) {
      storageSet(STORAGE_KEYS.apiBase, DEFAULT_API_BASE);
    }
    const base = getApiBase();
    if (/agent\.cvm\.dev/i.test(base) && !String(storageGet(STORAGE_KEYS.ingressToken) || '').trim()) {
      storageSet(STORAGE_KEYS.ingressToken, DEFAULT_INGRESS_TOKEN);
    }
  }
}

function getIngressToken() {
  const saved = String(storageGet(STORAGE_KEYS.ingressToken) || '').trim();
  if (saved) return saved;
  const base = getApiBase();
  if (/agent\.cvm\.dev/i.test(base)) return DEFAULT_INGRESS_TOKEN;
  return '';
}

function setIngressToken(token) {
  storageSet(STORAGE_KEYS.ingressToken, String(token || '').trim());
}

function getApiBase() {
  if (!isCapacitorApp()) return '';
  const saved = normalizeApiBase(storageGet(STORAGE_KEYS.apiBase) || '');
  if (saved) return saved;
  return DEFAULT_API_BASE;
}

function setApiBase(url) {
  const raw = String(url || '').trim();
  // Allow pasting a full download/apk link with ?_ingress_token=...
  try {
    const parsed = new URL(raw);
    const token = parsed.searchParams.get('_ingress_token');
    if (token) setIngressToken(token);
    const value = normalizeApiBase(
      `${parsed.origin}${parsed.pathname}`.replace(/\/download\/apk\/?$/i, '')
    );
    storageSet(STORAGE_KEYS.apiBase, value);
    return;
  } catch {
    // not a full URL
  }

  storageSet(STORAGE_KEYS.apiBase, normalizeApiBase(raw));
}

/** Save WhatsApp linked profile in localStorage (UI + restore hint). */
function saveWhatsAppLogin(connectedInfo) {
  storageSet(STORAGE_KEYS.waLinked, '1');
  storageSet(STORAGE_KEYS.lastReadyAt, new Date().toISOString());
  if (connectedInfo && typeof connectedInfo === 'object') {
    try {
      storageSet(STORAGE_KEYS.waProfile, JSON.stringify({
        pushname: connectedInfo.pushname || null,
        phone: connectedInfo.phone || null,
        platform: connectedInfo.platform || null,
      }));
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

  // Capacitor native HTTP can send Cookie headers (browser fetch cannot).
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
          ? `Unable to reach server (${base}). ${err.message || ''}`.trim()
          : err.message || 'Unable to reach server'
      );
    }
  }

  // Browser fallback: include token in query + credentials for cookie.
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
        ? `Unable to reach server (${base}). Check the server URL in settings.`
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
    throw new Error('Unable to reach server — update the server URL / token in settings');
  }

  try {
    return JSON.parse(text);
  } catch {
    throw new Error(res.ok ? 'Invalid response from server' : `Request failed (${res.status})`);
  }
}
