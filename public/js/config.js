/** Default backend for the Android APK (Capacitor). Web browser uses same-origin. */
const DEFAULT_API_BASE =
  'https://p-3000-pod-vdzcpbtkyndxlpcmjqfuozh5o4-8d6b3a75d5a0d05a8a0f-us3.agent.cvm.dev';

/** Cursor cloud ingress token — required for the APK to reach the agent URL. */
const DEFAULT_INGRESS_TOKEN = 'nto-frwbpiremvehxl25t44fr7nzpe';

function isCapacitorApp() {
  return window.Capacitor?.isNativePlatform?.() || /Capacitor/i.test(navigator.userAgent);
}

function normalizeApiBase(url) {
  return String(url || '')
    .trim()
    .replace(/\/$/, '')
    .replace(/\?.*$/, '');
}

/** Per-browser-tab device id (sessionStorage) — never persists WhatsApp login. */
function getDeviceId() {
  const key = 'waDeviceId';
  try {
    let id = sessionStorage.getItem(key);
    if (!id) {
      id =
        typeof crypto !== 'undefined' && crypto.randomUUID
          ? crypto.randomUUID()
          : `dev-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      sessionStorage.setItem(key, id);
    }
    return id;
  } catch {
    return `dev-${Date.now()}`;
  }
}

/** Remove any leftover permanent-login keys from older builds. */
function clearSavedWhatsAppLoginKeys() {
  try {
    ['waLinked', 'waProfile', 'waLastReadyAt'].forEach((k) => localStorage.removeItem(k));
  } catch {
    // ignore
  }
}

function getIngressToken() {
  const saved = (localStorage.getItem('ingressToken') || '').trim();
  if (saved) return saved;
  const base = getApiBase();
  if (/agent\.cvm\.dev/i.test(base)) return DEFAULT_INGRESS_TOKEN;
  return '';
}

function setIngressToken(token) {
  const value = String(token || '').trim();
  if (value) localStorage.setItem('ingressToken', value);
  else localStorage.removeItem('ingressToken');
}

function getApiBase() {
  if (!isCapacitorApp()) return '';
  const saved = normalizeApiBase(localStorage.getItem('apiBase') || '');
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
    const value = normalizeApiBase(`${parsed.origin}${parsed.pathname}`.replace(/\/download\/apk\/?$/i, ''));
    if (value) localStorage.setItem('apiBase', value);
    else localStorage.removeItem('apiBase');
    return;
  } catch {
    // not a full URL
  }

  const value = normalizeApiBase(raw);
  if (value) localStorage.setItem('apiBase', value);
  else localStorage.removeItem('apiBase');
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
  headers['X-Device-Id'] = getDeviceId();
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
  const method = (options.method || 'GET').toUpperCase();
  const headers = buildNativeHeaders(options);
  const token = getIngressToken();
  const deviceId = getDeviceId();

  // Put deviceId in the query too — some proxies strip custom headers.
  let url = apiUrl(path);
  const join = url.includes('?') ? '&' : '?';
  url += `${join}deviceId=${encodeURIComponent(deviceId)}`;

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
      } else if (method === 'POST' || method === 'PUT' || method === 'PATCH') {
        request.data = { deviceId };
        if (!headers['Content-Type'] && !headers['content-type']) {
          headers['Content-Type'] = 'application/json';
        }
      }

      // Always include deviceId on JSON bodies
      if (request.data && typeof request.data === 'object' && !Array.isArray(request.data)) {
        request.data.deviceId = deviceId;
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

  let body = options.body;
  if (body && typeof body === 'string') {
    try {
      const parsed = JSON.parse(body);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        parsed.deviceId = deviceId;
        body = JSON.stringify(parsed);
      }
    } catch {
      // leave body as-is
    }
  }

  try {
    return await fetch(finalUrl, {
      ...options,
      body,
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

clearSavedWhatsAppLoginKeys();
