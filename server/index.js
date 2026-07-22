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

app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

const apkPath = path.join(__dirname, '..', 'releases', 'poll-scheduler.apk');

app.get('/download/apk', (_req, res) => {
  if (!fs.existsSync(apkPath)) {
    return res.status(404).json({ error: 'APK not built yet. Run: npm run build:apk' });
  }
  res.download(apkPath, 'poll-scheduler.apk');
});

app.get('/api/download', (_req, res) => {
  if (!fs.existsSync(apkPath)) {
    return res.json({ available: false, url: null });
  }
  res.json({ available: true, url: '/download/apk' });
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
    const resetSession = req.body?.reset === true || req.query.reset === '1';
    whatsapp.startConnection({ force, resetSession });
    res.json({ ok: true, message: 'Connecting — scan the QR code', ...(await whatsapp.refreshStatus()) });
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

  const cleanOptions = (options || []).map((o) => o.trim()).filter(Boolean);
  if (cleanOptions.length < 2) {
    return res.status(400).json({ error: 'At least 2 poll options are required' });
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
  scheduler.start();
});
