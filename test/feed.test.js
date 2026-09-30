const test = require('node:test');
const assert = require('node:assert');
const Parser = require('rss-parser');

// Stub network access before the server module creates its parser usage
const original = Parser.prototype.parseURL;
let nextFeed;
Parser.prototype.parseURL = async () => {
  if (nextFeed instanceof Error) throw nextFeed;
  return nextFeed;
};
test.after(() => { Parser.prototype.parseURL = original; });

const { fetchFeed } = require('../server');
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
