/** Firebase project config (public client values). */
module.exports = {
  apiKey: process.env.FIREBASE_API_KEY || 'AIzaSyC28wkSERK2K-rF5-hz-dbX8ggngU8cq4Q',
  authDomain: process.env.FIREBASE_AUTH_DOMAIN || 'poll-generator-f6697.firebaseapp.com',
  projectId: process.env.FIREBASE_PROJECT_ID || 'poll-generator-f6697',
  storageBucket: process.env.FIREBASE_STORAGE_BUCKET || 'poll-generator-f6697.firebasestorage.app',
  messagingSenderId: process.env.FIREBASE_MESSAGING_SENDER_ID || '647652478326',
  appId: process.env.FIREBASE_APP_ID || '1:647652478326:web:925f8dfbe0814617ea3e57',
};
