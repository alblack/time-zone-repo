const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const HOOK = path.join(__dirname, '..', '.claude', 'hooks', 'check-html-sinks.js');
const { check } = require(HOOK);
const flagged = (src, file = 'public/app.js') => check(src, file).length > 0;

test('current frontend passes the guard', () => {
  for (const f of ['app.js', 'index.html']) {
    const file = path.join(__dirname, '..', 'public', f);
    assert.deepStrictEqual(check(fs.readFileSync(file, 'utf8'), f), []);
  }
});

test('flags unescaped feed data in HTML templates', () => {
  assert.ok(flagged('el.innerHTML = `<h3>${article.title}</h3>`;'));
  assert.ok(flagged('const h = `<a href="${a.link}">x</a>`;'));
  assert.ok(flagged('el.innerHTML = `${article.summary}`;'));
});

test('flags unescaped data written to HTML sinks', () => {
  assert.ok(flagged('el.innerHTML = article.summary;'));
  assert.ok(flagged("el.innerHTML += '<b>' + article.title + '</b>';"));
  assert.ok(flagged("el.insertAdjacentHTML('beforeend', `<i>${item.title}</i>`);"));
  assert.ok(flagged('document.write(data.html);'));
});

test('allows escaped data, literals and non-HTML output', () => {
  assert.ok(!flagged('el.innerHTML = `<h3>${escHtml(article.title)}</h3>`;'));
  assert.ok(!flagged("el.innerHTML = '';"));
  assert.ok(!flagged("el.innerHTML = '<p>None</p>';"));
  assert.ok(!flagged('el.innerHTML = `<i>${formatDate(article.pubDate)}</i>`;'));
  assert.ok(!flagged('el.textContent = `Failed: ${err.message}`;'));
  // a ternary condition is not output; only the branches are
  assert.ok(!flagged('el.innerHTML = `${article.summary ? `<p>${escHtml(article.summary)}</p>` : ""}`;'));
  assert.ok(flagged('el.innerHTML = `${ok ? `<p>${article.summary}</p>` : ""}`;'));
});

test('flags CSP violations', () => {
  assert.ok(flagged('el.innerHTML = \'<button onclick="go()">x</button>\';'));
  assert.ok(flagged('const h = `<div style="color:red"></div>`;'));
  assert.ok(flagged('el.setAttribute("style", "color:red");'));
  assert.ok(flagged('el.href = "javascript:alert(1)";'));
  assert.ok(flagged('<script>alert(1)</script>', 'public/index.html'));
  assert.ok(flagged('<style>a{}</style>', 'public/index.html'));
  assert.ok(flagged('<a onclick="x()">', 'public/index.html'));
  assert.ok(!flagged('<script src="app.js"></script>', 'public/index.html'));
});

test('hook blocks (exit 2) bad edits under public/ and ignores other files', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sinks-'));
  fs.mkdirSync(path.join(dir, 'public'));
  const bad = path.join(dir, 'public', 'x.js');
  fs.writeFileSync(bad, 'el.innerHTML = `<b>${article.title}</b>`;');
  const other = path.join(dir, 'server.js');
  fs.writeFileSync(other, 'el.innerHTML = `<b>${article.title}</b>`;');
  const run = (file) =>
    spawnSync('node', [HOOK], {
      input: JSON.stringify({ tool_input: { file_path: file } }),
      env: { ...process.env, CLAUDE_PROJECT_DIR: dir },
      encoding: 'utf8',
    });
  const blocked = run(bad);
  assert.strictEqual(blocked.status, 2);
  assert.match(blocked.stderr, /escHtml/);
  assert.strictEqual(run(other).status, 0);
  assert.strictEqual(spawnSync('node', [HOOK], { input: 'not json', encoding: 'utf8' }).status, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});
