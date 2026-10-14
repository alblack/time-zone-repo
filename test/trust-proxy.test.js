const test = require('node:test');
const assert = require('node:assert');

// Must be set before server.js loads: the integration tests below run behind "one trusted proxy".
process.env.TRUST_PROXY = '1';
const { app, parseTrustProxy } = require('../server');

test('parseTrustProxy: unset or empty leaves Express at its default (no proxy trusted)', () => {
  assert.strictEqual(parseTrustProxy(undefined), undefined);
  assert.strictEqual(parseTrustProxy(''), undefined);
  assert.strictEqual(parseTrustProxy('   '), undefined);
});

test('parseTrustProxy: a hop count of 1-10', () => {
  assert.strictEqual(parseTrustProxy('1'), 1);
  assert.strictEqual(parseTrustProxy(' 2 '), 2);
  assert.strictEqual(parseTrustProxy('10'), 10);
});

test('parseTrustProxy: named ranges, IPs and CIDRs, comma separated', () => {
  assert.strictEqual(parseTrustProxy('loopback'), 'loopback');
  assert.strictEqual(parseTrustProxy('loopback, uniquelocal'), 'loopback, uniquelocal');
  assert.strictEqual(parseTrustProxy('10.0.0.0/8,192.168.1.5'), '10.0.0.0/8,192.168.1.5');
  assert.strictEqual(parseTrustProxy('::1, fc00::/7'), '::1, fc00::/7');
});

test('parseTrustProxy: rejects permissive or malformed values instead of guessing', () => {
  for (const bad of ['true', 'false', '*', 'all', '0', '11', '-1', '1.5', 'yes', 'proxy.example.com', '1;2', '10.0.0.0/8; drop', '0.0.0.0/0']) {
    assert.throws(() => parseTrustProxy(bad), /TRUST_PROXY/, bad);
  }
});

test('parseTrustProxy: rejects CIDRs wide enough to trust large parts of the internet', () => {
  for (const bad of ['0.0.0.0/1', '128.0.0.0/1', '0.0.0.0/7', '8.0.0.0/7', '::/1', '::/6', '2000::/3', '::ffff:0.0.0.0/1', '::ffff:0.0.0.0/96', '::ffff:0.0.0.0/103']) {
    assert.throws(() => parseTrustProxy(bad), /TRUST_PROXY/, bad);
  }
});

test('parseTrustProxy: still accepts the standard private blocks and single hosts', () => {
  for (const ok of ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '127.0.0.1', '203.0.113.7/32', 'fc00::/7', 'fe80::/10', '::1', '::ffff:10.0.0.0/104']) {
    assert.strictEqual(parseTrustProxy(ok), ok, ok);
  }
});

let server, base;
test.before(async () => { await new Promise((r) => { server = app.listen(0, r); }); base = `http://127.0.0.1:${server.address().port}`; });
test.after(() => server.close());

const hit = (xff) => fetch(`${base}/api/categories`, { headers: { 'x-forwarded-for': xff } });

test('behind one trusted proxy, each client IP gets its own rate-limit bucket', async () => {
  for (let i = 0; i < 60; i++) assert.strictEqual((await hit('198.51.100.1')).status, 200, `request ${i + 1}`);
  assert.strictEqual((await hit('198.51.100.1')).status, 429, 'client A is limited');
  assert.strictEqual((await hit('198.51.100.2')).status, 200, 'client B is not affected by client A');
});

test('a client cannot dodge its bucket by prefixing a fake X-Forwarded-For entry', async () => {
  // The trusted proxy appends the real client IP on the right; anything the client sent stays on the left.
  assert.strictEqual((await hit('6.6.6.6, 198.51.100.1')).status, 429, 'still client A');
  assert.strictEqual((await hit('7.7.7.7, 198.51.100.1')).status, 429, 'still client A');
});
