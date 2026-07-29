const fs = require('fs');
const path = require('path');
const { getFirestore, initFirebaseAdmin } = require('./firebase');
const { isMongoConfigured, connectMongo, getMongoose } = require('./mongo');

const COLLECTION = 'wa_contacts';
const DATA_ROOT = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const LOCAL_CONTACTS_PATH = path.join(DATA_ROOT, 'wa_contacts.json');

function contactDocId(id) {
  // Firestore doc ids cannot contain "/"; WA ids use @ which is fine once encoded.
  return encodeURIComponent(String(id)).slice(0, 700);
}

function getDb() {
  return getFirestore() || initFirebaseAdmin();
}

function normalizeList(contacts = []) {
  return (contacts || [])
    .filter((c) => c && c.id)
    .map((c) => ({
      id: String(c.id),
      name: String(c.name || c.id),
      isGroup: Boolean(c.isGroup),
      updatedAt: c.updatedAt || new Date().toISOString(),
    }));
}

function mergeById(existing = [], incoming = []) {
  const map = new Map();
  for (const row of existing) {
    if (row?.id) map.set(String(row.id), row);
  }
  for (const row of incoming) {
    if (!row?.id) continue;
    const id = String(row.id);
    const prev = map.get(id);
    if (!prev) {
      map.set(id, row);
      continue;
    }
    const prevName = String(prev.name || '');
    const nextName = String(row.name || '');
    map.set(id, {
      ...prev,
      ...row,
      name: nextName && nextName !== id ? nextName : prevName || nextName || id,
      isGroup: Boolean(row.isGroup ?? prev.isGroup),
      updatedAt: row.updatedAt || prev.updatedAt || new Date().toISOString(),
    });
  }
  return Array.from(map.values());
}

function saveContactsToDisk(list) {
  fs.mkdirSync(DATA_ROOT, { recursive: true });
  let existing = [];
  try {
    if (fs.existsSync(LOCAL_CONTACTS_PATH)) {
      const parsed = JSON.parse(fs.readFileSync(LOCAL_CONTACTS_PATH, 'utf8'));
      if (Array.isArray(parsed)) existing = parsed;
      else if (Array.isArray(parsed?.contacts)) existing = parsed.contacts;
    }
  } catch (err) {
    console.warn('Local contacts read failed:', err.message);
  }

  const merged = mergeById(existing, list);
  fs.writeFileSync(
    LOCAL_CONTACTS_PATH,
    JSON.stringify(
      {
        updatedAt: new Date().toISOString(),
        contacts: merged,
      },
      null,
      2
    )
  );
  console.log(`Saved ${merged.length} contacts/chats to disk (${LOCAL_CONTACTS_PATH})`);
  return merged.length;
}

function loadContactsFromDisk() {
  try {
    if (!fs.existsSync(LOCAL_CONTACTS_PATH)) return [];
    const parsed = JSON.parse(fs.readFileSync(LOCAL_CONTACTS_PATH, 'utf8'));
    const rows = Array.isArray(parsed) ? parsed : parsed?.contacts;
    if (!Array.isArray(rows) || !rows.length) return [];
    console.log(`Loaded ${rows.length} contacts/chats from disk`);
    return rows.map((r) => ({
      id: String(r.id),
      name: String(r.name || r.id),
      isGroup: Boolean(r.isGroup),
    }));
  } catch (err) {
    console.warn('Local contacts load failed:', err.message);
    return [];
  }
}

/**
 * Persist chats/contacts so search still works after restarts
 * while WhatsApp is reconnecting from a saved login.
 * Primary: disk under DATA_DIR (same idea as localhost).
 * Optional: Firestore / Mongo when configured.
 */
async function saveContacts(contacts = []) {
  const list = normalizeList(contacts);
  if (!list.length) return 0;

  let saved = 0;
  try {
    saved = saveContactsToDisk(list);
  } catch (err) {
    console.warn('Disk contact save failed:', err.message);
  }

  const preferMongo = String(process.env.WA_SESSION_BACKEND || '').toLowerCase() === 'mongodb';

  // Optional cloud copies (do not block disk persistence)
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
        saved = Math.max(saved, list.length);
      }
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
      saved = Math.max(saved, list.length);
    } catch (err) {
      console.warn('Mongo contact save failed:', err.message);
    }
  }

  return saved;
}

async function loadContacts() {
  const fromDisk = loadContactsFromDisk();
  if (fromDisk.length) return fromDisk;

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
  try {
    if (fs.existsSync(LOCAL_CONTACTS_PATH)) fs.rmSync(LOCAL_CONTACTS_PATH, { force: true });
  } catch (err) {
    console.warn('Local contact clear failed:', err.message);
  }

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
    if (snap.size >= 400) await clearContacts();
  } catch (err) {
    console.warn('Firestore contact clear failed:', err.message);
  }
}

async function countContacts() {
  try {
    const fromDisk = loadContactsFromDisk();
    if (fromDisk.length) return fromDisk.length;

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
  LOCAL_CONTACTS_PATH,
};
