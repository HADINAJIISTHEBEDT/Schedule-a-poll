const fs = require('fs');
const path = require('path');
const { MongoStore } = require('wwebjs-mongo');
const { connectMongo, getMongoose, isMongoConfigured } = require('./mongo');
const { SESSION_NAME } = require('./waSessionStore');

/**
 * wwebjs-mongo reads/writes `${session}.zip` from process.cwd(),
 * while RemoteAuth writes the zip under dataPath. This wrapper bridges them.
 */
class MongoSessionStore {
  constructor({ dataPath, mongoose }) {
    this.dataPath = dataPath;
    this.inner = new MongoStore({ mongoose });
    this._existsCache = null;
  }

  _cwdZip(session) {
    return path.join(process.cwd(), `${session}.zip`);
  }

  _dataZip(session) {
    return path.join(this.dataPath, `${session}.zip`);
  }

  async sessionExists({ session }) {
    const exists = await this.inner.sessionExists({ session });
    this._existsCache = exists;
    return exists;
  }

  async save({ session }) {
    const dataZip = this._dataZip(session);
    const cwdZip = this._cwdZip(session);
    if (!fs.existsSync(dataZip)) {
      console.warn('RemoteAuth zip missing for Mongo save:', dataZip);
      return;
    }
    fs.copyFileSync(dataZip, cwdZip);
    try {
      await this.inner.save({ session });
      this._existsCache = true;
      console.log('WhatsApp session backed up to MongoDB Atlas');
    } finally {
      try {
        fs.unlinkSync(cwdZip);
      } catch {
        // ignore
      }
    }
  }

  async extract({ session, path: destPath }) {
    await this.inner.extract({ session, path: destPath });
    console.log('WhatsApp session restored from MongoDB →', destPath);
  }

  async delete({ session }) {
    await this.inner.delete({ session });
    this._existsCache = false;
    console.log('WhatsApp session removed from MongoDB');
  }

  get cachedExists() {
    return this._existsCache === true;
  }

  setCachedExists(value) {
    this._existsCache = Boolean(value);
  }
}

async function createMongoSessionStore(dataPath) {
  if (!isMongoConfigured()) return null;
  const mongoose = await connectMongo();
  return new MongoSessionStore({ dataPath, mongoose });
}

module.exports = {
  MongoSessionStore,
  createMongoSessionStore,
  SESSION_NAME,
};
