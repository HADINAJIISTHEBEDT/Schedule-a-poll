/** Permanent production backend (Render). Always-on — not a temporary cloud-agent URL. */
const DEFAULT_API_BASE = 'https://schedule-a-poll.onrender.com';

function isCapacitorApp() {
  return window.Capacitor?.isNativePlatform?.() || /Capacitor/i.test(navigator.userAgent);
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

/** Drop expired Cursor cloud-agent URLs and always prefer the permanent Render host. */
function migrateToPermanentServer() {
  try {
    const saved = normalizeApiBase(localStorage.getItem('apiBase') || '');
    if (!saved || isEphemeralAgentUrl(saved)) {
      localStorage.setItem('apiBase', DEFAULT_API_BASE);
      localStorage.removeItem('ingressToken');
    }
  } catch {
    // private mode / blocked storage
  }
}

function getIngressToken() {
  // Render does not need an ingress token. Only keep a token if the user
  // explicitly points at a temporary agent URL in settings.
  const base = getApiBase();
  if (!isEphemeralAgentUrl(base)) return '';
  return (localStorage.getItem('ingressToken') || '').trim();
}

function setIngressToken(token) {
  const value = String(token || '').trim();
  if (value) localStorage.setItem('ingressToken', value);
  else localStorage.removeItem('ingressToken');
}

function getApiBase() {
  if (!isCapacitorApp()) return '';
  migrateToPermanentServer();
  const saved = normalizeApiBase(localStorage.getItem('apiBase') || '');
  if (saved && !isEphemeralAgentUrl(saved)) return saved;
  return DEFAULT_API_BASE;
}

function setApiBase(url) {
  const raw = String(url || '').trim();
  // Allow pasting a full download/apk link with ?_ingress_token=...
  try {
    const parsed = new URL(raw);
    const token = parsed.searchParams.get('_ingress_token');
    if (token) setIngressToken(token);
    else if (!isEphemeralAgentUrl(parsed.origin)) setIngressToken('');

    let value = normalizeApiBase(
      `${parsed.origin}${parsed.pathname}`.replace(/\/download\/apk\/?$/i, '')
    );
    // Never keep expired temporary agent hosts as the default
    if (isEphemeralAgentUrl(value)) value = DEFAULT_API_BASE;

    if (value) localStorage.setItem('apiBase', value);
    else localStorage.removeItem('apiBase');
    return;
  } catch {
    // not a full URL
  }

  let value = normalizeApiBase(raw);
  if (isEphemeralAgentUrl(value)) value = DEFAULT_API_BASE;
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

  // Browser fallback: include token in query only when needed (temporary agent hosts).
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
    throw new Error('Unable to reach server — update the server URL in settings to https://schedule-a-poll.onrender.com');
  }

  try {
    return JSON.parse(text);
  } catch {
    throw new Error(res.ok ? 'Invalid response from server' : `Request failed (${res.status})`);
  }
}

// Run once on load for already-installed APKs that still have the old agent URL.
migrateToPermanentServer();
