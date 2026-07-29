/**
 * Local tests for Firestore session + contact helpers (no live Firebase required).
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  FirebaseSessionStore,
  ProtectedRemoteStore,
  SESSION_NAME,
  isSessionMetaUsable,
  CHUNK_BYTES,
} = require('../server/waSessionStore');
const { contactDocId } = require('../server/contactStore');

async function testProtectedDelete() {
  let deleted = false;
  const inner = {
    async sessionExists() {
      return true;
    },
    async save() {},
    async extract() {},
    async delete() {
      deleted = true;
    },
    cachedExists: true,
    setCachedExists() {},
  };
  const store = new ProtectedRemoteStore(inner);
  await store.delete({ session: SESSION_NAME });
  assert.strictEqual(deleted, false, 'auto delete must be blocked');
  store.allowRemoteDelete(true);
  await store.delete({ session: SESSION_NAME });
  assert.strictEqual(deleted, true, 'explicit delete must run');
  console.log('OK protected delete');
}

async function testChunkRoundTripMath() {
  const buf = Buffer.alloc(1500 * 1024, 9);
  const n = Math.ceil(buf.length / CHUNK_BYTES);
  const parts = [];
  for (let i = 0; i < n; i++) parts.push(buf.subarray(i * CHUNK_BYTES, i * CHUNK_BYTES + CHUNK_BYTES));
  const out = Buffer.concat(parts);
  assert.strictEqual(out.length, buf.length);
  assert.ok(out.equals(buf));
  console.log('OK chunk math');
}

async function testZipPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-store-'));
  const store = new FirebaseSessionStore({ dataPath: dir });
  const expected = path.join(dir, `${SESSION_NAME}.zip`);
  assert.strictEqual(store._zipPath(SESSION_NAME), expected);
  assert.strictEqual(store._chunkDocId('abc', 2), 'abc_2');
  assert.strictEqual(store._chunkDocId(null, 2), '2');
  console.log('OK zip path');
}

function testSessionMetaUsable() {
  assert.strictEqual(isSessionMetaUsable({}), false);
  assert.strictEqual(isSessionMetaUsable({ chunkCount: 0 }), false);
  assert.strictEqual(isSessionMetaUsable({ chunkCount: 3 }), true);
  assert.strictEqual(isSessionMetaUsable({ chunkCount: 3, ready: true }), true);
  assert.strictEqual(isSessionMetaUsable({ chunkCount: 3, ready: false }), false);
  assert.strictEqual(
    isSessionMetaUsable({ chunkCount: 3, ready: false, writing: true }),
    false
  );
  assert.strictEqual(
    isSessionMetaUsable({ chunkCount: 3, ready: true, writing: true }),
    true
  );
  console.log('OK session meta usable');
}

function testBackendPreference() {
  const prevMongo = process.env.MONGODB_URI;
  const prevBackend = process.env.WA_SESSION_BACKEND;
  const prevEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const prevKey = process.env.FIREBASE_PRIVATE_KEY;
  const prevUse = process.env.USE_FIREBASE;

  try {
    process.env.USE_FIREBASE = 'true';
    process.env.FIREBASE_CLIENT_EMAIL = 'a@b.c';
    process.env.FIREBASE_PRIVATE_KEY = 'key';
    process.env.MONGODB_URI = 'mongodb+srv://x';
    delete process.env.WA_SESSION_BACKEND;

    const { isFirebaseConfigured } = require('../server/firebase');
    const { isMongoConfigured } = require('../server/mongo');
    assert.strictEqual(isFirebaseConfigured(), true);
    assert.strictEqual(isMongoConfigured(), true);

    const preferMongo = String(process.env.WA_SESSION_BACKEND || '').toLowerCase() === 'mongodb';
    const USE_MONGO_AUTH = preferMongo && isMongoConfigured();
    const USE_FIRESTORE_AUTH =
      !USE_MONGO_AUTH &&
      (process.env.WA_REMOTE_AUTH === 'true' ||
        (process.env.WA_REMOTE_AUTH !== 'false' && isFirebaseConfigured()));
    assert.strictEqual(USE_MONGO_AUTH, false, 'must prefer Firestore by default');
    assert.strictEqual(USE_FIRESTORE_AUTH, true);

    process.env.WA_SESSION_BACKEND = 'mongodb';
    const preferMongo2 = String(process.env.WA_SESSION_BACKEND || '').toLowerCase() === 'mongodb';
    assert.strictEqual(preferMongo2 && isMongoConfigured(), true);
  } finally {
    if (prevMongo === undefined) delete process.env.MONGODB_URI;
    else process.env.MONGODB_URI = prevMongo;
    if (prevBackend === undefined) delete process.env.WA_SESSION_BACKEND;
    else process.env.WA_SESSION_BACKEND = prevBackend;
    if (prevEmail === undefined) delete process.env.FIREBASE_CLIENT_EMAIL;
    else process.env.FIREBASE_CLIENT_EMAIL = prevEmail;
    if (prevKey === undefined) delete process.env.FIREBASE_PRIVATE_KEY;
    else process.env.FIREBASE_PRIVATE_KEY = prevKey;
    if (prevUse === undefined) delete process.env.USE_FIREBASE;
    else process.env.USE_FIREBASE = prevUse;
  }
  console.log('OK backend preference');
}

function testContactDocId() {
  const id = '15551234567@c.us';
  const docId = contactDocId(id);
  assert.strictEqual(docId, encodeURIComponent(id));
  assert.ok(!docId.includes('/'));
  assert.strictEqual(decodeURIComponent(docId), id);
  console.log('OK contact doc id');
}

function testMergeChatLists() {
  function mergeChatLists(base, extra) {
    const seen = new Set(base.map((c) => c.id));
    const merged = [...base];
    for (const item of extra) {
      if (!seen.has(item.id)) {
        seen.add(item.id);
        merged.push(item);
      }
    }
    return merged;
  }

  const cached = [{ id: '1@c.us', name: 'A', isGroup: false }];
  const live = [
    { id: '1@c.us', name: 'A', isGroup: false },
    { id: '2@c.us', name: 'B', isGroup: false },
  ];
  const out = mergeChatLists(cached, live);
  assert.strictEqual(out.length, 2);
  assert.strictEqual(out[1].id, '2@c.us');
  console.log('OK merge chat lists');
}

function testArabiziMatch() {
  const {
    namesMatch,
    pickBestName,
    preferBetterName,
    foldArabizi,
    toNameString,
    sanitizeChat,
    dedupeSearchResults,
  } = require('../server/waNameUtils');
  // Real nickname match
  assert.ok(namesMatch('Nouraty 7ayety', '1@c.us', '7ayety'));
  // False positive that annoyed the user — Arabic "حياتي" inside a different contact
  assert.ok(!namesMatch('🌏✨عائلتي حياتي🌑♥️', '2@c.us', '7ayety'));
  assert.ok(namesMatch('Hayaty', '1@c.us', '7ayet') || namesMatch('7ayety', '1@c.us', '7ayet'));
  assert.ok(namesMatch(['+961 71 000', '7ayety'], '96171000@c.us', '7ayety'));
  assert.strictEqual(pickBestName(['+961 71 000 000', '7ayety'], 'x'), '7ayety');
  assert.strictEqual(preferBetterName('+961 71 000', '7ayety'), '7ayety');
  assert.strictEqual(foldArabizi('حياتي'), '7yaty');
  assert.strictEqual(toNameString({ name: 'Nouraty 7ayety' }), 'Nouraty 7ayety');
  assert.strictEqual(toNameString({}), '');
  assert.strictEqual(sanitizeChat({ id: '1@c.us', name: { pushname: 'Hello' }, isGroup: false }).name, 'Hello');
  assert.notStrictEqual(sanitizeChat({ id: '1@c.us', name: {}, isGroup: false }).name, '[object Object]');
  const deduped = dedupeSearchResults([
    { id: '1@lid', name: 'Nouraty 7ayety', isGroup: false },
    { id: '1@c.us', name: 'Nouraty 7ayety', isGroup: false },
  ]);
  assert.strictEqual(deduped.length, 1);
  assert.ok(deduped[0].id.endsWith('@c.us'));
  console.log('OK arabizi match');
}

(async () => {
  await testProtectedDelete();
  await testChunkRoundTripMath();
  await testZipPath();
  testSessionMetaUsable();
  testBackendPreference();
  testContactDocId();
  testMergeChatLists();
  testArabiziMatch();
  console.log('All local session-store tests passed');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
