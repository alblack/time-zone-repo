const test = require('node:test');
const assert = require('node:assert');

const { fetchFeed, getNews, cache, feedLoader, NEGATIVE_CACHE_SECONDS } = require('../server');

// Stub network access: replace the loader that fetches and parses a feed URL
const original = feedLoader.parse;
let nextFeed;
let calls = 0;
feedLoader.parse = async () => {
  calls++;
  if (nextFeed instanceof Error) throw nextFeed;
  return nextFeed;
};
test.after(() => { feedLoader.parse = original; });
const src = { name: 'Src', url: 'https://example.com/rss', category: 'General' };

test('fetchFeed strips unsafe link and image URLs and HTML from summaries', async () => {
  nextFeed = {
    items: [{
      title: 'T',
      link: 'javascript:alert(1)',
      guid: 'https://example.com/guid',
      content: '<p>Hello <script>x</script></p><img src="data:text/html,x">',
      enclosure: { url: 'javascript:alert(2)' },
    }],
  };
  const [a] = await fetchFeed(src);
  // javascript: link rejected outright (guid fallback is only used when link is absent)
  assert.strictEqual(a.link, '');
  assert.strictEqual(a.imageUrl, null);
  assert.ok(!/<[^>]+>/.test(a.summary));
});

test('fetchFeed keeps valid https links and caps items at 10', async () => {
  nextFeed = { items: Array.from({ length: 15 }, (_, i) => ({ title: `T${i}`, link: `https://example.com/${i}` })) };
  const items = await fetchFeed(src);
  assert.strictEqual(items.length, 10);
  assert.strictEqual(items[0].link, 'https://example.com/0');
});

test('fetchFeed returns [] when the feed errors', async () => {
  nextFeed = new Error('network down');
  assert.deepStrictEqual(await fetchFeed(src), []);
});

test('General category fixture matches the source list', async () => {
  cache.flushAll();
  calls = 0;
  nextFeed = { items: [{ title: 'x', link: 'https://example.com/x' }] };
  await getNews('General');
  GENERAL_SOURCES_ACTUAL = calls;
  assert.ok(calls > 1, 'expected several General sources');
});
let GENERAL_SOURCES_ACTUAL;

test('an empty result is only negatively cached for a short time, then retried', async () => {
  cache.flushAll();
  nextFeed = new Error('network down');
  assert.deepStrictEqual(await getNews('General'), []);

  // Cached briefly so an outage is not retried by every request, but far shorter than the 5-minute TTL
  const ttlMs = cache.getTtl('news_General') - Date.now();
  assert.ok(ttlMs > 0 && ttlMs <= NEGATIVE_CACHE_SECONDS * 1000, `ttl ${ttlMs}ms`);
  assert.ok(NEGATIVE_CACHE_SECONDS <= 30);

  // While negatively cached the feeds are not hit again
  calls = 0;
  assert.deepStrictEqual(await getNews('General'), []);
  assert.strictEqual(calls, 0);

  // Once the negative entry expires, the next request retries and recovers
  cache.del('news_General');
  nextFeed = { items: [{ title: 'Back online', link: 'https://example.com/ok' }] };
  const articles = await getNews('General');
  assert.strictEqual(articles.length, 1);
  assert.strictEqual(articles[0].title, 'Back online');
});

test('getNews caches non-empty results for the full TTL', async () => {
  cache.flushAll();
  nextFeed = { items: [{ title: 'Cached story', link: 'https://example.com/c' }] };
  await getNews('General');
  const ttlMs = cache.getTtl('news_General') - Date.now();
  assert.ok(ttlMs > NEGATIVE_CACHE_SECONDS * 1000);

  calls = 0;
  nextFeed = new Error('network down');
  const again = await getNews('General');
  assert.strictEqual(calls, 0);
  assert.strictEqual(again[0].title, 'Cached story');
});

test('concurrent cache misses share one fetch round', async () => {
  cache.flushAll();
  nextFeed = { items: [{ title: 'Shared', link: 'https://example.com/s' }] };
  calls = 0;
  const [a, b, c] = await Promise.all([getNews('General'), getNews('General'), getNews('General')]);
  assert.strictEqual(calls, GENERAL_SOURCES_ACTUAL, 'one fetch per source, not three');
  assert.strictEqual(a, b);
  assert.strictEqual(b, c);
});

test('concurrent misses during an outage also share one round, and later calls retry', async () => {
  cache.flushAll();
  nextFeed = new Error('network down');
  calls = 0;
  await Promise.all([getNews('General'), getNews('General')]);
  assert.strictEqual(calls, GENERAL_SOURCES_ACTUAL);

  cache.flushAll();
  calls = 0;
  await getNews('General'); // in-flight entry was cleaned up, so this runs a new round
  assert.strictEqual(calls, GENERAL_SOURCES_ACTUAL);
});

test('different categories are fetched independently', async () => {
  cache.flushAll();
  nextFeed = { items: [{ title: 'Cat', link: 'https://example.com/cat' }] };
  calls = 0;
  await Promise.all([getNews('General'), getNews('Technology')]);
  assert.ok(calls > GENERAL_SOURCES_ACTUAL);
});

test('a malformed media:content / media:thumbnail does not drop the feed', async () => {
  nextFeed = {
    items: [
      { title: 'No attrs', link: 'https://example.com/1', 'media:content': {} },
      { title: 'Empty attrs', link: 'https://example.com/2', 'media:content': { $: {} } },
      { title: 'Thumb no attrs', link: 'https://example.com/3', 'media:thumbnail': {} },
      { title: 'Null media', link: 'https://example.com/4', 'media:content': null },
      { title: 'Good media', link: 'https://example.com/5', 'media:content': { $: { url: 'https://example.com/i.jpg' } } },
      { title: 'Bad scheme', link: 'https://example.com/6', 'media:content': { $: { url: 'javascript:alert(1)' } } },
    ],
  };
  const items = await fetchFeed(src);
  assert.strictEqual(items.length, 6, 'one bad item must not drop the others');
  const img = Object.fromEntries(items.map((i) => [i.title, i.imageUrl]));
  assert.strictEqual(img['No attrs'], null);
  assert.strictEqual(img['Empty attrs'], null);
  assert.strictEqual(img['Thumb no attrs'], null);
  assert.strictEqual(img['Null media'], null);
  assert.strictEqual(img['Good media'], 'https://example.com/i.jpg');
  assert.strictEqual(img['Bad scheme'], null);
});
