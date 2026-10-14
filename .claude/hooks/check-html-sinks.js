// PostToolUse hook: after Claude edits a file under public/, check it against
// the frontend rules in CLAUDE.md (feed content is untrusted; the CSP forbids
// inline scripts, styles and handlers). Exit code 2 feeds stderr back to Claude.
//
// This is a heuristic lint, not a taint analysis: it cannot follow a value
// through a variable. It is meant to catch the common mistakes cheaply.
// Usage as a hook: reads the hook JSON on stdin.
// Usage as a CLI:  node check-html-sinks.js <file>...
const fs = require('fs');
const path = require('path');

// Calls whose result is safe to interpolate into HTML.
const SAFE_CALLS = ['escHtml', 'formatDate', 'encodeURIComponent'];
// Expressions that look like feed/server data. Extend if the frontend grows.
const TAINTED =
  /\b(article|item|entry|feed|data|resp|response|err|error)\s*[.[]|\.(title|summary|link|imageUrl|source|description|content|message|query)\b|\b(searchInput|input)\.value\b|\b(title|summary|link|description|content|message)\b/;
const SINK_ASSIGN = /\.(innerHTML|outerHTML)\s*\+?=(?!=)/g;
const SINK_CALL = /(\.insertAdjacentHTML|document\.write(?:ln)?)\s*\(/g;

// Skip a quoted string starting at i; returns the index after its closing quote.
function skipString(src, i) {
  const q = src[i];
  for (i++; i < src.length; i++) {
    if (src[i] === '\\') i++;
    else if (src[i] === q) return i + 1;
  }
  return src.length;
}

// Scan a template literal starting at the backtick at i.
// Returns { end, text, exprs } where exprs are the ${...} sources (top level only).
function scanTemplate(src, i) {
  let text = '';
  const exprs = [];
  for (i++; i < src.length; i++) {
    const c = src[i];
    if (c === '\\') { i++; continue; }
    if (c === '`') return { end: i + 1, text, exprs };
    if (c === '$' && src[i + 1] === '{') {
      let depth = 1;
      const start = i + 2;
      for (i = start; i < src.length && depth > 0; i++) {
        const d = src[i];
        if (d === '"' || d === "'") i = skipString(src, i) - 1;
        else if (d === '`') i = scanTemplate(src, i).end - 1;
        else if (d === '{') depth++;
        else if (d === '}') depth--;
      }
      exprs.push(src.slice(start, i - 1));
      i--;
    } else {
      text += c;
    }
  }
  return { end: src.length, text, exprs };
}

// Find every template literal (including nested ones) in src.
function findTemplates(src) {
  const found = [];
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === '"' || c === "'") i = skipString(src, i) - 1;
    else if (c === '/' && src[i + 1] === '/') i = (src.indexOf('\n', i) + 1 || src.length) - 1;
    else if (c === '/' && src[i + 1] === '*') i = (src.indexOf('*/', i) + 1 || src.length) - 1;
    else if (c === '`') {
      const t = scanTemplate(src, i);
      found.push(t);
      for (const e of t.exprs) found.push(...findTemplates(e));
      i = t.end - 1;
    }
  }
  return found;
}

// Remove name(...) calls with balanced parentheses.
function stripCalls(src, names) {
  const re = new RegExp(`\\b(?:${names.join('|')})\\s*\\(`, 'g');
  let m;
  while ((m = re.exec(src))) {
    let depth = 1;
    let j = m.index + m[0].length;
    for (; j < src.length && depth > 0; j++) {
      if (src[j] === '(') depth++;
      else if (src[j] === ')') depth--;
    }
    src = src.slice(0, m.index) + src.slice(j);
    re.lastIndex = m.index;
  }
  return src;
}

// Reduce an expression to the parts that can actually reach the HTML output.
function outputPart(expr) {
  let out = '';
  for (let i = 0; i < expr.length; i++) {
    const c = expr[i];
    if (c === '"' || c === "'") i = skipString(expr, i) - 1;
    else if (c === '`') i = scanTemplate(expr, i).end - 1; // nested templates are checked on their own
    else out += c;
  }
  out = stripCalls(out, SAFE_CALLS);
  const q = out.indexOf('?'); // a ternary condition is never output
  return q === -1 ? out : out.slice(q + 1);
}

function lineOf(src, index) {
  return src.slice(0, index).split('\n').length;
}

// End of the statement or call whose sink match ends at index i.
function statementEnd(src, i) {
  let depth = 0;
  for (; i < src.length; i++) {
    const c = src[i];
    if (c === '"' || c === "'") i = skipString(src, i) - 1;
    else if (c === '`') i = scanTemplate(src, i).end - 1;
    else if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c)) { if (--depth < 0) return i; }
    else if (c === ';' && depth === 0) return i;
  }
  return src.length;
}

function check(src, file) {
  const problems = [];
  const add = (index, msg) => problems.push(`${file}:${lineOf(src, index)}: ${msg}`);
  const isHtml = /\.html?$/i.test(file);

  // Templates containing HTML: every interpolation must be escaped.
  for (const t of findTemplates(src)) {
    if (!/<\/?[a-zA-Z]/.test(t.text)) continue;
    for (const e of t.exprs) {
      if (TAINTED.test(outputPart(e))) {
        add(src.indexOf(e), `"\${${e.trim().slice(0, 50)}}" is interpolated into HTML without escHtml()`);
      }
    }
  }

  // HTML sinks: the value written must be a literal or escaped.
  for (const re of [SINK_ASSIGN, SINK_CALL]) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(src))) {
      const start = m.index + m[0].length;
      const rhs = src.slice(start, statementEnd(src, start));
      const tpls = findTemplates(rhs);
      const bad =
        TAINTED.test(outputPart(rhs)) ||
        tpls.some((t) => t.exprs.some((e) => TAINTED.test(outputPart(e))));
      if (bad) add(m.index, `${m[1] || m[0].trim()} receives feed/user data without escHtml(); use textContent or escHtml()`);
    }
  }

  // CSP: no inline scripts, styles or event handlers; no javascript: URLs.
  const tag = /<[a-zA-Z][^<>]*?>/gs;
  let m;
  while ((m = tag.exec(src))) {
    if (/\son[a-z]+\s*=/i.test(m[0])) add(m.index, 'inline event handler (CSP forbids it); use addEventListener');
    if (/\sstyle\s*=/i.test(m[0])) add(m.index, 'inline style attribute (CSP forbids it); use a CSS class');
  }
  if (isHtml) {
    const script = /<script\b(?![^>]*\bsrc\s*=)[^>]*>/gi;
    while ((m = script.exec(src))) add(m.index, 'inline <script> (CSP forbids it); use a file in public/');
    const style = /<style\b/gi;
    while ((m = style.exec(src))) add(m.index, 'inline <style> (CSP forbids it); use style.css');
  }
  const jsUrl = /javascript\s*:/gi;
  while ((m = jsUrl.exec(src))) add(m.index, 'javascript: URL');
  const setStyle = /setAttribute\(\s*['"]style['"]/g;
  while ((m = setStyle.exec(src))) add(m.index, 'setAttribute("style") (CSP forbids it); use a CSS class');

  return problems;
}

module.exports = { check };

if (require.main === module) {
  const files = process.argv.slice(2);
  const projectDir = path.resolve(process.env.CLAUDE_PROJECT_DIR || process.cwd());
  const run = (list) => {
    const problems = list.flatMap((f) => check(fs.readFileSync(f, 'utf8'), path.relative(projectDir, path.resolve(f))));
    if (problems.length) {
      console.error(`Blocked by frontend rules in CLAUDE.md:\n${problems.join('\n')}`);
      process.exit(2);
    }
  };
  if (files.length) {
    run(files);
  } else {
    let input = '';
    process.stdin.on('data', (d) => (input += d));
    process.stdin.on('end', () => {
      let file;
      try { file = JSON.parse(input).tool_input.file_path; } catch { return; }
      if (!file) return;
      const rel = path.relative(projectDir, path.resolve(projectDir, file));
      if (!/^public[\\/].+\.(js|html?)$/i.test(rel) || !fs.existsSync(path.resolve(projectDir, file))) return;
      run([path.resolve(projectDir, file)]);
    });
  }
}
