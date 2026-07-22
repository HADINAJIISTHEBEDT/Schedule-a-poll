const { getFirestore } = require('../firebase');

const COLLECTION = 'scheduled_polls';

function getNextDailySchedule(isoString) {
  const base = new Date(isoString);
  const next = new Date(base);
  next.setDate(next.getDate() + 1);
  return next.toISOString();
}

function formatPoll(id, data) {
  return {
    id,
    question: data.question,
    options: data.options || [],
    chatIds: data.chatIds || [],
    allowMultiple: Boolean(data.allowMultiple),
    scheduledAt: data.scheduledAt,
    status: data.status || 'pending',
    humanDelayMin: data.humanDelayMin ?? 3,
    humanDelayMax: data.humanDelayMax ?? 12,
    repeatDaily: Boolean(data.repeatDaily),
    createdAt: data.createdAt || null,
    sentAt: data.sentAt || null,
    error: data.error || null,
  };
}

function collection() {
  const db = getFirestore();
  if (!db) throw new Error('Firebase is not configured');
  return db.collection(COLLECTION);
}

module.exports = {
  backend: 'firestore',

  async createPoll(data) {
    const ref = await collection().add({
      question: data.question,
      options: data.options,
      chatIds: data.chatIds,
      allowMultiple: Boolean(data.allowMultiple),
      scheduledAt: data.scheduledAt,
      humanDelayMin: data.humanDelayMin ?? 3,
      humanDelayMax: data.humanDelayMax ?? 12,
      repeatDaily: Boolean(data.repeatDaily),
      status: 'pending',
      createdAt: new Date().toISOString(),
      sentAt: null,
      error: null,
    });
    return ref.id;
  },

  async getPendingPolls() {
    const snap = await collection().where('status', '==', 'pending').get();
    const now = Date.now();
    return snap.docs
      .map((doc) => formatPoll(doc.id, doc.data()))
      .filter((poll) => new Date(poll.scheduledAt).getTime() <= now)
      .sort((a, b) => new Date(a.scheduledAt) - new Date(b.scheduledAt));
  },

  async getAllPolls() {
    const snap = await collection().orderBy('createdAt', 'desc').get();
    return snap.docs.map((doc) => formatPoll(doc.id, doc.data()));
  },

  async getPollById(id) {
    const doc = await collection().doc(String(id)).get();
    if (!doc.exists) return null;
    return formatPoll(doc.id, doc.data());
  },

  async markSending(id) {
    await collection().doc(String(id)).update({
      status: 'sending',
      sentAt: null,
      error: null,
    });
  },

  async markSent(id) {
    await collection().doc(String(id)).update({
      status: 'sent',
      sentAt: new Date().toISOString(),
      error: null,
    });
  },

  async completePollSend(id) {
    const doc = await collection().doc(String(id)).get();
    if (!doc.exists) return;

    const data = doc.data();
    if (data.repeatDaily) {
      await collection().doc(String(id)).update({
        status: 'pending',
        scheduledAt: getNextDailySchedule(data.scheduledAt),
        sentAt: new Date().toISOString(),
        error: null,
      });
    } else {
      await this.markSent(id);
    }
  },

  async markFailed(id, error) {
    await collection().doc(String(id)).update({
      status: 'failed',
      sentAt: null,
      error: String(error),
    });
  },

  async deletePoll(id) {
    const ref = collection().doc(String(id));
    const doc = await ref.get();
    if (!doc.exists || doc.data().status !== 'pending') {
      return { deleted: false };
    }
    await ref.delete();
    return { deleted: true };
  },
};
