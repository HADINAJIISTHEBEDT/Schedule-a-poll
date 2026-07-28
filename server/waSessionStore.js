const fs = require('fs');
const path = require('path');
const { getStorage } = require('firebase-admin/storage');
const { getFirestore } = require('./firebase');
const firebaseConfig = require('./firebase-config');

const SESSION_CLIENT_ID = 'poll';
const SESSION_NAME = `RemoteAuth-${SESSION_CLIENT_ID}`;
const STORAGE_OBJECT = `whatsapp-sessions/${SESSION_NAME}.zip`;
const META_COLLECTION = 'wa_sessions';

/**
 * RemoteAuth store backed by Firebase Storage (no Render Disk required).
 * Interface required by whatsapp-web.js RemoteAuth:
 *   sessionExists({ session })
 *   save({ session })
 *   extract({ session, path })
 *   delete({ session })
 */
class FirebaseSessionStore {
  constructor({ dataPath }) {
    this.dataPath = dataPath;
    this._existsCache = null;
  }

  _bucket() {
    const bucketName =
      process.env.FIREBASE_STORAGE_BUCKET ||
      firebaseConfig.storageBucket ||
      `${firebaseConfig.projectId}.appspot.com`;
    return getStorage().bucket(bucketName);
  }

  _zipPath(session) {
    return path.join(this.dataPath, `${session}.zip`);
  }

  async sessionExists({ session }) {
    try {
      const db = getFirestore();
      if (db) {
        const snap = await db.collection(META_COLLECTION).doc(session).get();
        if (snap.exists) {
          this._existsCache = true;
          return true;
        }
      }
    } catch (err) {
      console.warn('Firestore session meta check failed:', err.message);
    }

    try {
      const [exists] = await this._bucket().file(STORAGE_OBJECT).exists();
      this._existsCache = exists;
      return exists;
    } catch (err) {
      console.warn('Firebase Storage session check failed:', err.message);
      this._existsCache = false;
      return false;
    }
  }

  async save({ session }) {
    const zipPath = this._zipPath(session);
    if (!fs.existsSync(zipPath)) {
      console.warn('RemoteAuth zip missing, skip Firebase save:', zipPath);
      return;
    }

    await this._bucket().upload(zipPath, {
      destination: STORAGE_OBJECT,
      metadata: {
        contentType: 'application/zip',
        metadata: {
          session,
          savedAt: new Date().toISOString(),
        },
      },
    });

    try {
      const db = getFirestore();
      if (db) {
        await db.collection(META_COLLECTION).doc(session).set(
          {
            session,
            savedAt: new Date().toISOString(),
            storagePath: STORAGE_OBJECT,
          },
          { merge: true }
        );
      }
    } catch (err) {
      console.warn('Could not write session meta to Firestore:', err.message);
    }

    this._existsCache = true;
    console.log('WhatsApp session backed up to Firebase Storage:', STORAGE_OBJECT);
  }

  async extract({ session, path: destPath }) {
    await this._bucket().file(STORAGE_OBJECT).download({ destination: destPath });
    console.log('WhatsApp session restored from Firebase Storage →', destPath);
  }

  async delete({ session }) {
    try {
      await this._bucket().file(STORAGE_OBJECT).delete({ ignoreNotFound: true });
    } catch (err) {
      console.warn('Firebase Storage session delete failed:', err.message);
    }

    try {
      const db = getFirestore();
      if (db) await db.collection(META_COLLECTION).doc(session).delete();
    } catch {
      // ignore
    }

    this._existsCache = false;
    console.log('WhatsApp session removed from Firebase');
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
  STORAGE_OBJECT,
};
