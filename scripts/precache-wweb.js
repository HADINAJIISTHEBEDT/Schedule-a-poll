/**
 * Pre-download WhatsApp Web HTML so Chromium does not fetch it on first connect.
 * Run at Docker build time or via: node scripts/precache-wweb.js
 */
const fs = require('fs');
const path = require('path');
const https = require('https');
const { PINNED_WEB_VERSION } = require('../server/wwebVersion');

const CACHE_DIR = path.join(__dirname, '..', 'data', 'wwebjs_cache');
const CACHE_FILE = path.join(CACHE_DIR, `${PINNED_WEB_VERSION}.html`);

const REMOTE_SOURCES = [
  `https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/${PINNED_WEB_VERSION}.html`,
];

function fetchUrl(url) {
  return new Promise((resolve, reject) => {
    const request = https.get(
      url,
      {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          Accept: 'text/html,application/xhtml+xml',
        },
        timeout: 60000,
      },
      (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          return fetchUrl(res.headers.location).then(resolve, reject);
        }
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error(`HTTP ${res.statusCode} for ${url}`));
          return;
        }
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      }
    );
    request.on('error', reject);
    request.on('timeout', () => {
      request.destroy();
      reject(new Error(`Timeout fetching ${url}`));
    });
  });
}

async function main() {
  if (fs.existsSync(CACHE_FILE) && fs.statSync(CACHE_FILE).size > 10000) {
    console.log(`WhatsApp Web cache already exists: ${CACHE_FILE}`);
    return;
  }

  fs.mkdirSync(CACHE_DIR, { recursive: true });

  let lastError = null;
  for (const source of REMOTE_SOURCES) {
    try {
      console.log(`Fetching WhatsApp Web HTML from ${source}...`);
      const html = await fetchUrl(source);
      if (!html || html.length < 10000) {
        throw new Error('Response too small to be valid HTML');
      }
      fs.writeFileSync(CACHE_FILE, html);
      console.log(`Saved ${(html.length / 1024).toFixed(0)} KB to ${CACHE_FILE}`);
      return;
    } catch (err) {
      lastError = err;
      console.warn(`Source failed (${source}): ${err.message}`);
    }
  }

  console.warn(`Could not pre-cache WhatsApp Web HTML: ${lastError?.message || 'unknown error'}`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(0);
});
