const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const dataDir = path.join(__dirname, '..', 'data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const db = new Database(path.join(dataDir, 'polls.db'));

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
    created_at TEXT DEFAULT (datetime('now')),
    sent_at TEXT,
    error TEXT
  )
`);

const insertPoll = db.prepare(`
  INSERT INTO scheduled_polls
    (question, options, chat_ids, allow_multiple, scheduled_at, human_delay_min, human_delay_max)
  VALUES
    (@question, @options, @chat_ids, @allow_multiple, @scheduled_at, @human_delay_min, @human_delay_max)
`);

const getPendingPolls = db.prepare(`
  SELECT * FROM scheduled_polls
  WHERE status = 'pending'
  ORDER BY scheduled_at ASC
`);

const getAllPolls = db.prepare(`
  SELECT * FROM scheduled_polls
  ORDER BY created_at DESC
`);

const getPollById = db.prepare(`SELECT * FROM scheduled_polls WHERE id = ?`);

const updatePollStatus = db.prepare(`
  UPDATE scheduled_polls
  SET status = @status, sent_at = @sent_at, error = @error
  WHERE id = @id
`);

const deletePoll = db.prepare(`DELETE FROM scheduled_polls WHERE id = ? AND status = 'pending'`);

module.exports = {
  createPoll(data) {
    const result = insertPoll.run({
      question: data.question,
      options: JSON.stringify(data.options),
      chat_ids: JSON.stringify(data.chatIds),
      allow_multiple: data.allowMultiple ? 1 : 0,
      scheduled_at: data.scheduledAt,
      human_delay_min: data.humanDelayMin ?? 3,
      human_delay_max: data.humanDelayMax ?? 12,
    });
    return result.lastInsertRowid;
  },

  getPendingPolls() {
    const now = Date.now();
    return getPendingPolls
      .all()
      .filter((row) => new Date(row.scheduled_at).getTime() <= now);
  },

  getAllPolls() {
    return getAllPolls.all().map(formatPoll);
  },

  getPollById(id) {
    const row = getPollById.get(id);
    return row ? formatPoll(row) : null;
  },

  markSending(id) {
    updatePollStatus.run({ id, status: 'sending', sent_at: null, error: null });
  },

  markSent(id) {
    updatePollStatus.run({
      id,
      status: 'sent',
      sent_at: new Date().toISOString(),
      error: null,
    });
  },

  markFailed(id, error) {
    updatePollStatus.run({
      id,
      status: 'failed',
      sent_at: null,
      error: String(error),
    });
  },

  deletePoll(id) {
    return deletePoll.run(id);
  },

  wipeAll() {
    db.exec('DELETE FROM scheduled_polls');
  },
};

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
    createdAt: row.created_at,
    sentAt: row.sent_at,
    error: row.error,
  };
}
