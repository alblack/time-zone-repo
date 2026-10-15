#!/usr/bin/env node
// Live check: run the app's real getNews() against the real feeds and report how each one behaves.
//
//   npm run live-check                  human-readable report
//   npm run live-check -- --json        one JSON document (for scripts)
//   npm run live-check -- --min-ok=20   exit 1 if fewer than 20 feeds answer (default 1)
//
// Exit codes: 0 ok, 1 too few feeds answered or a contract violation, 2 bad usage.
//
// This is deliberately NOT part of `npm test`: it depends on the network and on the publishers,
// so it would be flaky. Run it by hand after changing how feeds are fetched or parsed.
// Behind an HTTPS proxy, Node's built-in fetch needs: NODE_USE_ENV_PROXY=1 (Node >= 22.21), and
// NODE_EXTRA_CA_CERTS=<proxy CA bundle> if the proxy re-signs TLS. Never disable TLS verification.
//
// Feed content is untrusted, so everything printed is stripped of control characters first.
const { feedLoader, getNews, cache } = require('../server');

const USAGE = 'usage: npm run live-check -- [--json] [--min-ok=N] [--help]';

// Control characters, C1 controls, and bidi overrides could drive or spoof a terminal.
const clean = (s, max = 80) => String(s ?? '').replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g, ' ').slice(0, max);
const isHttp = (u) => /^https?:\/\//i.test(String(u ?? ''));

async function main(argv = process.argv.slice(2), out = (s) => process.stdout.write(s)) {
  let json = false;
  let minOk = 1;
  for (const arg of argv) {
    if (arg === '--json') json = true;
    else if (/^--min-ok=\d+$/.test(arg)) minOk = Number(arg.split('=')[1]);
    else if (arg === '--help') { out(`${USAGE}\n`); return 0; }
    else { out(`unknown option: ${clean(arg)}\n${USAGE}\n`); return 2; }
  }

  const real = feedLoader.parse;
  const feeds = [];
  feedLoader.parse = async (url) => {
    const started = Date.now();
    try {
      const feed = await real(url);
      feeds.push({ url, ok: true, ms: Date.now() - started, items: (feed.items || []).length });
      return feed;
    } catch (e) {
      const cause = e && e.cause && (e.cause.code || e.cause.message);
      feeds.push({ url, ok: false, ms: Date.now() - started, error: clean(`${e && e.message}${cause ? ` (${cause})` : ''}`, 140) });
      throw e;
    }
  };

  const started = Date.now();
  let articles;
  try {
    cache.flushAll(); // force a real fetch
    articles = await getNews('all');
  } catch (e) {
    out(`getNews failed: ${clean(e && e.message, 200)}\n`);
    return 1;
  } finally {
    feedLoader.parse = real;
    cache.flushAll();
    cache.close(); // stop the cache's timer so the process can exit
  }
  const ms = Date.now() - started;

  const byCategory = {};
  for (const a of articles) byCategory[a.category] = (byCategory[a.category] || 0) + 1;
  const violations = articles
    .filter((a) => !isHttp(a.link) || (a.imageUrl && !isHttp(a.imageUrl)))
    .map((a) => clean(a.title, 60));
  const feedsOk = feeds.filter((f) => f.ok).length;
  const empty = feeds.filter((f) => f.ok && f.items === 0).length;
  const tooFew = feedsOk < minOk;
  const report = {
    feedsTotal: feeds.length, feedsOk, emptyFeeds: empty, articles: articles.length, ms, byCategory,
    withImage: articles.filter((a) => a.imageUrl).length, violations, feeds: feeds.sort((a, b) => a.ok - b.ok || a.url.localeCompare(b.url)),
  };

  if (json) {
    out(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    out(`getNews('all'): ${report.articles} unique articles in ${ms} ms\n`);
    out(`by category: ${JSON.stringify(byCategory)}\n`);
    out(`feeds ok: ${feedsOk} / ${feeds.length}\n`);
    out(`empty feeds: ${empty}\n`);
    for (const f of report.feeds) {
      out(f.ok
        ? `OK   ${String(f.ms).padStart(5)}ms ${String(f.items).padStart(3)} items  ${clean(f.url, 100)}\n`
        : `FAIL ${String(f.ms).padStart(5)}ms ${f.error}  ${clean(f.url, 100)}\n`);
    }
    out(`articles with an image: ${report.withImage}/${report.articles}\n`);
    out(`articles with a non-http(s) link/image (must be 0): ${violations.length}\n`);
    for (const a of articles.slice(0, 2)) out(`sample: [${clean(a.category, 20)}] ${clean(a.source, 30)}: ${clean(a.title, 70)} <${clean(a.link, 90)}>\n`);
    if (tooFew) out(`FAILED: ${feedsOk} feeds answered, fewer than the required ${minOk}\n`);
  }
  return tooFew || violations.length ? 1 : 0;
}

module.exports = { main };

if (require.main === module) {
  main().then((code) => { process.exitCode = code; });
}
