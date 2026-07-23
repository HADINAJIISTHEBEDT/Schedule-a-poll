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
