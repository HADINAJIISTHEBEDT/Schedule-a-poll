const express = require('express');
const path = require('path');
const fs = require('fs');
const db = require('./database');
const whatsapp = require('./whatsapp');
const scheduler = require('./scheduler');

const app = express();
const PORT = Number(process.env.PORT) || 3001;
const HOST = process.env.HOST || '0.0.0.0';

app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

const apkPath = path.join(__dirname, '..', 'releases', 'poll-scheduler.apk');

app.get('/api/health', (_req, res) => res.json({ ok: true }));

app.get('/api/status', (_req, res) => res.json(whatsapp.getStatus()));

app.post('/api/reset', async (_req, res) => {
  try {
    await whatsapp.disconnect();
    db.wipeAll();
    const sessionPath = path.join(__dirname, '..', 'data', 'whatsapp-session');
    if (fs.existsSync(sessionPath)) {
      fs.rmSync(sessionPath, { recursive: true, force: true });
    }
    res.json({ ok: true, message: 'All data wiped' });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/connect', async (_req, res) => {
  try {
    if (whatsapp.isReady()) {
      return res.json({ ok: true, message: 'Already connected', ...whatsapp.getStatus() });
    }

    const status = whatsapp.getStatus();
    if (status.state === 'connecting' || status.state === 'qr') {
      await whatsapp.disconnect();
    }

    await whatsapp.initialize();
    const finalStatus = await whatsapp.waitForQrOrReady();

    if (finalStatus.state === 'ready' && !finalStatus.qr) {
      await whatsapp.disconnect();
      return res.status(409).json({
        ok: false,
        error: 'Auto-login blocked. Click Connect again — QR code is required.',
        ...whatsapp.getStatus(),
      });
    }

    res.json({
      ok: true,
      message: finalStatus.qr ? 'Scan the QR code' : 'Connecting...',
      ...finalStatus,
    });
  } catch (err) {
    console.error('Connect error:', err.message);
    await whatsapp.disconnect().catch(() => {});
    res.status(500).json({ ok: false, error: err.message, ...whatsapp.getStatus() });
  }
});

app.post('/api/disconnect', async (_req, res) => {
  try {
    await whatsapp.disconnect();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/api/chats', async (req, res) => {
  try {
    const refresh = req.query.refresh === '1';
    const chats = await whatsapp.getChats({ refresh });
    res.json(chats);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/polls', (_req, res) => res.json(db.getAllPolls()));

app.post('/api/polls', (req, res) => {
  const { question, options, chatIds, allowMultiple, scheduledAt, humanDelayMin, humanDelayMax, sendNow } = req.body;

  if (!question?.trim()) return res.status(400).json({ error: 'Poll question is required' });
  const cleanOptions = (options || []).map((o) => o.trim()).filter(Boolean);
  if (cleanOptions.length < 2) return res.status(400).json({ error: 'At least 2 options required' });
  if (!chatIds?.length) return res.status(400).json({ error: 'Select at least one chat' });

  const scheduleTime = sendNow ? new Date().toISOString() : scheduledAt;
  if (!scheduleTime) return res.status(400).json({ error: 'Schedule time is required' });
  if (!sendNow && Number.isNaN(new Date(scheduleTime).getTime())) {
    return res.status(400).json({ error: 'Invalid schedule time' });
  }

  const id = db.createPoll({
    question: question.trim(),
    options: cleanOptions,
    chatIds,
    allowMultiple: Boolean(allowMultiple),
    scheduledAt: scheduleTime,
    humanDelayMin: humanDelayMin ?? 3,
    humanDelayMax: humanDelayMax ?? 12,
  });

  if (sendNow && whatsapp.isReady()) scheduler.processDuePolls().catch(() => {});
  res.json({ id, message: sendNow ? 'Poll queued for delivery' : 'Poll scheduled' });
});

app.delete('/api/polls/:id', (req, res) => {
  const result = db.deletePoll(Number(req.params.id));
  if (result.changes === 0) return res.status(404).json({ error: 'Poll not found' });
  res.json({ ok: true });
});

app.post('/api/polls/:id/send-now', async (req, res) => {
  const poll = db.getPollById(Number(req.params.id));
  if (!poll) return res.status(404).json({ error: 'Poll not found' });
  if (poll.status !== 'pending') return res.status(400).json({ error: 'Poll is not pending' });
  if (!whatsapp.isReady()) return res.status(400).json({ error: 'WhatsApp is not connected' });

  try {
    db.markSending(poll.id);
    await whatsapp.sendPollToChats(poll);
    db.markSent(poll.id);
    res.json({ ok: true });
  } catch (err) {
    db.markFailed(poll.id, err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/download/apk', (_req, res) => {
  if (!fs.existsSync(apkPath)) return res.status(404).json({ error: 'APK not built' });
  res.download(apkPath, 'poll-scheduler.apk');
});

app.listen(PORT, HOST, () => {
  console.log(`Poll Scheduler running at http://${HOST}:${PORT}`);
  scheduler.start();
});
