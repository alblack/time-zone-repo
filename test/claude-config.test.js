const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.join(__dirname, '..');
const settings = JSON.parse(fs.readFileSync(path.join(root, '.claude', 'settings.json'), 'utf8'));
const hookCommands = (event) => (settings.hooks[event] || []).flatMap((g) => g.hooks.map((h) => ({ matcher: g.matcher, command: h.command })));

test('every project hook script is referenced through $CLAUDE_PROJECT_DIR (works from any cwd)', () => {
  for (const event of Object.keys(settings.hooks)) {
    for (const { command } of hookCommands(event)) {
      if (command.includes('.claude/hooks/')) {
        assert.match(command, /\$CLAUDE_PROJECT_DIR/, `${event}: "${command}" must not use a relative path`);
      }
    }
  }
});

test('edit-time hooks cover every file-writing tool, not just Write and Edit', () => {
  for (const event of ['PreToolUse', 'PostToolUse']) {
    for (const group of settings.hooks[event]) {
      const tools = group.matcher.split('|');
      for (const t of ['Write', 'Edit', 'MultiEdit', 'NotebookEdit']) assert.ok(tools.includes(t), `${event} matcher is missing ${t}`);
    }
  }
});

test('the secret-blocking hook still blocks when run as configured from another directory', () => {
  const [{ command }] = hookCommands('PreToolUse').filter((h) => h.command.includes('block-secrets'));
  const fakeKey = 'ghp_' + 'a'.repeat(36); // built at runtime so this file does not itself look like a secret
  const run = (content) => spawnSync('sh', ['-c', command], {
    cwd: require('node:os').tmpdir(),
    env: { ...process.env, CLAUDE_PROJECT_DIR: root },
    input: JSON.stringify({ tool_input: { content } }),
    encoding: 'utf8',
  });
  assert.strictEqual(run(`token = "${fakeKey}"`).status, 2);
  assert.strictEqual(run('nothing to see').status, 0);
});

test('baseline deny rules are intact', () => {
  const required = [
    'Read(./.env)', 'Read(./.env.*)', 'Read(**/*.pem)', 'Read(**/*.key)', 'Edit(./.env*)',
    'Bash(curl*)', 'Bash(wget*)', 'Bash(rm -rf*)', 'Bash(git push --force*)', 'Bash(git push -f*)', 'Bash(git reset --hard*)',
    'Bash(cat .env*)', 'Bash(cat ./.env*)',
  ];
  for (const rule of required) assert.ok(settings.permissions.deny.includes(rule), `deny is missing ${rule}`);
});

test('the allow list is exactly the reviewed set (any addition must be a deliberate change here)', () => {
  assert.deepStrictEqual([...settings.permissions.allow].sort(), [
    'Bash(git diff origin/main...HEAD)', 'Bash(git diff --staged)', 'Bash(git diff)', 'Bash(git log*)',
    'Bash(git status*)', 'Bash(npm audit)', 'Bash(npm ls*)', 'Bash(npm run audit)', 'Bash(npm test)',
  ].sort());
});

test('allow rules stay narrow: no wildcard that can write files or modify dependencies', () => {
  const readOnlyGlobs = new Set(['Bash(npm ls*)', 'Bash(git status*)', 'Bash(git log*)']);
  for (const rule of settings.permissions.allow) {
    if (rule.includes('*')) assert.ok(readOnlyGlobs.has(rule), `"${rule}" is a broad glob; allow the exact command instead`);
  }
});

test('the secret blocker recognises more token formats', () => {
  const hook = path.join(root, '.claude', 'hooks', 'block-secrets.js');
  const run = (content) => spawnSync('node', [hook], { input: JSON.stringify({ tool_input: { content } }), encoding: 'utf8' });
  // Built at runtime so this file does not itself look like a secret
  const samples = {
    'fine-grained GitHub token': 'github_' + 'pat_' + 'A1b2C3d4E5f6G7h8I9j0K1_' + 'x'.repeat(20),
    'Slack token': 'xo' + 'xb-' + '1234567890-' + 'abcdefghij',
    'Google API key': 'AI' + 'za' + 'Sy' + 'A'.repeat(33),
    'Stripe live key': 'sk_' + 'live_' + 'a1B2c3D4e5F6g7H8i9J0k1L2',
  };
  for (const [name, value] of Object.entries(samples)) assert.strictEqual(run(`token = "${value}"`).status, 2, name);
  assert.strictEqual(run('const github = "pat"; const slack = "xoxo"; const sk = "sk_test"').status, 0, 'near-misses are allowed');
});
