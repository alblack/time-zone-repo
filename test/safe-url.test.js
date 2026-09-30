const test = require('node:test');
const assert = require('node:assert');
const { safeUrl } = require('../public/safe-url.js');

test('allows http and https URLs', () => {
  assert.strictEqual(safeUrl('https://example.com/a?b=1'), 'https://example.com/a?b=1');
  assert.strictEqual(safeUrl('http://example.com'), 'http://example.com/');
});

test('rejects dangerous or malformed URLs', () => {
  for (const bad of ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'data:text/html,hi',
    'vbscript:x', '//evil.com', 'not a url', '', null, undefined]) {
    assert.strictEqual(safeUrl(bad), null, String(bad));
  }
});
