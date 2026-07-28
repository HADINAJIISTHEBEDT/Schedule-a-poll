const { getFirestore } = require('./firebase');
const { isMongoConfigured, connectMongo, getMongoose } = require('./mongo');

const COLLECTION = 'wa_contacts';

/**
 * Persist chats/contacts so search still works after Render restarts
 * while WhatsApp is reconnecting from a saved login.
 */
async function saveContacts(contacts = []) {
  const list = (contacts || [])
    .filter((c) => c && c.id)
    .map((c) => ({
      id: String(c.id),
      name: String(c.name || c.id),
      isGroup: Boolean(c.isGroup),
      updatedAt: new Date().toISOString(),
    }));

  if (!list.length) return 0;

  if (isMongoConfigured()) {
    try {
      await connectMongo();
      const mongoose = getMongoose();
      const col = mongoose.connection.db.collection(COLLECTION);
      const ops = list.map((doc) => ({
        updateOne: {
          filter: { id: doc.id },
          update: { $set: doc },
          upsert: true,
        },
      }));
      // bulkWrite in chunks
      for (let i = 0; i < ops.length; i += 500) {
        await col.bulkWrite(ops.slice(i, i + 500), { ordered: false });
      }
      console.log(`Saved ${list.length} contacts/chats to MongoDB`);
      return list.length;
    } catch (err) {
      console.warn('Mongo contact save failed:', err.message);
    }
  }

  // Firestore fallback
  try {
    const db = getFirestore();
    if (!db) return 0;
    let batch = db.batch();
    let ops = 0;
    for (const doc of list) {
      batch.set(db.collection(COLLECTION).doc(encodeURIComponent(doc.id)), doc, { merge: true });
      ops += 1;
      if (ops >= 400) {
        await batch.commit();
        batch = db.batch();
        ops = 0;
      }
    }
    if (ops) await batch.commit();
    console.log(`Saved ${list.length} contacts/chats to Firestore`);
    return list.length;
  } catch (err) {
    console.warn('Firestore contact save failed:', err.message);
    return 0;
  }
}

async function loadContacts() {
  if (isMongoConfigured()) {
    try {
      await connectMongo();
      const mongoose = getMongoose();
      const rows = await mongoose.connection.db
        .collection(COLLECTION)
        .find({})
        .project({ _id: 0 })
        .limit(5000)
        .toArray();
      return rows.map((r) => ({
        id: r.id,
        name: r.name || r.id,
        isGroup: Boolean(r.isGroup),
      }));
    } catch (err) {
      console.warn('Mongo contact load failed:', err.message);
    }
  }

  try {
    const db = getFirestore();
    if (!db) return [];
    const snap = await db.collection(COLLECTION).limit(5000).get();
    return snap.docs.map((d) => {
      const r = d.data() || {};
      return {
        id: r.id || decodeURIComponent(d.id),
        name: r.name || r.id || d.id,
        isGroup: Boolean(r.isGroup),
      };
    });
  } catch (err) {
    console.warn('Firestore contact load failed:', err.message);
    return [];
  }
}

async function clearContacts() {
  if (isMongoConfigured()) {
    try {
      await connectMongo();
      await getMongoose().connection.db.collection(COLLECTION).deleteMany({});
    } catch (err) {
      console.warn('Mongo contact clear failed:', err.message);
    }
  }

  try {
    const db = getFirestore();
    if (!db) return;
    const snap = await db.collection(COLLECTION).limit(400).get();
    if (snap.empty) return;
    const batch = db.batch();
    snap.docs.forEach((d) => batch.delete(d.ref));
    await batch.commit();
    // recurse if more
    if (snap.size >= 400) await clearContacts();
  } catch (err) {
    console.warn('Firestore contact clear failed:', err.message);
  }
}

module.exports = {
  saveContacts,
  loadContacts,
  clearContacts,
};
