const express = require('express');
const path = require('path');
const db = require('./database');
const whatsapp = require('./whatsapp');
const scheduler = require('./scheduler');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

app.get('/api/status', (_req, res) => {
  res.json(whatsapp.getStatus());
});

app.post('/api/connect', async (_req, res) => {
  try {
    if (whatsapp.isReady()) {
      return res.json({ ok: true, message: 'Already connected' });
    }
    await whatsapp.initialize();
    res.json({ ok: true, message: 'Connecting — scan the QR code' });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
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
    console.error('GET /api/chats error:', err.message);
    res.status(400).json({ error: err.message || 'Failed to load chats' });
  }
});

app.get('/api/polls', (_req, res) => {
  res.json(db.getAllPolls());
});

app.post('/api/polls', (req, res) => {
  const { question, options, chatIds, allowMultiple, scheduledAt, humanDelayMin, humanDelayMax, sendNow } =
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

  const scheduleTime = sendNow ? new Date().toISOString().slice(0, 19).replace('T', ' ') : scheduledAt;

  if (!scheduleTime) {
    return res.status(400).json({ error: 'Schedule time is required' });
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

  if (sendNow && whatsapp.isReady()) {
    scheduler.processDuePolls().catch(() => {});
  }

  res.json({ id, message: sendNow ? 'Poll queued for immediate delivery' : 'Poll scheduled' });
});

app.delete('/api/polls/:id', (req, res) => {
  const result = db.deletePoll(Number(req.params.id));
  if (result.changes === 0) {
    return res.status(404).json({ error: 'Poll not found or already sent' });
  }
  res.json({ ok: true });
});

app.post('/api/polls/:id/send-now', async (req, res) => {
  const poll = db.getPollById(Number(req.params.id));
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
    db.markSending(poll.id);
    await whatsapp.sendPollToChats(poll);
    db.markSent(poll.id);
    res.json({ ok: true });
  } catch (err) {
    db.markFailed(poll.id, err.message);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Poll Scheduler running at http://localhost:${PORT}`);
  scheduler.start();
  whatsapp.initialize().catch((err) => {
    console.error('WhatsApp init error:', err.message);
  });
});
