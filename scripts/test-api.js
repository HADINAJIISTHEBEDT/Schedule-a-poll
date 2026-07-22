#!/usr/bin/env node
const BASE = process.env.TEST_URL || 'http://localhost:3000';

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed++;
    console.error(`  ✗ ${name}: ${err.message}`);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

async function json(path, options) {
  const res = await fetch(`${BASE}${path}`, options);
  const body = await res.json().catch(() => ({}));
  return { res, body };
}

async function run() {
  console.log(`Testing ${BASE}\n`);

  await test('GET / serves HTML', async () => {
    const res = await fetch(BASE);
    const html = await res.text();
    assert(res.ok, `status ${res.status}`);
    assert(html.includes('Poll Scheduler'), 'missing title');
    assert(html.includes('app.js'), 'missing app.js');
  });

  await test('GET /api/status returns disconnected on fresh start', async () => {
    const { res, body } = await json('/api/status');
    assert(res.ok, `status ${res.status}`);
    assert(body.state === 'disconnected', `expected disconnected, got ${body.state}`);
    assert(body.qr === null, 'qr should be null');
  });

  await test('GET /api/chats fails when disconnected', async () => {
    const { res, body } = await json('/api/chats');
    assert(res.status === 400, `expected 400, got ${res.status}`);
    assert(body.error, 'expected error message');
  });

  await test('POST /api/polls creates scheduled poll', async () => {
    const future = new Date(Date.now() + 3600000).toISOString();
    const { res, body } = await json('/api/polls', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        question: 'Test poll?',
        options: ['Yes', 'No'],
        chatIds: ['12345@g.us'],
        scheduledAt: future,
      }),
    });
    assert(res.ok, body.error || `status ${res.status}`);
    assert(body.id, 'missing poll id');
  });

  await test('GET /api/polls returns created poll', async () => {
    const { res, body } = await json('/api/polls');
    assert(res.ok, `status ${res.status}`);
    assert(Array.isArray(body), 'expected array');
    assert(body.length >= 1, 'expected at least 1 poll');
    assert(body[0].question === 'Test poll?', 'wrong question');
    assert(body[0].status === 'pending', 'wrong status');
  });

  await test('DELETE /api/polls/:id removes pending poll', async () => {
    const { body: polls } = await json('/api/polls');
    const id = polls[0].id;
    const { res } = await json(`/api/polls/${id}`, { method: 'DELETE' });
    assert(res.ok, `status ${res.status}`);
    const { body: after } = await json('/api/polls');
    assert(!after.find((p) => p.id === id), 'poll still exists');
  });

  await test('POST /api/connect returns QR code', async () => {
    const { res, body } = await json('/api/connect', { method: 'POST' });
    assert(res.ok, body.error || `status ${res.status}`);
    assert(['qr', 'connecting', 'ready'].includes(body.state), `unexpected state ${body.state}`);
    if (body.state === 'qr') {
      assert(body.qr?.startsWith('data:image'), 'missing QR image');
    }
  });

  await test('GET /api/status reflects connecting/qr state', async () => {
    const { res, body } = await json('/api/status');
    assert(res.ok, `status ${res.status}`);
    assert(['connecting', 'qr', 'authenticated', 'ready'].includes(body.state), `state ${body.state}`);
  });

  await test('POST /api/disconnect clears session', async () => {
    const { res, body } = await json('/api/disconnect', { method: 'POST' });
    assert(res.ok, `status ${res.status}`);
    assert(body.ok, 'disconnect failed');
    const { body: status } = await json('/api/status');
    assert(status.state === 'disconnected', `expected disconnected, got ${status.state}`);
  });

  await test('Reconnect after disconnect shows fresh QR', async () => {
    const { res, body } = await json('/api/connect', { method: 'POST' });
    assert(res.ok, body.error || `status ${res.status}`);
    assert(body.state === 'qr', `expected qr, got ${body.state}`);
    assert(body.qr?.startsWith('data:image'), 'missing QR');
    await json('/api/disconnect', { method: 'POST' });
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

run().catch((err) => {
  console.error('Test runner failed:', err.message);
  process.exit(1);
});
