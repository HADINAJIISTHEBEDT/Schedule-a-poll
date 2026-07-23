/** Default backend for the Android APK (Capacitor). Web browser uses same-origin. */
const DEFAULT_API_BASE =
  'https://p-3000-pod-zjtooarazvct5k5p7bt7e7wbum-17ca231a51b199cf3a49-us3.agent.cvm.dev';

function isCapacitorApp() {
  return window.Capacitor?.isNativePlatform?.() || /Capacitor/i.test(navigator.userAgent);
}

function getApiBase() {
  if (!isCapacitorApp()) return '';
  const saved = (localStorage.getItem('apiBase') || '').trim().replace(/\/$/, '');
  if (saved) return saved;
  return DEFAULT_API_BASE.replace(/\/$/, '');
}

function setApiBase(url) {
  const value = (url || '').trim().replace(/\/$/, '');
  if (value) localStorage.setItem('apiBase', value);
  else localStorage.removeItem('apiBase');
}

function apiUrl(path) {
  return `${getApiBase()}${path}`;
}

function apiFetch(path, options) {
  return fetch(apiUrl(path), options);
}

async function readApiJson(res) {
  const text = await res.text();
  if (!text) {
    if (!res.ok) throw new Error(`Request failed (${res.status})`);
    return null;
  }

  try {
    return JSON.parse(text);
  } catch {
    throw new Error(res.ok ? 'Invalid response from server' : `Request failed (${res.status})`);
  }
}
