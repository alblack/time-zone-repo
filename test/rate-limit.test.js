const test = require('node:test');
const assert = require('node:assert');
const { app } = require('../server');

// Own file => own process => a fresh limiter window (60 requests / minute / IP on /api/).
let server, base;
test.before(async () => { await new Promise((r) => { server = app.listen(0, r); }); base = `http://127.0.0.1:${server.address().port}`; });
test.after(() => server.close());

test('/api/ is rate limited: 60 requests pass, the 61st gets 429 with standard headers', async () => {
  let res = await fetch(`${base}/api/categories`);
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.headers.get('ratelimit-limit'), '60');
  assert.strictEqual(res.headers.get('ratelimit-remaining'), '59');
  assert.ok(res.headers.get('ratelimit-reset'));
  assert.strictEqual(res.headers.get('x-ratelimit-limit'), null, 'legacy headers are off');

  for (let i = 0; i < 59; i++) {
    res = await fetch(`${base}/api/categories`);
    assert.strictEqual(res.status, 200, `request ${i + 2}`);
  }
  res = await fetch(`${base}/api/categories`);
  assert.strictEqual(res.status, 429);
  assert.strictEqual(res.headers.get('ratelimit-remaining'), '0');
  assert.ok(Number(res.headers.get('retry-after')) > 0);
});

test('the limit covers every /api/ route, but not static files', async () => {
  for (const p of ['/api/sources', '/api/news?limit=1']) {
    assert.strictEqual((await fetch(`${base}${p}`)).status, 429, p);
  }
  assert.strictEqual((await fetch(`${base}/`)).status, 200);
});

test('without TRUST_PROXY, X-Forwarded-For is ignored (clients cannot pick their own bucket)', async () => {
  const res = await fetch(`${base}/api/categories`, { headers: { 'x-forwarded-for': '203.0.113.9' } });
  assert.strictEqual(res.status, 429);
});
