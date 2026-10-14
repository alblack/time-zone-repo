const test = require('node:test');
const assert = require('node:assert');
const { app, feedLoader, cache } = require('../server');

// Stub the network: every feed returns 12 uniquely titled items (fetchFeed keeps 10 per feed).
const original = feedLoader.parse;
feedLoader.parse = async (url) => ({
  items: Array.from({ length: 12 }, (_, i) => ({ title: `${require('node:crypto').createHash('sha1').update(url).digest('hex').slice(0, 10)} #${i}`, link: `https://example.com/${i}`, contentSnippet: 'text' })),
});

let server, base;
test.before(async () => { await new Promise((r) => { server = app.listen(0, r); }); base = `http://127.0.0.1:${server.address().port}`; });
test.after(() => { feedLoader.parse = original; server.close(); });

const get = async (p) => { const r = await fetch(`${base}${p}`); return { status: r.status, body: await r.json() }; };

test('/api/news returns a page with the documented shape', async () => {
  const { status, body } = await get('/api/news?limit=5&page=1');
  assert.strictEqual(status, 200);
  assert.strictEqual(body.articles.length, 5);
  assert.strictEqual(body.page, 1);
  assert.ok(body.total > 5);
  assert.strictEqual(body.pages, Math.ceil(body.total / 5));
  assert.deepStrictEqual(Object.keys(body.articles[0]).sort(), ['category', 'imageUrl', 'link', 'pubDate', 'source', 'summary', 'title']);
});

test('pagination: pages do not overlap, the last page is partial, past the end is empty', async () => {
  const p1 = (await get('/api/news?limit=7&page=1')).body;
  const p2 = (await get('/api/news?limit=7&page=2')).body;
  const titles1 = new Set(p1.articles.map((a) => a.title));
  assert.ok(p2.articles.every((a) => !titles1.has(a.title)), 'page 2 repeats page 1');
  const last = (await get(`/api/news?limit=7&page=${p1.pages}`)).body;
  assert.strictEqual(last.articles.length, p1.total - 7 * (p1.pages - 1));
  const beyond = await get(`/api/news?limit=7&page=${p1.pages + 1}`);
  assert.strictEqual(beyond.status, 200);
  assert.deepStrictEqual(beyond.body.articles, []);
});

test('limit is capped at 50 and defaults to 20', async () => {
  assert.strictEqual((await get('/api/news?limit=50')).body.articles.length, 50);
  assert.strictEqual((await get('/api/news?limit=51')).status, 400);
  assert.strictEqual((await get('/api/news')).body.articles.length, 20);
});

test('category filter only returns that category', async () => {
  const { body } = await get('/api/news?category=Technology&limit=50');
  assert.ok(body.articles.length > 0);
  assert.ok(body.articles.every((a) => a.category === 'Technology'));
  const cats = (await get('/api/categories')).body;
  assert.ok(cats.includes('Technology'));
});

test('articles never expose feed URLs or internals', async () => {
  const text = JSON.stringify((await get('/api/news?limit=50')).body);
  assert.ok(!/feeds\.|rss|\.xml/i.test(text.replace(/example\.com/g, '')), 'feed URL leaked');
});

test('a failure inside the route returns a generic 500 with no internal detail', async () => {
  cache.flushAll();
  const realSet = cache.set;
  const log = console.error;
  console.error = () => {};
  cache.set = () => { throw new Error('secret internal detail /home/x/server.js:42'); };
  try {
    const res = await fetch(`${base}/api/news?category=General`);
    const text = await res.text();
    assert.strictEqual(res.status, 500);
    assert.deepStrictEqual(JSON.parse(text), { error: 'Failed to fetch news' });
    assert.ok(!text.includes('secret') && !text.includes('/home/'));
  } finally {
    cache.set = realSet;
    console.error = log;
  }
});
