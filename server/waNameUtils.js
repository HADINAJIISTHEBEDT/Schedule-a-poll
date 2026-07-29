/**
 * Shared contact name helpers for Node cache search + in-page WhatsApp search.
 * BROWSER_SOURCE is injected into puppeteer evaluate() — keep logic identical.
 */

function toNameString(value, depth = 0) {
  if (value == null || depth > 3) return '';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    const text = String(value).trim();
    if (!text || text === '[object Object]' || text === '[object Object Object]') return '';
    return text;
  }
  if (typeof value !== 'object') return '';

  // WhatsApp sometimes returns nested name objects / Wid-like values
  const keys = [
    '_serialized',
    'formattedName',
    'formattedTitle',
    'displayName',
    'pushname',
    'notifyName',
    'verifiedName',
    'shortName',
    'searchName',
    'name',
    'text',
    'value',
    'user',
  ];
  for (const key of keys) {
    if (value[key] != null) {
      const nested = toNameString(value[key], depth + 1);
      if (nested) return nested;
    }
  }
  if (typeof value.toString === 'function') {
    try {
      const raw = value.toString();
      if (raw && raw !== '[object Object]' && !raw.startsWith('[object ')) {
        return String(raw).trim();
      }
    } catch {
      // ignore
    }
  }
  return '';
}

function isPhoneLike(text) {
  const t = toNameString(text);
  if (!t) return true;
  // +961 70..., 96170..., bare digits, etc.
  if (/^\+?\d[\d\s\-().]{4,}$/.test(t)) return true;
  if (/^\d{6,}$/.test(t.replace(/\D/g, '')) && t.replace(/\D/g, '').length >= Math.max(6, t.length - 2)) {
    return !/[a-zA-Z\u0600-\u06FF]/.test(t);
  }
  return false;
}

function pickBestName(names, fallback) {
  const list = (names || []).map((n) => toNameString(n)).filter(Boolean);
  const human = list.filter((n) => !isPhoneLike(n));
  if (human.length) {
    human.sort((a, b) => b.length - a.length);
    return human[0];
  }
  if (list.length) return list[0];
  const fb = toNameString(fallback);
  return fb || 'Unknown';
}

/**
 * Fold Arabic + Arabizi (chat alphabet) so "7ayety" matches "حياتي" / "Hayaty".
 */
function foldArabizi(text) {
  return toNameString(text)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/ح/g, '7')
    .replace(/خ/g, '5')
    .replace(/ع/g, '3')
    .replace(/غ/g, '8')
    .replace(/ق/g, '9')
    .replace(/ء|أ|إ|آ|ا|ى|ة/g, 'a')
    .replace(/ي/g, 'y')
    .replace(/و/g, 'w')
    .replace(/ه/g, 'h')
    .replace(/ت|ط|ة/g, 't')
    .replace(/ث/g, 't')
    .replace(/د|ض/g, 'd')
    .replace(/س|ص/g, 's')
    .replace(/ش/g, 'sh')
    .replace(/ز|ظ/g, 'z')
    .replace(/ر/g, 'r')
    .replace(/ب/g, 'b')
    .replace(/ف/g, 'f')
    .replace(/ك|ق/g, 'k')
    .replace(/ل/g, 'l')
    .replace(/م/g, 'm')
    .replace(/ن/g, 'n')
    .replace(/ج/g, 'j')
    .replace(/^h(?=[aeiouwy])/, '7')
    .replace(/[^\p{L}\p{N}]+/gu, '')
    .trim();
}

function consonantSkeleton(text) {
  return foldArabizi(text).replace(/[aeiou]/g, '');
}

function editDistance(a, b) {
  const s = String(a || '');
  const t = String(b || '');
  if (s === t) return 0;
  if (!s.length) return t.length;
  if (!t.length) return s.length;
  if (Math.abs(s.length - t.length) > 2) return 99;
  const prev = new Array(t.length + 1);
  const cur = new Array(t.length + 1);
  for (let j = 0; j <= t.length; j++) prev[j] = j;
  for (let i = 1; i <= s.length; i++) {
    cur[0] = i;
    for (let j = 1; j <= t.length; j++) {
      const cost = s[i - 1] === t[j - 1] ? 0 : 1;
      cur[j] = Math.min(cur[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    for (let j = 0; j <= t.length; j++) prev[j] = cur[j];
  }
  return prev[t.length];
}

function tokenizeName(text) {
  return toNameString(text)
    .split(/[^\p{L}\p{N}]+/u)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2);
}

function namesMatch(nameOrNames, id, term) {
  const values = Array.isArray(nameOrNames) ? nameOrNames : [nameOrNames];
  const rawNeedle = toNameString(term)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim();
  if (!rawNeedle) return false;
  const foldedNeedle = foldArabizi(term);

  for (const value of values) {
    const text = toNameString(value);
    if (!text) continue;

    const lower = text
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '');

    // Direct match — "Nouraty 7ayety" contains "7ayety"
    if (lower.includes(rawNeedle)) return true;

    // Token-level Arabizi / Arabic — require near-equality on a token,
    // NOT loose consonant skeletons (that falsely matched "عائلتي حياتي")
    for (const token of tokenizeName(text)) {
      const tokenLower = token
        .toLowerCase()
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '');
      if (tokenLower.includes(rawNeedle)) return true;

      const foldedToken = foldArabizi(token);
      if (!foldedToken) continue;
      if (foldedToken === foldedNeedle) return true;
      if (foldedToken.includes(foldedNeedle) && foldedToken.length <= foldedNeedle.length + 1) {
        return true;
      }
      if (foldedNeedle.includes(foldedToken) && foldedNeedle.length <= foldedToken.length + 1) {
        return true;
      }
    }

    const idPart = String(id || '').split('@')[0];
    if (foldArabizi(idPart).includes(foldedNeedle) && foldedNeedle.length >= 3) return true;

    const digits = idPart.replace(/\D/g, '');
    const termDigits = String(term || '').replace(/\D/g, '');
    if (termDigits.length >= 3 && digits.includes(termDigits)) return true;
  }

  return false;
}

/** Prefer phone (@c.us) over LID duplicates with the same display name. */
function dedupeSearchResults(results = []) {
  const rank = (id) => {
    const s = String(id || '');
    if (s.endsWith('@c.us')) return 0;
    if (s.endsWith('@g.us')) return 1;
    if (s.endsWith('@lid')) return 3;
    return 2;
  };
  const sorted = [...results].sort((a, b) => rank(a.id) - rank(b.id));
  const seenName = new Set();
  const out = [];
  for (const item of sorted) {
    const key = foldArabizi(item.name) || String(item.id || '');
    if (key && seenName.has(key)) continue;
    if (key) seenName.add(key);
    out.push(item);
  }
  return out;
}

function preferBetterName(current, incoming) {
  const a = toNameString(current);
  const b = toNameString(incoming);
  if (!b) return a || b;
  if (!a) return b;
  if (a === '[object Object]') return b;
  if (b === '[object Object]') return a;
  if (isPhoneLike(a) && !isPhoneLike(b)) return b;
  if (!isPhoneLike(a) && isPhoneLike(b)) return a;
  return a.length >= b.length ? a : b;
}

function sanitizeChat(chat = {}) {
  const id = toNameString(chat.id) || (typeof chat.id === 'string' ? chat.id : '');
  const name = pickBestName([chat.name, chat.formattedTitle, chat.pushname], id.split('@')[0] || 'Unknown');
  return {
    id,
    name: name && name !== '[object Object]' ? name : id.split('@')[0] || 'Unknown',
    isGroup: Boolean(chat.isGroup),
  };
}

/** Source injected into the WhatsApp page (must stay in sync with functions above). */
const BROWSER_SOURCE = `
  function toNameString(value, depth) {
    depth = depth || 0;
    if (value == null || depth > 3) return '';
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      const text = String(value).trim();
      if (!text || text === '[object Object]' || text.indexOf('[object ') === 0) return '';
      return text;
    }
    if (typeof value !== 'object') return '';
    const keys = [
      '_serialized', 'formattedName', 'formattedTitle', 'displayName', 'pushname',
      'notifyName', 'verifiedName', 'shortName', 'searchName', 'name', 'text', 'value', 'user'
    ];
    for (var i = 0; i < keys.length; i++) {
      if (value[keys[i]] != null) {
        var nested = toNameString(value[keys[i]], depth + 1);
        if (nested) return nested;
      }
    }
    try {
      if (typeof value.toString === 'function') {
        var raw = value.toString();
        if (raw && raw !== '[object Object]' && raw.indexOf('[object ') !== 0) return String(raw).trim();
      }
    } catch (_) {}
    return '';
  }

  function isPhoneLike(text) {
    const t = toNameString(text);
    if (!t) return true;
    if (/^\\+?\\d[\\d\\s\\-().]{4,}$/.test(t)) return true;
    if (/^\\d{6,}$/.test(t.replace(/\\D/g, '')) && t.replace(/\\D/g, '').length >= Math.max(6, t.length - 2)) {
      return !/[a-zA-Z\\u0600-\\u06FF]/.test(t);
    }
    return false;
  }

  function pickBestName(names, fallback) {
    const list = (names || []).map((n) => toNameString(n)).filter(Boolean);
    const human = list.filter((n) => !isPhoneLike(n));
    if (human.length) {
      human.sort((a, b) => b.length - a.length);
      return human[0];
    }
    if (list.length) return list[0];
    const fb = toNameString(fallback);
    return fb || 'Unknown';
  }

  function foldArabizi(text) {
    return toNameString(text)
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[\\u0300-\\u036f]/g, '')
      .replace(/ح/g, '7')
      .replace(/خ/g, '5')
      .replace(/ع/g, '3')
      .replace(/غ/g, '8')
      .replace(/ق/g, '9')
      .replace(/ء|أ|إ|آ|ا|ى|ة/g, 'a')
      .replace(/ي/g, 'y')
      .replace(/و/g, 'w')
      .replace(/ه/g, 'h')
      .replace(/ت|ط/g, 't')
      .replace(/ث/g, 't')
      .replace(/د|ض/g, 'd')
      .replace(/س|ص/g, 's')
      .replace(/ش/g, 'sh')
      .replace(/ز|ظ/g, 'z')
      .replace(/ر/g, 'r')
      .replace(/ب/g, 'b')
      .replace(/ف/g, 'f')
      .replace(/ك/g, 'k')
      .replace(/ل/g, 'l')
      .replace(/م/g, 'm')
      .replace(/ن/g, 'n')
      .replace(/ج/g, 'j')
      .replace(/^h(?=[aeiouwy])/, '7')
      .replace(/[^\\p{L}\\p{N}]+/gu, '')
      .trim();
  }

  function editDistance(a, b) {
    const s = String(a || '');
    const t = String(b || '');
    if (s === t) return 0;
    if (!s.length) return t.length;
    if (!t.length) return s.length;
    if (Math.abs(s.length - t.length) > 2) return 99;
    const prev = new Array(t.length + 1);
    const cur = new Array(t.length + 1);
    for (let j = 0; j <= t.length; j++) prev[j] = j;
    for (let i = 1; i <= s.length; i++) {
      cur[0] = i;
      for (let j = 1; j <= t.length; j++) {
        const cost = s[i - 1] === t[j - 1] ? 0 : 1;
        cur[j] = Math.min(cur[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
      }
      for (let j = 0; j <= t.length; j++) prev[j] = cur[j];
    }
    return prev[t.length];
  }

  function tokenizeName(text) {
    return toNameString(text)
      .split(/[^\\p{L}\\p{N}]+/u)
      .map((t) => t.trim())
      .filter((t) => t.length >= 2);
  }

  function namesMatch(nameOrNames, id, term) {
    const values = Array.isArray(nameOrNames) ? nameOrNames : [nameOrNames];
    const rawNeedle = toNameString(term)
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[\\u0300-\\u036f]/g, '')
      .trim();
    if (!rawNeedle) return false;
    const foldedNeedle = foldArabizi(term);

    for (const value of values) {
      const text = toNameString(value);
      if (!text) continue;
      const lower = text
        .toLowerCase()
        .normalize('NFKD')
        .replace(/[\\u0300-\\u036f]/g, '');
      if (lower.includes(rawNeedle)) return true;

      const tokens = tokenizeName(text);
      for (let i = 0; i < tokens.length; i++) {
        const token = tokens[i];
        const tokenLower = token
          .toLowerCase()
          .normalize('NFKD')
          .replace(/[\\u0300-\\u036f]/g, '');
        if (tokenLower.includes(rawNeedle)) return true;
        const foldedToken = foldArabizi(token);
        if (!foldedToken) continue;
        if (foldedToken === foldedNeedle) return true;
        if (foldedToken.includes(foldedNeedle) && foldedToken.length <= foldedNeedle.length + 1) return true;
        if (foldedNeedle.includes(foldedToken) && foldedNeedle.length <= foldedToken.length + 1) return true;
      }

      const idPart = String(id || '').split('@')[0];
      if (foldArabizi(idPart).includes(foldedNeedle) && foldedNeedle.length >= 3) return true;
      const digits = idPart.replace(/\\D/g, '');
      const termDigits = String(term || '').replace(/\\D/g, '');
      if (termDigits.length >= 3 && digits.includes(termDigits)) return true;
    }
    return false;
  }

  function collectContactNames(contact) {
    const names = [];
    const push = (value) => {
      const text = toNameString(value);
      if (text) names.push(text);
    };

    try {
      const getters = window.require('WAWebContactGetters');
      push(getters.getName?.(contact));
      push(getters.getPushname?.(contact));
      push(getters.getShortName?.(contact));
      push(getters.getVerifiedName?.(contact));
      push(getters.getNotifyName?.(contact));
    } catch (_) {}

    try {
      if (window.WWebJS && typeof window.WWebJS.getContactModel === 'function') {
        const m = window.WWebJS.getContactModel(contact);
        push(m?.name);
        push(m?.pushname);
        push(m?.shortName);
        push(m?.verifiedName);
      }
    } catch (_) {}

    try {
      const frontend = window.require('WAWebFrontendContactGetters');
      push(frontend.getSearchName?.(contact));
      push(frontend.getDisplayName?.(contact));
      push(frontend.getFormattedName?.(contact));
      push(frontend.getFormattedShortName?.(contact));
      push(frontend.getDisplayNameOrPnForLid?.(contact));
      push(frontend.getMentionName?.(contact));
    } catch (_) {}

    const keys = [
      'name', 'pushname', 'shortName', 'verifiedName', 'notifyName',
      'displayName', 'searchName', 'formattedName', 'formattedTitle',
      'displayNameOrPnForLid', 'username'
    ];
    for (const key of keys) {
      push(contact[key]);
      try {
        if (typeof contact.get === 'function') push(contact.get(key));
      } catch (_) {}
    }

    try {
      const serialized = contact.serialize?.();
      if (serialized) {
        for (const key of keys) push(serialized[key]);
      }
    } catch (_) {}

    try {
      for (const key of Object.keys(contact || {})) {
        if (/name|push|notify|title|verified|search|display|short/i.test(key)) {
          push(contact[key]);
        }
      }
    } catch (_) {}

    return names;
  }
`;

module.exports = {
  toNameString,
  isPhoneLike,
  pickBestName,
  foldArabizi,
  namesMatch,
  preferBetterName,
  sanitizeChat,
  dedupeSearchResults,
  BROWSER_SOURCE,
};
