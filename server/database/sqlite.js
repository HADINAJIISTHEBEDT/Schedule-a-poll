const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const dataDir = path.join(__dirname, '..', '..', 'data');

try {
  fs.mkdirSync(dataDir, { recursive: true });
} catch (err) {
  console.error(`Failed to create data directory at ${dataDir}:`, err.message);
  throw err;
}

let db;
try {
  db = new Database(path.join(dataDir, 'polls.db'));
} catch (err) {
  console.error(`Failed to open database at ${dataDir}/polls.db:`, err.message);
  throw err;
}

db.exec(`
  CREATE TABLE IF NOT EXISTS scheduled_polls (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    question TEXT NOT NULL,
    options TEXT NOT NULL,
    chat_ids TEXT NOT NULL,
    allow_multiple INTEGER DEFAULT 0,
    scheduled_at TEXT NOT NULL,
    status TEXT DEFAULT 'pending',
    human_delay_min INTEGER DEFAULT 3,
    human_delay_max INTEGER DEFAULT 12,
    repeat_daily INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    sent_at TEXT,
    error TEXT
  )
`);

try {
  db.exec(`ALTER TABLE scheduled_polls ADD COLUMN repeat_daily INTEGER DEFAULT 0`);
} catch {
  // column already exists
}

function getNextDailySchedule(isoString) {
  const base = new Date(isoString);
  const next = new Date(base);
  next.setDate(next.getDate() + 1);
  return next.toISOString();
}

const insertPoll = db.prepare(`
  INSERT INTO scheduled_polls
    (question, options, chat_ids, allow_multiple, scheduled_at, human_delay_min, human_delay_max, repeat_daily)
  VALUES
    (@question, @options, @chat_ids, @allow_multiple, @scheduled_at, @human_delay_min, @human_delay_max, @repeat_daily)
`);

const getPendingPollsStmt = db.prepare(`
  SELECT * FROM scheduled_polls
  WHERE status = 'pending'
  ORDER BY scheduled_at ASC
`);

const getAllPollsStmt = db.prepare(`
  SELECT * FROM scheduled_polls
  ORDER BY created_at DESC
`);

const getPollByIdStmt = db.prepare(`SELECT * FROM scheduled_polls WHERE id = ?`);

const updatePollStatus = db.prepare(`
  UPDATE scheduled_polls
  SET status = @status, sent_at = @sent_at, error = @error
  WHERE id = @id
`);

const reschedulePoll = db.prepare(`
  UPDATE scheduled_polls
  SET status = 'pending', scheduled_at = @scheduled_at, sent_at = @sent_at, error = NULL
  WHERE id = @id
`);

const deletePollStmt = db.prepare(`DELETE FROM scheduled_polls WHERE id = ? AND status = 'pending'`);

function formatPoll(row) {
  return {
    id: row.id,
    question: row.question,
    options: JSON.parse(row.options),
    chatIds: JSON.parse(row.chat_ids),
    allowMultiple: Boolean(row.allow_multiple),
    scheduledAt: row.scheduled_at,
    status: row.status,
    humanDelayMin: row.human_delay_min,
    humanDelayMax: row.human_delay_max,
    repeatDaily: Boolean(row.repeat_daily),
    createdAt: row.created_at,
    sentAt: row.sent_at,
    error: row.error,
  };
}

function normalizeId(id) {
  const numeric = Number(id);
  return Number.isNaN(numeric) ? id : numeric;
}

module.exports = {
  backend: 'sqlite',

  async createPoll(data) {
    const result = insertPoll.run({
      question: data.question,
      options: JSON.stringify(data.options),
      chat_ids: JSON.stringify(data.chatIds),
      allow_multiple: data.allowMultiple ? 1 : 0,
      scheduled_at: data.scheduledAt,
      human_delay_min: data.humanDelayMin ?? 3,
      human_delay_max: data.humanDelayMax ?? 12,
      repeat_daily: data.repeatDaily ? 1 : 0,
    });
    return result.lastInsertRowid;
  },

  async getPendingPolls() {
    const now = Date.now();
    return getPendingPollsStmt
      .all()
      .filter((row) => new Date(row.scheduled_at).getTime() <= now)
      .map(formatPoll);
  },

  async getAllPolls() {
    return getAllPollsStmt.all().map(formatPoll);
  },

  async getPollById(id) {
    const row = getPollByIdStmt.get(normalizeId(id));
    return row ? formatPoll(row) : null;
  },

  async markSending(id) {
    updatePollStatus.run({ id: normalizeId(id), status: 'sending', sent_at: null, error: null });
  },

  async markSent(id) {
    updatePollStatus.run({
      id: normalizeId(id),
      status: 'sent',
      sent_at: new Date().toISOString(),
      error: null,
    });
  },

  async completePollSend(id) {
    const row = getPollByIdStmt.get(normalizeId(id));
    if (!row) return;

    if (row.repeat_daily) {
      reschedulePoll.run({
        id: normalizeId(id),
        scheduled_at: getNextDailySchedule(row.scheduled_at),
        sent_at: new Date().toISOString(),
      });
    } else {
      await this.markSent(id);
    }
  },

  async markFailed(id, error) {
    updatePollStatus.run({
      id: normalizeId(id),
      status: 'failed',
      sent_at: null,
      error: String(error),
    });
  },

  async deletePoll(id) {
    const result = deletePollStmt.run(normalizeId(id));
    return { deleted: result.changes > 0 };
  },
};
