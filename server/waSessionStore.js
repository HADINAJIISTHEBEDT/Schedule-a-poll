const fs = require('fs');
const path = require('path');
const { getFirestore } = require('./firebase');

const SESSION_CLIENT_ID = 'poll';
const SESSION_NAME = `RemoteAuth-${SESSION_CLIENT_ID}`;
const META_COLLECTION = 'wa_sessions';
/** Keep each Firestore doc well under the 1 MiB limit. */
const CHUNK_BYTES = 700 * 1024;

function bufferFromFirestoreBytes(raw) {
  if (!raw) return null;
  if (Buffer.isBuffer(raw)) return raw;
  if (raw instanceof Uint8Array) return Buffer.from(raw);
  if (typeof raw.toBuffer === 'function') return raw.toBuffer();
  if (typeof raw.toUint8Array === 'function') return Buffer.from(raw.toUint8Array());
  if (raw._bytes) return Buffer.from(raw._bytes);
  if (ArrayBuffer.isView(raw)) return Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength);
  throw new Error('Unsupported Firestore bytes type: ' + Object.prototype.toString.call(raw));
}

/**
 * Usable session meta:
 * - New docs: ready === true (and not mid-write)
 * - Legacy docs (saved before ready flag): chunkCount > 0 and ready !== false
 */
function isSessionMetaUsable(data = {}) {
  const chunkCount = Number(data.chunkCount || 0);
  if (chunkCount < 1) return false;
  if (data.writing === true && data.ready === false) return false;
  if (data.ready === false) return false;
  return true;
}

/**
 * RemoteAuth store backed by Firestore (chunked zip).
 * No Firebase Storage and no Render Disk required.
 */
class FirebaseSessionStore {
  constructor({ dataPath }) {
    this.dataPath = dataPath;
    this._existsCache = null;
  }

  _db() {
    const db = getFirestore();
    if (!db) throw new Error('Firestore is not initialized — check FIREBASE_CLIENT_EMAIL + FIREBASE_PRIVATE_KEY');
    return db;
  }

  _zipPath(session) {
    return path.join(this.dataPath, `${session}.zip`);
  }

  _metaRef(session) {
    return this._db().collection(META_COLLECTION).doc(session);
  }

  _chunksRef(session) {
    return this._metaRef(session).collection('chunks');
  }

  _chunkDocId(generation, index) {
    return generation ? `${generation}_${index}` : String(index);
  }

  async sessionExists({ session }) {
    try {
      const snap = await this._metaRef(session).get();
      const data = snap.data() || {};
      const exists = snap.exists && isSessionMetaUsable(data);
      this._existsCache = exists;
      return exists;
    } catch (err) {
      console.warn('Firestore session check failed:', err.message);
      this._existsCache = false;
      return false;
    }
  }

  async save({ session }) {
    const zipPath = this._zipPath(session);
    if (!fs.existsSync(zipPath)) {
      console.warn('RemoteAuth zip missing, skip Firestore save:', zipPath);
      return;
    }

    const buffer = fs.readFileSync(zipPath);
    const chunkCount = Math.max(1, Math.ceil(buffer.length / CHUNK_BYTES));
    const generation = Date.now().toString(36);
    const chunksRef = this._chunksRef(session);

    // Mark writing, but do NOT clear ready yet — keep the previous
    // complete session discoverable if this write crashes mid-way.
    await this._metaRef(session).set(
      {
        session,
        writing: true,
        nextGeneration: generation,
        updatedAt: new Date().toISOString(),
      },
      { merge: true }
    );

    // Write new chunks under generation-scoped ids so we never corrupt the live set
    const batchSize = 400;
    let batch = this._db().batch();
    let ops = 0;

    for (let i = 0; i < chunkCount; i++) {
      const start = i * CHUNK_BYTES;
      const slice = buffer.subarray(start, start + CHUNK_BYTES);
      batch.set(chunksRef.doc(this._chunkDocId(generation, i)), {
        index: i,
        generation,
        data: Buffer.from(slice),
        size: slice.length,
      });
      ops += 1;
      if (ops >= batchSize) {
        await batch.commit();
        batch = this._db().batch();
        ops = 0;
      }
    }

    // Point meta at the new generation only after all chunks exist
    batch.set(
      this._metaRef(session),
      {
        session,
        chunkCount,
        totalSize: buffer.length,
        generation,
        ready: true,
        writing: false,
        savedAt: new Date().toISOString(),
        backend: 'firestore',
      },
      { merge: true }
    );
    await batch.commit();

    this._existsCache = true;
    console.log(
      `WhatsApp session backed up to Firestore (${chunkCount} chunks, ${buffer.length} bytes)`
    );

    // Best-effort cleanup of older chunk docs (legacy numeric + other generations)
    this._deleteStaleChunks(session, generation).catch((err) => {
      console.warn('Firestore stale chunk cleanup failed:', err.message);
    });
  }

  async extract({ session, path: destPath }) {
    const metaSnap = await this._metaRef(session).get();
    if (!metaSnap.exists) {
      throw new Error(`No Firestore WhatsApp session found for ${session}`);
    }

    const meta = metaSnap.data() || {};
    if (!isSessionMetaUsable(meta)) {
      throw new Error(`Firestore session ${session} is incomplete (not ready)`);
    }
    const chunkCount = Number(meta.chunkCount || 0);
    if (chunkCount < 1) {
      throw new Error(`Firestore session ${session} has no chunks`);
    }

    const generation = meta.generation || null;
    const chunksRef = this._chunksRef(session);
    const parts = [];

    for (let i = 0; i < chunkCount; i++) {
      let snap = null;
      if (generation) {
        snap = await chunksRef.doc(this._chunkDocId(generation, i)).get();
      }
      // Legacy sessions used numeric chunk ids ("0", "1", ...)
      if (!snap || !snap.exists) {
        snap = await chunksRef.doc(String(i)).get();
      }
      if (!snap.exists) {
        throw new Error(`Missing session chunk ${i}/${chunkCount}`);
      }
      const raw = snap.data()?.data;
      const buf = bufferFromFirestoreBytes(raw);
      if (!buf || !buf.length) throw new Error(`Empty session chunk ${i}`);
      parts.push(buf);
    }

    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    fs.writeFileSync(destPath, Buffer.concat(parts));
    console.log('WhatsApp session restored from Firestore →', destPath);
  }

  async delete({ session }) {
    try {
      await this._deleteChunks(session);
      await this._metaRef(session).delete();
    } catch (err) {
      console.warn('Firestore session delete failed:', err.message);
    }
    this._existsCache = false;
    console.log('WhatsApp session removed from Firestore');
  }

  async _deleteChunks(session) {
    const chunksRef = this._chunksRef(session);
    for (;;) {
      const snap = await chunksRef.limit(400).get();
      if (snap.empty) break;
      const batch = this._db().batch();
      snap.docs.forEach((doc) => batch.delete(doc.ref));
      await batch.commit();
      if (snap.size < 400) break;
    }
  }

  async _deleteStaleChunks(session, keepGeneration) {
    const chunksRef = this._chunksRef(session);
    for (;;) {
      const snap = await chunksRef.limit(400).get();
      if (snap.empty) break;
      const batch = this._db().batch();
      let ops = 0;
      snap.docs.forEach((doc) => {
        const data = doc.data() || {};
        const keep =
          keepGeneration &&
          (doc.id.startsWith(`${keepGeneration}_`) || data.generation === keepGeneration);
        if (!keep) {
          batch.delete(doc.ref);
          ops += 1;
        }
      });
      if (ops) await batch.commit();
      // If page was all keepers, still need to advance — delete nothing but break if full keep
      if (ops === 0 && snap.size < 400) break;
      if (ops === 0) {
        // Avoid infinite loop if a full page is all current-generation chunks
        break;
      }
      if (snap.size < 400) break;
    }
  }

  get cachedExists() {
    return this._existsCache === true;
  }

  setCachedExists(value) {
    this._existsCache = Boolean(value);
  }
}

/**
 * whatsapp-web.js RemoteAuth calls store.delete() on many transient disconnects.
 * That was wiping Firebase login. Only allow delete when we explicitly ask.
 */
class ProtectedRemoteStore {
  constructor(inner) {
    this.inner = inner;
    this.allowDelete = false;
  }

  sessionExists(opts) {
    return this.inner.sessionExists(opts);
  }

  save(opts) {
    return this.inner.save(opts);
  }

  extract(opts) {
    return this.inner.extract(opts);
  }

  async delete(opts) {
    if (!this.allowDelete) {
      console.warn(
        'Blocked automatic remote session delete (keeping Firebase login). Use Disconnect to clear.'
      );
      return;
    }
    return this.inner.delete(opts);
  }

  get cachedExists() {
    return this.inner.cachedExists;
  }

  setCachedExists(value) {
    return this.inner.setCachedExists?.(value);
  }

  allowRemoteDelete(enabled) {
    this.allowDelete = Boolean(enabled);
  }
}

module.exports = {
  FirebaseSessionStore,
  ProtectedRemoteStore,
  SESSION_CLIENT_ID,
  SESSION_NAME,
  isSessionMetaUsable,
  CHUNK_BYTES,
};
