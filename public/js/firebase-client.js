/**
 * Firebase client — realtime poll sync when Firestore is enabled on the server.
 */
async function initFirebaseRealtime(onPollsUpdate) {
  try {
    const res = await fetch('/api/firebase-config');
    const config = await res.json();
    if (!config.enabled) return;

    const { initializeApp } = await import(
      'https://www.gstatic.com/firebasejs/11.6.0/firebase-app.js'
    );
    const { getFirestore, collection, onSnapshot, query, orderBy } = await import(
      'https://www.gstatic.com/firebasejs/11.6.0/firebase-firestore.js'
    );

    const app = initializeApp({
      apiKey: config.apiKey,
      authDomain: config.authDomain,
      projectId: config.projectId,
      storageBucket: config.storageBucket,
      messagingSenderId: config.messagingSenderId,
      appId: config.appId,
    });

    const db = getFirestore(app);
    const pollsQuery = query(collection(db, 'scheduled_polls'), orderBy('createdAt', 'desc'));

    onSnapshot(pollsQuery, (snapshot) => {
      const polls = snapshot.docs.map((doc) => {
        const data = doc.data();
        return {
          id: doc.id,
          question: data.question,
          options: data.options || [],
          chatIds: data.chatIds || [],
          allowMultiple: Boolean(data.allowMultiple),
          scheduledAt: data.scheduledAt,
          status: data.status,
          humanDelayMin: data.humanDelayMin,
          humanDelayMax: data.humanDelayMax,
          repeatDaily: Boolean(data.repeatDaily),
          createdAt: data.createdAt,
          sentAt: data.sentAt,
          error: data.error,
        };
      });
      onPollsUpdate(polls);
    });
  } catch (err) {
    console.warn('Firebase realtime unavailable:', err.message);
  }
}

window.initFirebaseRealtime = initFirebaseRealtime;
