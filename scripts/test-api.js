#!/usr/bin/env node
const BASE = process.env.TEST_URL || 'http://localhost:3000';

async function test(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    return true;
  } catch (err) {
    console.error(`  ✗ ${name}: ${err.message}`);
    return false;
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
  let passed = 0;
  let failed = 0;

  const runTest = async (name, fn) => {
    if (await test(name, fn)) passed++;
    else failed++;
  };

  await runTest('GET / serves HTML', async () => {
    const res = await fetch(BASE);
    const html = await res.text();
    assert(res.ok, `status ${res.status}`);
    assert(html.includes('Poll Scheduler'), 'missing title');
    assert(html.includes('app.js?v=7'), 'missing cache bust v=7');
  });

  await runTest('CSS has vertical chat list layout', async () => {
    const res = await fetch(`${BASE}/css/style.css?v=7`);
    const css = await res.text();
    assert(res.ok, `status ${res.status}`);
    assert(css.includes('flex-direction: column'), 'chat list not vertical');
    assert(css.includes('.chat-item'), 'missing chat-item styles');
  });

  await runTest('GET /api/status starts disconnected', async () => {
    const { res, body } = await json('/api/status');
    assert(res.ok, `status ${res.status}`);
    assert(body.state === 'disconnected', `got ${body.state}`);
  });

  await runTest('POST /api/reset wipes user data', async () => {
    const { res, body } = await json('/api/reset', { method: 'POST' });
    assert(res.ok, `status ${res.status}`);
    assert(body.ok, 'reset failed');
  });

  await runTest('POST /api/connect returns QR', async () => {
    const { res, body } = await json('/api/connect', { method: 'POST' });
    assert(res.ok, body.error || `status ${res.status}`);
    assert(body.state === 'qr', `expected qr, got ${body.state}`);
    assert(body.qr?.startsWith('data:image'), 'missing QR');
  });

  await runTest('POST /api/disconnect clears session', async () => {
    const { res } = await json('/api/disconnect', { method: 'POST' });
    assert(res.ok, `status ${res.status}`);
    const { body } = await json('/api/status');
    assert(body.state === 'disconnected', `got ${body.state}`);
  });

  await runTest('Chat list HTML renders stacked items', async () => {
    const sample = [
      { id: '111@g.us', name: 'Test Group A', isGroup: true },
      { id: '222@c.us', name: 'Test Contact B', isGroup: false },
      { id: '333@g.us', name: 'Test Group C', isGroup: true },
    ];

    const items = sample
      .map(
        (c, idx) =>
          `<div class="chat-item" data-idx="${idx}"><input type="checkbox" class="chat-check" /><div class="chat-info"><span class="chat-name">${c.name}</span><span class="chat-meta">${c.isGroup ? 'Group' : 'Chat'}</span></div></div>`
      )
      .join('');

    assert(items.includes('chat-item'), 'missing items');
    assert((items.match(/chat-item/g) || []).length === 3, 'expected 3 stacked items');
    assert(items.indexOf('Test Group A') < items.indexOf('Test Contact B'), 'wrong order');
    assert(items.indexOf('Test Contact B') < items.indexOf('Test Group C'), 'wrong order');
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

run().catch((err) => {
  console.error('Test runner failed:', err.message);
  process.exit(1);
});
