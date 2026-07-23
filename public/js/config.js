/** Default backend for the Android APK (Capacitor). Web browser uses same-origin. */
const DEFAULT_API_BASE = 'https://schedule-a-poll.onrender.com';

function isCapacitorApp() {
  return window.Capacitor?.isNativePlatform?.() || /Capacitor/i.test(navigator.userAgent);
}

function normalizeApiBase(url) {
  return String(url || '')
    .trim()
    .replace(/\/$/, '');
}

function isUnreachableDevProxy(url) {
  // Cursor cloud agent port proxies require browser login and fail from the APK.
  return /agent\.cvm\.dev/i.test(url || '');
}

function getApiBase() {
  if (!isCapacitorApp()) return '';
  const saved = normalizeApiBase(localStorage.getItem('apiBase') || '');
  if (saved && !isUnreachableDevProxy(saved)) return saved;
  if (saved && isUnreachableDevProxy(saved)) {
    localStorage.setItem('apiBase', DEFAULT_API_BASE);
  }
  return DEFAULT_API_BASE;
}

function setApiBase(url) {
  const value = normalizeApiBase(url);
  if (value) localStorage.setItem('apiBase', value);
  else localStorage.removeItem('apiBase');
}

function apiUrl(path) {
  return `${getApiBase()}${path}`;
}

function apiFetch(path, options) {
  const url = apiUrl(path);
  return fetch(url, options).catch((err) => {
    const base = getApiBase();
    throw new Error(
      base
        ? `Unable to reach server (${base}). Check the server URL in settings.`
        : err.message || 'Unable to reach server'
    );
  });
}

async function readApiJson(res) {
  const text = await res.text();
  if (!text) {
    if (!res.ok) throw new Error(`Request failed (${res.status})`);
    return null;
  }

  // Login/HTML redirects (e.g. protected proxies) are not JSON
  if (/^\s*</.test(text) || /Redirecting to login/i.test(text)) {
    throw new Error('Unable to reach server — update the server URL in settings');
  }

  try {
    return JSON.parse(text);
  } catch {
    throw new Error(res.ok ? 'Invalid response from server' : `Request failed (${res.status})`);
  }
}
