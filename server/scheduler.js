const cron = require('node-cron');
const db = require('./database');
const whatsapp = require('./whatsapp');

let isProcessing = false;

async function processDuePolls() {
  if (isProcessing || !whatsapp.isReady()) return;

  const pending = await db.getPendingPolls();
  if (pending.length === 0) return;

  isProcessing = true;

  for (const poll of pending) {
    try {
      await db.markSending(poll.id);
      await whatsapp.sendPollToChats(poll);
      await db.completePollSend(poll.id);
    } catch (err) {
      await db.markFailed(poll.id, err.message);
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
