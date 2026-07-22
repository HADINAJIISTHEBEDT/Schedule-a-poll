const { isFirebaseConfigured, initFirebaseAdmin, getFirestore } = require('../firebase');

let db;

function getDatabase() {
  if (db) return db;

  if (isFirebaseConfigured()) {
    try {
      initFirebaseAdmin();
      if (getFirestore()) {
        db = require('./firestore');
        console.log('Using Firestore for poll storage');
        return db;
      }
    } catch (err) {
      console.error('Firebase init failed, falling back to SQLite:', err.message);
    }
  }

  db = require('./sqlite');
  console.log('Using SQLite for poll storage');
  return db;
}

module.exports = new Proxy(
  {},
  {
    get(_target, prop) {
      const adapter = getDatabase();
      const value = adapter[prop];
      return typeof value === 'function' ? value.bind(adapter) : value;
    },
  }
);
