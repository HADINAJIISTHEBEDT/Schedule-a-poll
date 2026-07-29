/**
 * Shared contact name helpers for Node cache search + in-page WhatsApp search.
 * BROWSER_SOURCE is injected into puppeteer evaluate() — keep logic identical.
 */

function isPhoneLike(text) {
  const t = String(text || '').trim();
  if (!t) return true;
  // +961 70..., 96170..., bare digits, etc.
  if (/^\+?\d[\d\s\-().]{4,}$/.test(t)) return true;
  if (/^\d{6,}$/.test(t.replace(/\D/g, '')) && t.replace(/\D/g, '').length >= Math.max(6, t.length - 2)) {
    return !/[a-zA-Z\u0600-\u06FF]/.test(t);
  }
  return false;
}

function pickBestName(names, fallback) {
  const list = (names || [])
    .map((n) => String(n || '').trim())
    .filter(Boolean);
  const human = list.filter((n) => !isPhoneLike(n));
  if (human.length) {
    human.sort((a, b) => b.length - a.length);
    return human[0];
  }
  if (list.length) return list[0];
  const fb = String(fallback || '').trim();
  return fb || 'Unknown';
}

/**
 * Fold Arabic + Arabizi (chat alphabet) so "7ayety" matches "حياتي" / "Hayaty".
 */
function foldArabizi(text) {
  return String(text || '')
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

function namesMatch(nameOrNames, id, term) {
  const values = Array.isArray(nameOrNames) ? nameOrNames : [nameOrNames];
  const needle = foldArabizi(term);
  if (!needle) return false;
  const needleSkel = consonantSkeleton(term);

  for (const value of values) {
    const folded = foldArabizi(value);
    if (folded && (folded.includes(needle) || needle.includes(folded))) return true;
    const skel = consonantSkeleton(value);
    // "7ayety" ↔ "حياتي" (7yaty) via consonant skeleton 7yty
    if (needleSkel.length >= 3 && skel.length >= 3) {
      if (skel.includes(needleSkel) || needleSkel.includes(skel)) return true;
    }
  }

  const idPart = String(id || '').split('@')[0];
  if (foldArabizi(idPart).includes(needle)) return true;

  const digits = idPart.replace(/\D/g, '');
  const termDigits = String(term || '').replace(/\D/g, '');
  if (termDigits.length >= 3 && digits.includes(termDigits)) return true;
  return false;
}

function preferBetterName(current, incoming) {
  const a = String(current || '').trim();
  const b = String(incoming || '').trim();
  if (!b) return a || b;
  if (!a) return b;
  if (isPhoneLike(a) && !isPhoneLike(b)) return b;
  if (!isPhoneLike(a) && isPhoneLike(b)) return a;
  return a.length >= b.length ? a : b;
}

/** Source injected into the WhatsApp page (must stay in sync with functions above). */
const BROWSER_SOURCE = `
  function isPhoneLike(text) {
    const t = String(text || '').trim();
    if (!t) return true;
    if (/^\\+?\\d[\\d\\s\\-().]{4,}$/.test(t)) return true;
    if (/^\\d{6,}$/.test(t.replace(/\\D/g, '')) && t.replace(/\\D/g, '').length >= Math.max(6, t.length - 2)) {
      return !/[a-zA-Z\\u0600-\\u06FF]/.test(t);
    }
    return false;
  }

  function pickBestName(names, fallback) {
    const list = (names || []).map((n) => String(n || '').trim()).filter(Boolean);
    const human = list.filter((n) => !isPhoneLike(n));
    if (human.length) {
      human.sort((a, b) => b.length - a.length);
      return human[0];
    }
    if (list.length) return list[0];
    const fb = String(fallback || '').trim();
    return fb || 'Unknown';
  }

  function foldArabizi(text) {
    return String(text || '')
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

  function consonantSkeleton(text) {
    return foldArabizi(text).replace(/[aeiou]/g, '');
  }

  function namesMatch(nameOrNames, id, term) {
    const values = Array.isArray(nameOrNames) ? nameOrNames : [nameOrNames];
    const needle = foldArabizi(term);
    if (!needle) return false;
    const needleSkel = consonantSkeleton(term);
    for (const value of values) {
      const folded = foldArabizi(value);
      if (folded && (folded.includes(needle) || needle.includes(folded))) return true;
      const skel = consonantSkeleton(value);
      if (needleSkel.length >= 3 && skel.length >= 3) {
        if (skel.includes(needleSkel) || needleSkel.includes(skel)) return true;
      }
    }
    const idPart = String(id || '').split('@')[0];
    if (foldArabizi(idPart).includes(needle)) return true;
    const digits = idPart.replace(/\\D/g, '');
    const termDigits = String(term || '').replace(/\\D/g, '');
    if (termDigits.length >= 3 && digits.includes(termDigits)) return true;
    return false;
  }

  function collectContactNames(contact) {
    const names = [];
    const push = (value) => {
      if (value == null) return;
      const text = String(value).trim();
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
  isPhoneLike,
  pickBestName,
  foldArabizi,
  namesMatch,
  preferBetterName,
  BROWSER_SOURCE,
};
