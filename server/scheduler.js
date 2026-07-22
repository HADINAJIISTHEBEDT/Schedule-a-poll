const cron = require('node-cron');
const db = require('./database');
const whatsapp = require('./whatsapp');

let isProcessing = false;

async function processDuePolls() {
  if (isProcessing || !whatsapp.isReady()) return;

  const pending = db.getPendingPolls();
  if (pending.length === 0) return;

  isProcessing = true;

  for (const row of pending) {
    const poll = {
      id: row.id,
      question: row.question,
      options: JSON.parse(row.options),
      chatIds: JSON.parse(row.chat_ids),
      allowMultiple: Boolean(row.allow_multiple),
      humanDelayMin: row.human_delay_min,
      humanDelayMax: row.human_delay_max,
    };

    try {
      db.markSending(poll.id);
      await whatsapp.sendPollToChats(poll);
      db.completePollSend(poll.id);
    } catch (err) {
      db.markFailed(poll.id, err.message);
    }
  }

  isProcessing = false;
}

function start() {
  cron.schedule('* * * * *', () => {
    processDuePolls().catch((err) => {
      console.error('Scheduler error:', err.message);
      isProcessing = false;
    });
  });

  whatsapp.on('ready', () => {
    processDuePolls().catch((err) => {
      console.error('Initial scheduler run error:', err.message);
    });
  });
}

module.exports = { start, processDuePolls };
