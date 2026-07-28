const fs = require('fs');
const path = require('path');
const { getFirestore } = require('./firebase');

const SESSION_CLIENT_ID = 'poll';
const SESSION_NAME = `RemoteAuth-${SESSION_CLIENT_ID}`;
const META_COLLECTION = 'wa_sessions';
/** Keep each Firestore doc well under the 1 MiB limit. */
const CHUNK_BYTES = 700 * 1024;

/**
 * RemoteAuth store backed by Firestore (chunked zip).
 * No Firebase Storage and no Render Disk required.
 *
 * Collections:
 *   wa_sessions/{session}              — metadata
 *   wa_sessions/{session}/chunks/{i}   — binary chunks
 */
class FirebaseSessionStore {
  constructor({ dataPath }) {
    this.dataPath = dataPath;
    this._existsCache = null;
  }

  _db() {
    const db = getFirestore();
    if (!db) throw new Error('Firestore is not initialized');
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

  async sessionExists({ session }) {
    try {
      const snap = await this._metaRef(session).get();
      const exists = snap.exists && Number(snap.data()?.chunkCount || 0) > 0;
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
    const chunksRef = this._chunksRef(session);

    // Clear old chunks first
    await this._deleteChunks(session);

    const batchSize = 400; // stay under Firestore 500 ops/batch
    let batch = this._db().batch();
    let ops = 0;

    for (let i = 0; i < chunkCount; i++) {
      const start = i * CHUNK_BYTES;
      const slice = buffer.subarray(start, start + CHUNK_BYTES);
      batch.set(chunksRef.doc(String(i)), {
        index: i,
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

    batch.set(
      this._metaRef(session),
      {
        session,
        chunkCount,
        totalSize: buffer.length,
        savedAt: new Date().toISOString(),
        backend: 'firestore',
      },
      { merge: true }
    );
    ops += 1;
    await batch.commit();

    this._existsCache = true;
    console.log(
      `WhatsApp session backed up to Firestore (${chunkCount} chunks, ${buffer.length} bytes)`
    );
  }

  async extract({ session, path: destPath }) {
    const metaSnap = await this._metaRef(session).get();
    if (!metaSnap.exists) {
      throw new Error(`No Firestore WhatsApp session found for ${session}`);
    }

    const meta = metaSnap.data() || {};
    const chunkCount = Number(meta.chunkCount || 0);
    if (chunkCount < 1) {
      throw new Error(`Firestore session ${session} has no chunks`);
    }

    const chunksRef = this._chunksRef(session);
    const parts = [];

    for (let i = 0; i < chunkCount; i++) {
      const snap = await chunksRef.doc(String(i)).get();
      if (!snap.exists) {
        throw new Error(`Missing session chunk ${i}/${chunkCount}`);
      }
      const raw = snap.data()?.data;
      if (!raw) throw new Error(`Empty session chunk ${i}`);
      // Admin SDK may return Buffer, Uint8Array, or Firestore Bytes
      const buf = Buffer.isBuffer(raw)
        ? raw
        : Buffer.from(raw._bytes || raw.toUint8Array?.() || raw);
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
    // Delete in pages
    for (;;) {
      const snap = await chunksRef.limit(400).get();
      if (snap.empty) break;
      const batch = this._db().batch();
      snap.docs.forEach((doc) => batch.delete(doc.ref));
      await batch.commit();
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

module.exports = {
  FirebaseSessionStore,
  SESSION_CLIENT_ID,
  SESSION_NAME,
};
