const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Run public/app.js against a minimal fake DOM, feed it hostile articles, and inspect what it renders.
const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');

function makeEl() {
  const el = {
    className: '', href: '', target: '', rel: '', textContent: '', value: '', dataset: {}, children: [], _html: '',
    classList: { add() {}, remove() {}, toggle() {} },
    addEventListener() {},
    appendChild(c) { el.children.push(c); return c; },
    querySelector() { return null; },
    get innerHTML() { return el._html; },
    set innerHTML(v) { el._html = v; if (v === '') el.children = []; },
  };
  return el;
}

async function render(apiResponse) {
  const byId = new Map();
  const document = {
    getElementById(id) { if (!byId.has(id)) byId.set(id, makeEl()); return byId.get(id); },
    querySelectorAll() { return []; },
    createElement() { return makeEl(); },
    createDocumentFragment() { return makeEl(); },
  };
  const sandbox = {
    document, console, URLSearchParams, Date, setTimeout, clearTimeout,
    setInterval() { return 0; }, // no auto-refresh timer keeping the process alive
    fetch: async () => apiResponse,
  };
  vm.runInNewContext(source, sandbox);
  await new Promise((r) => setImmediate(r));
  const grid = byId.get('news-grid');
  const cards = grid.children.flatMap((c) => c.children);
  return { cards, byId };
}

const ok = (articles) => ({ ok: true, json: async () => ({ articles, pages: 1 }) });
const hostile = {
  title: '<img src=x onerror=alert(1)>', summary: '<script>alert(1)</script>', source: '"><b>src</b>',
  category: 'Tech<', link: 'javascript:alert(1)', imageUrl: 'javascript:alert(2)', pubDate: '2026-01-01T00:00:00Z',
};

test('feed text is escaped: no raw tags, quotes or handlers reach innerHTML', async () => {
  const { cards } = await render(ok([hostile]));
  assert.strictEqual(cards.length, 1);
  const html = cards[0].innerHTML;
  assert.ok(!html.includes('<script'), html);
  assert.ok(!html.includes('<img src=x'), html);
  assert.ok(!html.includes('"><b>'), html);
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'), html);
  assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'), html);
});

test('non-http(s) link and image URLs are neutralised', async () => {
  const { cards } = await render(ok([hostile, { ...hostile, link: 'data:text/html,x', imageUrl: 'data:image/png;base64,AAAA' }]));
  for (const c of cards) {
    assert.strictEqual(c.href, '#');
    assert.ok(!/javascript:|data:/i.test(c.innerHTML), c.innerHTML);
    assert.ok(!c.innerHTML.includes('<img'), 'no <img> for a bad image URL');
    assert.ok(c.innerHTML.includes('card-image-placeholder'));
  }
});

test('valid https links are kept, and links open safely', async () => {
  const { cards } = await render(ok([{ ...hostile, title: 'ok', link: 'https://example.com/a?b=1', imageUrl: 'https://example.com/i.png' }]));
  assert.strictEqual(cards[0].href, 'https://example.com/a?b=1');
  assert.strictEqual(cards[0].target, '_blank');
  assert.strictEqual(cards[0].rel, 'noopener noreferrer');
  assert.ok(cards[0].innerHTML.includes('<img class="card-image" src="https://example.com/i.png"'));
});

test('an image URL cannot break out of the src attribute', async () => {
  const { cards } = await render(ok([{ ...hostile, imageUrl: 'https://example.com/a.png" onerror="alert(1)' }]));
  const html = cards[0].innerHTML;
  assert.ok(!html.includes('" onerror="'), html);
  assert.ok(html.includes('&quot; onerror=&quot;'), html);
});

test('API errors are shown via textContent, never as HTML', async () => {
  const { byId } = await render({ ok: false, status: 500, json: async () => ({}) });
  const err = byId.get('error-msg');
  assert.ok(err.textContent.includes('HTTP 500'));
  assert.strictEqual(err.innerHTML, '', 'error text must not go through innerHTML');
});
