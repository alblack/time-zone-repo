const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const zlib = require('node:zlib');

// Small cap so the tests stay fast; read once when server.js loads.
process.env.FEED_MAX_BYTES = '2000';
process.env.FEED_TIMEOUT_MS = '300'; // short, so the slow-drip test is fast
const { feedLoader, FEED_MAX_BYTES } = require('../server');

const rss = (title, pad = '') =>
  `<?xml version="1.0"?><rss version="2.0"><channel><title>t</title><item><title>${title}</title><link>https://example.com/a</link><description>${pad}</description></item></channel></rss>`;

let server, base, aborted;
test.before(async () => {
  server = http.createServer((req, res) => {
    if (req.url === '/ok') {
      res.setHeader('content-type', 'application/rss+xml');
      return res.end(rss('Hello'));
    }
    if (req.url === '/latin1') {
      res.setHeader('content-type', 'application/rss+xml; charset=iso-8859-1');
      return res.end(Buffer.from(rss('Café'), 'latin1'));
    }
    if (req.url === '/big-declared') {
      res.setHeader('content-length', String(FEED_MAX_BYTES * 50));
      return res.end(rss('x', 'a'.repeat(FEED_MAX_BYTES * 50)));
    }
    if (req.url === '/big-chunked') {
      // No content-length: stream until the client gives up
      res.write(rss('x', ''.padEnd(100)).slice(0, 200));
      const timer = setInterval(() => res.write('a'.repeat(500)), 5);
      res.on('close', () => { clearInterval(timer); aborted = true; });
      return;
    }
    if (req.url === '/gzip-bomb') {
      // Tiny on the wire, huge once decompressed
      const body = zlib.gzipSync(Buffer.from(rss('x', 'a'.repeat(FEED_MAX_BYTES * 100))));
      assert.ok(body.length < FEED_MAX_BYTES, 'fixture must be under the cap compressed');
      res.setHeader('content-encoding', 'gzip');
      res.setHeader('content-type', 'application/rss+xml');
      return res.end(body);
    }
    if (req.url === '/gzip-ok') {
      res.setHeader('content-encoding', 'gzip');
      res.setHeader('content-type', 'application/rss+xml');
      return res.end(zlib.gzipSync(Buffer.from(rss('Zipped'))));
    }
    if (req.url === '/slow') {
      // Headers and a first chunk arrive in time, then the body drips forever
      res.setHeader('content-type', 'application/rss+xml');
      res.write('<?xml version="1.0"?><rss><channel>');
      const t = setInterval(() => res.write(' '), 50);
      res.on('close', () => clearInterval(t));
      return;
    }
    if (req.url === '/redirect-same') { res.statusCode = 302; res.setHeader('location', '/ok'); return res.end(); }
    if (req.url === '/redirect-loop') { res.statusCode = 302; res.setHeader('location', '/redirect-loop'); return res.end(); }
    if (req.url.startsWith('/redirect-to/')) {
      res.statusCode = 302;
      res.setHeader('location', decodeURIComponent(req.url.slice('/redirect-to/'.length)));
      return res.end();
    }
    if (req.url === '/exact') {
      const base = rss('Exact', '');
      return res.end(rss('Exact', 'b'.repeat(FEED_MAX_BYTES - base.length)));
    }
    res.statusCode = 500;
    res.end('boom');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server.close());

test('the size cap comes from FEED_MAX_BYTES', () => {
  assert.strictEqual(FEED_MAX_BYTES, 2000);
});

test('parses a normal feed', async () => {
  const feed = await feedLoader.parse(`${base}/ok`);
  assert.strictEqual(feed.items[0].title, 'Hello');
});

test('honours the response charset', async () => {
  const feed = await feedLoader.parse(`${base}/latin1`);
  assert.strictEqual(feed.items[0].title, 'Café');
});

test('accepts a body exactly at the cap', async () => {
  const feed = await feedLoader.parse(`${base}/exact`);
  assert.strictEqual(feed.items[0].title, 'Exact');
});

test('rejects a response whose declared length exceeds the cap', async () => {
  await assert.rejects(feedLoader.parse(`${base}/big-declared`), /too large/i);
});

test('aborts an unbounded stream once the cap is exceeded', async () => {
  aborted = false;
  await assert.rejects(feedLoader.parse(`${base}/big-chunked`), /too large/i);
  await new Promise((r) => setTimeout(r, 100));
  assert.ok(aborted, 'server should see the client connection close');
});

test('rejects non-2xx responses', async () => {
  await assert.rejects(feedLoader.parse(`${base}/missing`), /HTTP 500/);
});

test('the cap applies after decompression (gzip bomb)', async () => {
  await assert.rejects(feedLoader.parse(`${base}/gzip-bomb`), /too large/i);
});

test('still reads a normal gzip-compressed feed', async () => {
  const feed = await feedLoader.parse(`${base}/gzip-ok`);
  assert.strictEqual(feed.items[0].title, 'Zipped');
});

test('a body that drips slowly is cut off by the timeout', async () => {
  const started = Date.now();
  await assert.rejects(feedLoader.parse(`${base}/slow`));
  assert.ok(Date.now() - started < 3000, 'must abort near FEED_TIMEOUT_MS, not hang');
});

test('same-origin redirects are followed', async () => {
  const feed = await feedLoader.parse(`${base}/redirect-same`);
  assert.strictEqual(feed.items[0].title, 'Hello');
});

test('a redirect loop is stopped', async () => {
  await assert.rejects(feedLoader.parse(`${base}/redirect-loop`), /redirect/i);
});

test('redirects to internal or non-http targets are refused without being requested', async () => {
  const port = server.address().port;
  const targets = [
    'http://169.254.169.254/latest/meta-data/', // cloud metadata
    'http://10.0.0.5/feed', 'http://192.168.1.1/', 'http://172.16.0.9/', 'http://127.0.0.2/',
    'http://[::1]/', 'http://[fd00::1]/', 'http://[fe80::1]/', 'http://[::ffff:127.0.0.1]/',
    `http://localhost:${port}/ok`, 'http://LOCALHOST/ok', 'http://foo.localhost/ok',
    'http://0.0.0.0/', 'http://2130706433/', // decimal form of 127.0.0.1
    'file:///etc/passwd', 'ftp://example.com/feed',
  ];
  for (const t of targets) {
    await assert.rejects(feedLoader.parse(`${base}/redirect-to/${encodeURIComponent(t)}`), /redirect/i, t);
  }
});
