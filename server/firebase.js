const { initializeApp, getApps, cert, applicationDefault } = require('firebase-admin');
const { getFirestore } = require('firebase-admin/firestore');
const firebaseConfig = require('./firebase-config');

let firestore = null;

function isFirebaseConfigured() {
  const hasCredentials = Boolean(
    process.env.FIREBASE_PRIVATE_KEY ||
      process.env.GOOGLE_APPLICATION_CREDENTIALS ||
      (process.env.FIREBASE_CLIENT_EMAIL && process.env.FIREBASE_PRIVATE_KEY)
  );

  if (process.env.USE_FIREBASE === 'false') return false;
  if (process.env.USE_FIREBASE === 'true') return hasCredentials;
  return hasCredentials;
}

function initFirebaseAdmin() {
  if (!isFirebaseConfigured()) return null;

  if (getApps().length > 0) {
    firestore = getFirestore();
    return firestore;
  }

  const projectId = firebaseConfig.projectId;

  if (process.env.FIREBASE_PRIVATE_KEY && process.env.FIREBASE_CLIENT_EMAIL) {
    initializeApp({
      credential: cert({
        projectId,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
      }),
    });
  } else if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    initializeApp({
      credential: applicationDefault(),
      projectId,
    });
  } else {
    console.warn('USE_FIREBASE is set but service account credentials are missing');
    return null;
  }

  firestore = getFirestore();
  console.log('Firebase Admin connected to project:', projectId);
  return firestore;
}

function getFirestoreDb() {
  if (!firestore) {
    initFirebaseAdmin();
  }
  return firestore;
}

module.exports = {
  isFirebaseConfigured,
  initFirebaseAdmin,
  getFirestore: getFirestoreDb,
  firebaseConfig,
};
