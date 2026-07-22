function isCapacitorApp() {
  return window.Capacitor?.isNativePlatform?.() || /Capacitor/i.test(navigator.userAgent);
}

function getApiBase() {
  if (!isCapacitorApp()) return '';
  return (localStorage.getItem('apiBase') || '').replace(/\/$/, '');
}

function setApiBase(url) {
  const value = (url || '').trim().replace(/\/$/, '');
  if (value) localStorage.setItem('apiBase', value);
  else localStorage.removeItem('apiBase');
}

function apiFetch(path, options) {
  return fetch(`${getApiBase()}${path}`, options);
}
