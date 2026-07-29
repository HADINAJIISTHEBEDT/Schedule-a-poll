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
  const prevRemote = process.env.WA_REMOTE_AUTH;

  try {
    process.env.USE_FIREBASE = 'true';
    process.env.FIREBASE_CLIENT_EMAIL = 'a@b.c';
    process.env.FIREBASE_PRIVATE_KEY = 'key';
    process.env.MONGODB_URI = 'mongodb+srv://x';
    delete process.env.WA_SESSION_BACKEND;
    delete process.env.WA_REMOTE_AUTH;

    const { isFirebaseConfigured } = require('../server/firebase');
    const { isMongoConfigured } = require('../server/mongo');
    assert.strictEqual(isFirebaseConfigured(), true);
    assert.strictEqual(isMongoConfigured(), true);

    // Default = LocalAuth (like localhost). Remote only when WA_REMOTE_AUTH=true.
    const preferMongo = String(process.env.WA_SESSION_BACKEND || '').toLowerCase() === 'mongodb';
    const remoteAuthRequested = String(process.env.WA_REMOTE_AUTH || '').toLowerCase() === 'true';
    const USE_MONGO_AUTH = remoteAuthRequested && preferMongo && isMongoConfigured();
    const USE_FIRESTORE_AUTH =
      remoteAuthRequested && !USE_MONGO_AUTH && isFirebaseConfigured();
    assert.strictEqual(USE_MONGO_AUTH, false);
    assert.strictEqual(USE_FIRESTORE_AUTH, false, 'default must be LocalAuth');

    process.env.WA_REMOTE_AUTH = 'true';
    const remoteAuthRequested2 = String(process.env.WA_REMOTE_AUTH || '').toLowerCase() === 'true';
    const USE_FIRESTORE_AUTH2 =
      remoteAuthRequested2 &&
      !(String(process.env.WA_SESSION_BACKEND || '').toLowerCase() === 'mongodb' && isMongoConfigured()) &&
      isFirebaseConfigured();
    assert.strictEqual(USE_FIRESTORE_AUTH2, true, 'explicit WA_REMOTE_AUTH=true uses Firestore');

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
    if (prevRemote === undefined) delete process.env.WA_REMOTE_AUTH;
    else process.env.WA_REMOTE_AUTH = prevRemote;
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

async function testDiskContactPersist() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-contacts-'));
  const prevData = process.env.DATA_DIR;
  process.env.DATA_DIR = tmp;
  try {
    delete require.cache[require.resolve('../server/contactStore')];
    const store = require('../server/contactStore');
    const n = await store.saveContacts([
      { id: '96170800643@c.us', name: '7ayety', isGroup: false },
      { id: 'group@g.us', name: 'Family', isGroup: true },
    ]);
    assert.ok(n >= 2);
    const loaded = await store.loadContacts();
    assert.strictEqual(loaded.length, 2);
    assert.ok(loaded.some((c) => c.name === '7ayety'));
    assert.ok(fs.existsSync(path.join(tmp, 'wa_contacts.json')));
  } finally {
    if (prevData === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = prevData;
    delete require.cache[require.resolve('../server/contactStore')];
  }
  console.log('OK disk contact persist');
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
  assert.ok(!namesMatch('🌏✨عائلتي حياتي🌑♥️', '2@c.us', '7ayety'));
  assert.ok(!namesMatch('7amety', '3@c.us', '7ayety'));
  assert.ok(!namesMatch('Bu Hadi', '4@c.us', '7ayety'));
  assert.ok(namesMatch(['+961 71 000', '7ayety'], '96171000@c.us', '7ayety'));
  assert.strictEqual(
    pickBestName(['Nouraty 7ayety', '7ayety', '+961 71'], 'x', '7ayety'),
    '7ayety'
  );
  // Without a query, keep address-book-first order from collectors
  assert.strictEqual(pickBestName(['7ayety', 'Nouraty 7ayety'], 'x'), '7ayety');
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
  await testDiskContactPersist();
  testMergeChatLists();
  testArabiziMatch();
  console.log('All local session-store tests passed');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
