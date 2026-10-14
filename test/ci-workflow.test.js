const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const dir = path.join(__dirname, '..', '.github', 'workflows');
const files = fs.readdirSync(dir).filter((f) => /\.ya?ml$/.test(f));

test('there is at least one workflow to check', () => {
  assert.ok(files.length > 0);
});

test('every third-party action is pinned to a full commit SHA', () => {
  for (const f of files) {
    const text = fs.readFileSync(path.join(dir, f), 'utf8');
    for (const m of text.matchAll(/^\s*-?\s*uses:\s*([^\s#]+)/gm)) {
      const ref = m[1];
      if (ref.startsWith('./')) continue; // local action
      assert.match(ref, /^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/, `${f}: "${ref}" must be pinned to a 40-char commit SHA`);
    }
  }
});

test('workflows keep least-privilege token permissions', () => {
  for (const f of files) {
    const text = fs.readFileSync(path.join(dir, f), 'utf8');
    assert.match(text, /^permissions:\s*\n\s+contents:\s*read\s*$/m, `${f}: top-level permissions must be contents: read`);
  }
});

test('the dependency audit also runs on a schedule', () => {
  const ci = fs.readFileSync(path.join(dir, 'ci.yml'), 'utf8');
  assert.match(ci, /schedule:\s*\n\s*-\s*cron:/, 'ci.yml needs a scheduled run so new advisories surface between commits');
  assert.match(ci, /npm run audit/);
});
