const express = require('express');
const path = require('path');
const fs = require('fs');
const db = require('./database');
const whatsapp = require('./whatsapp');
const scheduler = require('./scheduler');
const { firebaseConfig, isFirebaseConfigured, initFirebaseAdmin } = require('./firebase');

if (isFirebaseConfigured()) {
  try {
    initFirebaseAdmin();
  } catch (err) {
    console.error('Firebase init failed, falling back to SQLite:', err.message);
  }
}

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';

process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err);
});

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection:', reason);
});

// Allow the Android APK (Capacitor) to call this server from a different origin
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(204);
  }
  next();
});

app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

const apkPath = path.join(__dirname, '..', 'releases', 'poll-scheduler.apk');

function publicOrigin(req) {
  const proto = String(req.headers['x-forwarded-proto'] || req.protocol || 'https').split(',')[0].trim();
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
  if (!host) return '';
  return `${proto}://${host}`;
}

function sendApk(req, res) {
  if (!fs.existsSync(apkPath)) {
    const origin = publicOrigin(req);
    return res.status(404).json({
      error: 'APK not found on this server',
      hint: origin ? `${origin}/download/apk` : '/download/apk',
    });
  }
  res.setHeader('Cache-Control', 'no-store');
  return res.download(apkPath, 'poll-scheduler.apk');
}

// Multiple paths so old/bookmark/wrong links don't 404
app.get(
  [
    '/download',
    '/download/',
    '/download/apk',
    '/download/apk/',
    '/apk',
    '/apk.apk',
    '/poll-scheduler.apk',
    '/releases/poll-scheduler.apk',
  ],
  sendApk
);

app.get('/api/download', (req, res) => {
  const origin = publicOrigin(req);
  if (!fs.existsSync(apkPath)) {
    return res.json({
      available: false,
      url: null,
      fallback: origin ? `${origin}/download/apk` : '/download/apk',
    });
  }
  res.json({
    available: true,
    url: '/download/apk',
    absolute: origin ? `${origin}/download/apk` : '/download/apk',
  });
});

app.get('/api/health', (_req, res) => {
  // Lightweight probe — do not start Chromium here
  const dataDir =
    typeof whatsapp.getDataRoot === 'function'
      ? whatsapp.getDataRoot()
      : process.env.DATA_DIR || path.join(__dirname, '..', 'data');
  const sessionPath =
    typeof whatsapp.getSessionPath === 'function'
      ? whatsapp.getSessionPath()
      : path.join(dataDir, 'whatsapp-session');
  let dataDirWritable = false;
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.accessSync(dataDir, fs.constants.W_OK);
    dataDirWritable = true;
  } catch {
    dataDirWritable = false;
  }

  const remoteAuth = Boolean(whatsapp.USE_REMOTE_AUTH);
  const backend =
    typeof whatsapp.remoteBackend === 'function' ? whatsapp.remoteBackend() : 'local';
  const contactStats =
    typeof whatsapp.getContactStats === 'function' ? whatsapp.getContactStats() : {};
  res.json({
    ok: true,
    dataDir,
    dataDirWritable,
    sessionPath,
    remoteAuth,
    sessionBackend: backend,
    hasSession: whatsapp.hasSavedSession(),
    waState: whatsapp.getStatus().state,
    contactsCached: contactStats.contactsCached || 0,
    chatsCached: contactStats.chatsCached || 0,
    hint: whatsapp.hasSavedSession()
      ? `WhatsApp login is saved in ${backend} (${sessionPath})`
      : backend === 'local'
        ? 'No saved WhatsApp login yet — Connect + scan QR once (saves under data/whatsapp-session like localhost)'
        : backend === 'mongodb'
          ? 'No MongoDB WhatsApp session yet — Connect + scan QR once (wait ~15–30s)'
          : 'No Firestore WhatsApp session yet — Connect + scan QR once (wait ~15–30s)',
  });
});

app.get('/api/status', async (_req, res) => {
  whatsapp.warmupConnection();
  try {
    res.json(await whatsapp.refreshStatus());
  } catch (err) {
    console.error('GET /api/status error:', err.message);
    res.json(whatsapp.getStatus());
  }
});

app.post('/api/connect', async (req, res) => {
  try {
    if (whatsapp.isReady()) {
      return res.json({ ok: true, message: 'Already connected', ...(await whatsapp.refreshStatus()) });
    }
    const force = req.body?.force === true || req.query.force === '1';
    // Never clear the saved login from Connect — only Disconnect does that.
    // Ignoring reset keeps one QR scan permanent across deploys/retries.
    if (req.body?.reset === true || req.query.reset === '1') {
      console.warn('Ignoring session reset on /api/connect — use Disconnect to clear login');
    }
    whatsapp.startConnection({ force, resetSession: false });
    const status = await whatsapp.refreshStatus();
    res.json({
      ok: true,
      message: status.restoring
        ? 'Restoring saved WhatsApp login'
        : status.qr
          ? 'Scan the QR code'
          : 'Connecting — QR will appear shortly',
      ...status,
    });
  } catch (err) {
    console.error('POST /api/connect error:', err.message);
    res.status(500).json({ ok: false, error: err.message, ...whatsapp.getStatus() });
  }
});

app.post('/api/disconnect', async (_req, res) => {
  try {
    await whatsapp.disconnect({ userInitiated: true });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/api/chats', async (req, res) => {
  try {
    const refresh = req.query.refresh === '1';
    const includeContacts = req.query.contacts === '1';
    const chats = await whatsapp.getChats({ refresh, includeContacts });
    res.json(chats);
  } catch (err) {
    console.error('GET /api/chats error:', err.message);
    res.status(400).json({ error: err.message || 'Failed to load chats' });
  }
});

app.get('/api/chats/search', async (req, res) => {
  try {
    const query = String(req.query.q || '').trim();
    const filter = req.query.type || 'all';
    const includeContacts = filter !== 'groups';
    const chats = await whatsapp.searchChats({ query, filter, includeContacts });
    res.json(chats);
  } catch (err) {
    console.error('GET /api/chats/search error:', err.message);
    const status = /timed out/i.test(err.message) ? 504 : 400;
    res.status(status).json({ error: err.message || 'Search failed' });
  }
});

app.get('/api/firebase-config', (_req, res) => {
  res.json({
    enabled: isFirebaseConfigured(),
    ...firebaseConfig,
  });
});

app.get('/api/polls', async (_req, res) => {
  try {
    res.json(await db.getAllPolls());
  } catch (err) {
    console.error('GET /api/polls error:', err.message);
    res.status(500).json({ error: err.message || 'Failed to load polls' });
  }
});

app.post('/api/polls', async (req, res) => {
  const { question, options, chatIds, allowMultiple, scheduledAt, humanDelayMin, humanDelayMax, sendNow, repeatDaily } =
    req.body;

  if (!question?.trim()) {
    return res.status(400).json({ error: 'Poll question is required' });
  }

  const cleanOptions = (options || []).map((o) => String(o || '').trim()).filter(Boolean);
  if (cleanOptions.length < 2) {
    return res.status(400).json({ error: 'At least 2 poll options are required' });
  }
  if (cleanOptions.length > 12) {
    return res.status(400).json({ error: 'WhatsApp polls support up to 12 options' });
  }

  const seenOpts = new Set();
  for (const opt of cleanOptions) {
    if (opt.length > 100) {
      return res.status(400).json({ error: 'Each poll option must be 100 characters or less' });
    }
    const key = opt.toLowerCase();
    if (seenOpts.has(key)) {
      return res.status(400).json({
        error: `Duplicate option "${opt}". WhatsApp needs unique options to send the poll.`,
      });
    }
    seenOpts.add(key);
  }

  if (!question.trim() || question.trim().length > 255) {
    return res.status(400).json({ error: 'Poll question must be 1–255 characters' });
  }

  if (!chatIds?.length) {
    return res.status(400).json({ error: 'Select at least one chat' });
  }

  const scheduleTime = sendNow
    ? new Date().toISOString()
    : scheduledAt;

  if (!scheduleTime) {
    return res.status(400).json({ error: 'Schedule time is required' });
  }

  if (!sendNow && Number.isNaN(new Date(scheduleTime).getTime())) {
    return res.status(400).json({ error: 'Invalid schedule time' });
  }

  try {
    const id = await db.createPoll({
      question: question.trim(),
      options: cleanOptions,
      chatIds,
      allowMultiple: Boolean(allowMultiple),
      scheduledAt: scheduleTime,
      humanDelayMin: humanDelayMin ?? 3,
      humanDelayMax: humanDelayMax ?? 12,
      repeatDaily: Boolean(repeatDaily),
    });

    if (sendNow && whatsapp.isReady()) {
      scheduler.processDuePolls().catch(() => {});
    }

    res.json({ id, message: sendNow ? 'Poll queued for immediate delivery' : 'Poll scheduled' });
  } catch (err) {
    console.error('POST /api/polls error:', err.message);
    res.status(500).json({ error: err.message || 'Failed to save poll' });
  }
});

app.delete('/api/polls/:id', async (req, res) => {
  const result = await db.deletePoll(req.params.id);
  if (!result.deleted) {
    return res.status(404).json({ error: 'Poll not found or already sent' });
  }
  res.json({ ok: true });
});

app.post('/api/polls/:id/send-now', async (req, res) => {
  const poll = await db.getPollById(req.params.id);
  if (!poll) {
    return res.status(404).json({ error: 'Poll not found' });
  }
  if (poll.status !== 'pending') {
    return res.status(400).json({ error: 'Poll is not pending' });
  }
  if (!whatsapp.isReady()) {
    return res.status(400).json({ error: 'WhatsApp is not connected' });
  }

  try {
    await db.markSending(poll.id);
    await whatsapp.sendPollToChats(poll);
    await db.completePollSend(poll.id);
    res.json({ ok: true });
  } catch (err) {
    await db.markFailed(poll.id, err.message);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, HOST, async () => {
  const polls = await db.getAllPolls().catch(() => []);
  console.log(`Poll Scheduler running at http://${HOST}:${PORT}`);
  console.log(`Poll storage backend ready (${polls.length} polls loaded)`);
  try {
    if (typeof db.resetStuckSending === 'function') {
      const { reset } = await db.resetStuckSending();
      if (reset) console.log(`Reset ${reset} poll(s) stuck in sending`);
    }
  } catch (err) {
    console.warn('Could not reset stuck polls:', err.message);
  }
  scheduler.start();

  // Restore WhatsApp login + contacts from disk (LocalAuth) — same as localhost
  try {
    const dataDir =
      typeof whatsapp.getDataRoot === 'function'
        ? whatsapp.getDataRoot()
        : process.env.DATA_DIR || path.join(__dirname, '..', 'data');
    fs.mkdirSync(dataDir, { recursive: true });
    fs.accessSync(dataDir, fs.constants.W_OK);
    console.log('Data directory writable:', dataDir);
    if (typeof whatsapp.getSessionPath === 'function') {
      console.log('WhatsApp session path:', whatsapp.getSessionPath());
    }
    console.log(
      'Session backend:',
      typeof whatsapp.remoteBackend === 'function' ? whatsapp.remoteBackend() : 'local'
    );

    if (typeof whatsapp.refreshRemoteSessionCache === 'function') {
      await whatsapp.refreshRemoteSessionCache();
    }
    if (typeof whatsapp.hydrateContactsFromStore === 'function') {
      await whatsapp.hydrateContactsFromStore();
    }

    if (whatsapp.hasSavedSession()) {
      console.log('Found saved WhatsApp session — restoring automatically (like localhost)');
      whatsapp.warmupConnection();
    } else {
      const backend =
        typeof whatsapp.remoteBackend === 'function' ? whatsapp.remoteBackend() : 'local';
      console.log(
        backend === 'mongodb'
          ? 'No MongoDB WhatsApp session yet — scan QR once'
          : backend === 'firestore'
            ? 'No Firestore WhatsApp session yet — scan QR once (saved to Firebase)'
            : 'No saved WhatsApp session yet — Connect + scan QR once (saves on local disk)'
      );
    }
  } catch (err) {
    console.error('WhatsApp session restore / data dir check failed:', err.message);
  }
});
