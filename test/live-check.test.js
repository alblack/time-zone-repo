const test = require('node:test');
const assert = require('node:assert');

const { feedLoader, cache } = require('../server');
const { main } = require('../scripts/live-check');

// The script wraps feedLoader.parse; here that is a stub, so no test touches the network.
const original = feedLoader.parse;
test.afterEach(() => { feedLoader.parse = original; cache.flushAll(); });

const run = async (argv, stub) => {
  feedLoader.parse = stub;
  const chunks = [];
  const code = await main(argv, (s) => chunks.push(s));
  return { code, text: chunks.join('') };
};
const feedOf = (url, extra = {}) => ({
  items: [0, 1, 2].map((i) => ({ title: `${url.length}-${url.slice(-12)} #${i}`, link: `https://example.com/${i}`, contentSnippet: 'text', ...extra })),
});

test('reports success when every feed answers', async () => {
  const { code, text } = await run([], async (url) => feedOf(url));
  assert.strictEqual(code, 0);
  assert.match(text, /feeds ok: (\d+) \/ \1\b/);
  assert.match(text, /OK\s+\d+ms\s+3 items/);
  assert.doesNotMatch(text, /FAIL/);
  assert.match(text, /non-http\(s\) link\/image \(must be 0\): 0/);
});

test('--json prints one parseable JSON document and nothing else', async () => {
  const { code, text } = await run(['--json'], async (url) => feedOf(url));
  const doc = JSON.parse(text);
  assert.strictEqual(code, 0);
  assert.strictEqual(doc.feedsOk, doc.feedsTotal);
  assert.ok(doc.articles > 0);
  assert.ok(Array.isArray(doc.feeds) && doc.feeds.every((f) => f.url && typeof f.ok === 'boolean'));
  assert.deepStrictEqual(doc.violations, []);
});

test('a failing feed is listed but does not fail the run by default', async () => {
  let failed = false;
  const { code, text } = await run([], async (url) => {
    if (!failed) { failed = true; throw new Error('HTTP 503'); }
    return feedOf(url);
  });
  assert.strictEqual(code, 0);
  assert.match(text, /FAIL .*HTTP 503/);
  assert.match(text, /feeds ok: \d+ \/ \d+/);
});

test('--min-ok makes too few working feeds a failing exit code', async () => {
  const { code, text } = await run(['--min-ok=999'], async (url) => feedOf(url));
  assert.strictEqual(code, 1);
  assert.match(text, /fewer than the required 999/i);
});

test('every feed failing (e.g. a blocked network) exits 1 without crashing', async () => {
  const { code, text } = await run([], async () => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } }); });
  assert.strictEqual(code, 1);
  assert.match(text, /feeds ok: 0 \/ \d+/);
  assert.match(text, /FAIL .*fetch failed.*ECONNRESET/);
});

test('feed text is untrusted: control and escape characters never reach the terminal', async () => {
  const hostile = '\u001b[31mRED\u001b[0m\u0007 bell\r\nnewline ‮evil';
  const { text } = await run([], async (url) => ({ items: [{ title: hostile, link: 'https://example.com/a' }] }));
  assert.doesNotMatch(text, /[\u0000-\u0008\u000b-\u001f\u007f-\u009f‪-‮]/, 'only \\n may remain as a control character');
  assert.match(text, /RED/);
});

test('a reachable but empty feed is flagged, not hidden', async () => {
  let first = true;
  const { text } = await run([], async (url) => {
    if (first) { first = false; return { items: [] }; }
    return feedOf(url);
  });
  assert.match(text, /OK\s+\d+ms\s+0 items/);
  assert.match(text, /empty feeds: 1\b/);
});

test('usage: --help exits 0, unknown options exit 2, and the stub is restored afterwards', async () => {
  assert.strictEqual((await run(['--help'], async () => feedOf('x'))).code, 0);
  const bad = await run(['--bogus'], async () => feedOf('x'));
  assert.strictEqual(bad.code, 2);
  assert.match(bad.text, /usage/i);
  const stub = async (url) => feedOf(url);
  feedLoader.parse = stub;
  await main([], () => {});
  assert.strictEqual(feedLoader.parse, stub, 'main() must put feedLoader.parse back');
});
