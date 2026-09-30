const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { app, parser, cache, CATEGORIES } = require('../server.js');

let server;
let base;
let calls;
const realParse = parser.parseURL.bind(parser);

function mockFeeds(impl) {
  calls = 0;
  parser.parseURL = async (url) => { calls++; return impl(url); };
}

test.before(async () => {
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => {
  parser.parseURL = realParse;
  server.close();
});

test.beforeEach(() => cache.flushAll());

const get = async (path) => {
  const res = await fetch(base + path);
  return { status: res.status, body: await res.json() };
};

const okFeed = (url) => ({
  items: [{ title: `Story from ${url}`, link: 'https://example.com/a', pubDate: new Date().toISOString() }],
});

test('/api/categories returns known categories', async () => {
  const { body } = await get('/api/categories');
  assert.deepStrictEqual(body, CATEGORIES);
});

test('unknown categories return empty without fetching or caching', async () => {
  mockFeeds(okFeed);
  for (const q of ['zzz', 'Sports', 'Science%00']) {
    const { status, body } = await get(`/api/news?category=${q}`);
    assert.strictEqual(status, 200);
    assert.deepStrictEqual(body.articles, []);
  }
  assert.strictEqual(calls, 0);
  assert.strictEqual(cache.keys().length, 0);
});

test('non-string category values fall back to "all" and share one cache key', async () => {
  mockFeeds(okFeed);
  await get('/api/news?category=a&category=b');
  await get('/api/news?category[x]=y');
  assert.deepStrictEqual(cache.keys(), ['news_all']);
});

test('known category fetches and caches results', async () => {
  mockFeeds(okFeed);
  const first = await get('/api/news?category=Science');
  assert.ok(first.body.articles.length > 0);
  const callsAfterFirst = calls;
  await get('/api/news?category=Science');
  assert.strictEqual(calls, callsAfterFirst, 'second request served from cache');
});

test('empty results are not cached, so recovery is immediate', async () => {
  mockFeeds(() => { throw new Error('network down'); });
  const down = await get('/api/news?category=Science');
  assert.strictEqual(down.body.total, 0);
  assert.strictEqual(cache.keys().length, 0);

  mockFeeds(okFeed);
  const up = await get('/api/news?category=Science');
  assert.ok(up.body.total > 0);
});
