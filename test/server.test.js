const test = require('node:test');
const assert = require('node:assert');
const { app, safeUrl } = require('../server');

let server, base;
test.before(async () => {
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server.close());

test('safeUrl allows only http(s)', () => {
  assert.strictEqual(safeUrl('https://a.com/x'), 'https://a.com/x');
  assert.strictEqual(safeUrl('javascript:alert(1)'), null);
  assert.strictEqual(safeUrl('data:text/html,<script>'), null);
  assert.strictEqual(safeUrl('not a url'), null);
  assert.strictEqual(safeUrl(undefined), null);
});

test('security headers are set and x-powered-by hidden', async () => {
  const res = await fetch(`${base}/api/categories`);
  assert.ok(res.headers.get('content-security-policy').includes("script-src 'self'"));
  assert.strictEqual(res.headers.get('x-content-type-options'), 'nosniff');
  assert.strictEqual(res.headers.get('x-powered-by'), null);
});

test('rejects invalid query params', async () => {
  for (const q of ['category=Nope', 'page=0', 'page=abc', 'limit=1000', 'limit=-1']) {
    const res = await fetch(`${base}/api/news?${q}`);
    assert.strictEqual(res.status, 400, q);
  }
});

test('/api/sources does not expose feed URLs', async () => {
  const data = await (await fetch(`${base}/api/sources`)).json();
  assert.ok(data.length > 0);
  assert.deepStrictEqual(Object.keys(data[0]).sort(), ['category', 'name']);
});

test('static frontend is served', async () => {
  const res = await fetch(`${base}/`);
  assert.strictEqual(res.status, 200);
});
