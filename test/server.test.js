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

test('rejects ambiguous or non-integer page/limit values', async () => {
  const bad = [
    'page=1&page=2', 'limit=5&limit=6', 'page=1abc', 'page=1.5', 'page=+1', 'page=1e3',
    'limit=5.5', 'limit=1e3', 'limit=0x10', 'limit=', 'page=1234567',
    'category=General&category=Politics',
  ];
  for (const q of bad) {
    const res = await fetch(`${base}/api/news?${q}`);
    assert.strictEqual(res.status, 400, q);
    assert.ok(['Invalid page or limit', 'Invalid category'].includes((await res.json()).error), q);
  }
});

test('accepts plain integer page/limit', async () => {
  const { feedLoader } = require('../server');
  const original = feedLoader.parse;
  feedLoader.parse = async () => ({ items: [] }); // no network
  try {
    for (const q of ['', 'page=1&limit=5', 'page=2&limit=50', 'page=007']) {
      const res = await fetch(`${base}/api/news?${q}`);
      assert.strictEqual(res.status, 200, q);
    }
  } finally {
    feedLoader.parse = original;
  }
});

test('unknown routes return a generic JSON 404', async () => {
  const res = await fetch(`${base}/nope`);
  assert.strictEqual(res.status, 404);
  assert.deepStrictEqual(await res.json(), { error: 'Not found' });
});

test('malformed URLs get a generic JSON 404 with no stack trace or paths', async () => {
  for (const p of ['/%', '/%E0%A4%A', '/api/%']) {
    const res = await fetch(`${base}${p}`);
    const body = await res.text();
    assert.strictEqual(res.status, 404, p);
    assert.ok(!/\bat \w|node_modules|\/home\/|server\.js|Error:/.test(body), `${p} leaked: ${body.slice(0, 120)}`);
    assert.deepStrictEqual(JSON.parse(body), { error: 'Not found' }, p);
  }
});

test('unexpected errors return a generic 500 and are not leaked', async () => {
  const express = require('express');
  const { errorHandler } = require('../server');
  const probe = express();
  probe.get('/boom', () => { throw new Error('secret internal detail /home/x/y'); });
  probe.use(errorHandler);
  const s = await new Promise((r) => { const srv = probe.listen(0, () => r(srv)); });
  const log = console.error;
  console.error = () => {}; // the handler logs the real error server-side
  try {
    const res = await fetch(`http://127.0.0.1:${s.address().port}/boom`);
    assert.strictEqual(res.status, 500);
    assert.deepStrictEqual(await res.json(), { error: 'Internal error' });
  } finally {
    console.error = log;
    s.close();
  }
});

test('CSP directives are as intended (img-src has no data:, no unsafe-* or wildcards)', async () => {
  const csp = (await fetch(`${base}/`)).headers.get('content-security-policy');
  const d = Object.fromEntries(csp.split(';').map((s) => s.trim().split(/\s+/)).map(([k, ...v]) => [k, v.join(' ')]));
  assert.strictEqual(d['default-src'], "'self'");
  assert.strictEqual(d['script-src'], "'self'");
  assert.strictEqual(d['style-src'], "'self'");
  // https: is deliberate (feed images come from publisher CDNs); data: is not needed
  assert.strictEqual(d['img-src'], "'self' https:");
  assert.strictEqual(d['object-src'], "'none'");
  assert.strictEqual(d['base-uri'], "'self'");
  assert.strictEqual(d['frame-ancestors'], "'none'");
  assert.ok(!/unsafe-|\*/.test(csp), csp);
});

test('errorHandler defers to Express when headers were already sent', () => {
  const { errorHandler } = require('../server');
  const err = new Error('late failure');
  let passed;
  const res = { headersSent: true, status() { throw new Error('must not write a response'); } };
  errorHandler(err, {}, res, (e) => { passed = e; });
  assert.strictEqual(passed, err);
});
