const { getFirestore, initFirebaseAdmin, isFirebaseConfigured } = require('./firebase');
const { isMongoConfigured, connectMongo, getMongoose } = require('./mongo');

const COLLECTION = 'wa_contacts';

function contactDocId(id) {
  // Firestore doc ids cannot contain "/"; WA ids use @ which is fine once encoded.
  return encodeURIComponent(String(id)).slice(0, 700);
}

function getDb() {
  return getFirestore() || initFirebaseAdmin();
}

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

  const preferMongo = String(process.env.WA_SESSION_BACKEND || '').toLowerCase() === 'mongodb';

  // Default: Firestore (user already has Firebase). Mongo only if preferred.
  if (!preferMongo) {
    try {
      const db = getDb();
      if (db) {
        let batch = db.batch();
        let ops = 0;
        for (const doc of list) {
          batch.set(db.collection(COLLECTION).doc(contactDocId(doc.id)), doc, { merge: true });
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
      }
      console.warn(
        'Firestore contact save skipped — Firebase Admin not ready',
        isFirebaseConfigured() ? '(init failed)' : '(missing FIREBASE_CLIENT_EMAIL / FIREBASE_PRIVATE_KEY)'
      );
    } catch (err) {
      console.warn('Firestore contact save failed:', err.message);
    }
  }

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
      for (let i = 0; i < ops.length; i += 500) {
        await col.bulkWrite(ops.slice(i, i + 500), { ordered: false });
      }
      console.log(`Saved ${list.length} contacts/chats to MongoDB`);
      return list.length;
    } catch (err) {
      console.warn('Mongo contact save failed:', err.message);
    }
  }

  return 0;
}

async function loadContacts() {
  // Prefer Mongo only when explicitly chosen; otherwise try Firestore first for this project
  const preferMongo = String(process.env.WA_SESSION_BACKEND || '').toLowerCase() === 'mongodb';

  if (preferMongo && isMongoConfigured()) {
    try {
      await connectMongo();
      const mongoose = getMongoose();
      const rows = await mongoose.connection.db
        .collection(COLLECTION)
        .find({})
        .project({ _id: 0 })
        .limit(5000)
        .toArray();
      if (rows.length) {
        return rows.map((r) => ({
          id: r.id,
          name: r.name || r.id,
          isGroup: Boolean(r.isGroup),
        }));
      }
    } catch (err) {
      console.warn('Mongo contact load failed:', err.message);
    }
  }

  try {
    const db = getDb();
    if (db) {
      const snap = await db.collection(COLLECTION).limit(5000).get();
      if (!snap.empty) {
        console.log(`Loaded ${snap.size} contacts/chats from Firestore`);
        return snap.docs.map((d) => {
          const r = d.data() || {};
          let id = r.id;
          if (!id) {
            try {
              id = decodeURIComponent(d.id);
            } catch {
              id = d.id;
            }
          }
          return {
            id,
            name: r.name || id || d.id,
            isGroup: Boolean(r.isGroup),
          };
        });
      }
    }
  } catch (err) {
    console.warn('Firestore contact load failed:', err.message);
  }

  // Last resort: Mongo even if not preferred
  if (!preferMongo && isMongoConfigured()) {
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

  return [];
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
    const db = getDb();
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

async function countContacts() {
  try {
    const preferMongo = String(process.env.WA_SESSION_BACKEND || '').toLowerCase() === 'mongodb';
    if (preferMongo && isMongoConfigured()) {
      await connectMongo();
      return getMongoose().connection.db.collection(COLLECTION).countDocuments();
    }
    const db = getDb();
    if (!db) return 0;
    const snap = await db.collection(COLLECTION).limit(5000).get();
    return snap.size;
  } catch {
    return 0;
  }
}

module.exports = {
  saveContacts,
  loadContacts,
  clearContacts,
  countContacts,
  contactDocId,
};
