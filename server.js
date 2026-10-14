const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const Parser = require('rss-parser');
const NodeCache = require('node-cache');
const path = require('path');
const net = require('net');

// TRUST_PROXY: how many reverse proxies sit in front of this app, so req.ip (and therefore the per-IP
// rate limit) is the real client and not the proxy. Unset = trust none (Express default). Accepts a hop
// count (1-10) or a comma-separated list of loopback/linklocal/uniquelocal, IPs and CIDRs. Never `true`:
// that would let any client choose its own IP through X-Forwarded-For, and so would a very wide CIDR.
// The hop count must equal the real number of proxies. Invalid values fail at startup.
function parseTrustProxy(value) {
  const v = String(value ?? '').trim();
  if (!v) return undefined;
  const fail = () => {
    throw new Error('Invalid TRUST_PROXY: use a hop count (1-10) or a comma-separated list of loopback, linklocal, uniquelocal, IPs or CIDRs');
  };
  if (/^\d+$/.test(v)) {
    const hops = Number.parseInt(v, 10);
    return hops >= 1 && hops <= 10 ? hops : fail();
  }
  for (const token of v.split(',').map((t) => t.trim())) {
    if (['loopback', 'linklocal', 'uniquelocal'].includes(token)) continue;
    const [addr, prefix, extra] = token.split('/');
    const family = net.isIPv4(addr) ? 4 : net.isIPv6(addr) ? 6 : 0;
    if (!family || extra !== undefined) fail();
    if (prefix === undefined) continue; // a single host
    if (!/^\d{1,3}$/.test(prefix) || Number(prefix) > (family === 4 ? 32 : 128)) fail();
    // A short prefix trusts a large part of the internet, which is the same as `true`: anyone in that
    // range could set X-Forwarded-For and pick their own rate-limit bucket. Allow /8 and longer for IPv4,
    // /16 and longer for IPv6, plus the two standard wide IPv6 private blocks (fc00::/7, fe80::/10).
    const bits = Number(prefix);
    const a = addr.toLowerCase();
    const mapped = family === 6 && a.startsWith('::ffff:'); // IPv4-mapped: the v4 prefix is bits - 96
    const ok = family === 4 ? bits >= 8
      : mapped ? bits >= 96 + 8
      : bits >= 16 || (/^f[cd]/.test(a) && bits >= 7) || (/^fe[89ab]/.test(a) && bits >= 10);
    if (!ok) fail();
  }
  return v;
}

const app = express();
app.disable('x-powered-by');
const trustProxy = parseTrustProxy(process.env.TRUST_PROXY);
if (trustProxy !== undefined) app.set('trust proxy', trustProxy);
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
        // Feed images come from arbitrary publisher CDNs
        imgSrc: ["'self'", 'https:'],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        frameAncestors: ["'none'"],
        upgradeInsecureRequests: null, // app may be served over plain HTTP behind a proxy
      },
    },
  })
);
app.use('/api/', rateLimit({ windowMs: 60 * 1000, limit: 60, standardHeaders: true, legacyHeaders: false }));
const parser = new Parser();
const cache = new NodeCache({ stdTTL: 300, maxKeys: 50 }); // 5-minute cache, bounded

// Positive-integer config from the environment, falling back to a default.
function envInt(name, fallback) {
  const n = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}
const FEED_TIMEOUT_MS = envInt('FEED_TIMEOUT_MS', 10000); // total time for one feed fetch, redirects included
const FEED_MAX_BYTES = envInt('FEED_MAX_BYTES', 2 * 1024 * 1024); // cap on one feed body, after decompression
// An empty result (every feed failed) is cached briefly so an outage is not re-fetched by every request.
const NEGATIVE_CACHE_SECONDS = envInt('NEGATIVE_CACHE_SECONDS', 20);

const NEWS_SOURCES = [
  // Wire services — gold standard of factual reporting
  {
    name: 'Associated Press',
    url: 'https://feeds.apnews.com/rss/apf-topnews',
    category: 'General',
  },
  {
    name: 'Reuters',
    url: 'https://feeds.reuters.com/reuters/topNews',
    category: 'General',
  },
  {
    name: 'AFP (via Yahoo)',
    url: 'https://news.yahoo.com/rss/',
    category: 'General',
  },

  // Public broadcasting
  {
    name: 'NPR News',
    url: 'https://feeds.npr.org/1001/rss.xml',
    category: 'General',
  },
  {
    name: 'PBS NewsHour',
    url: 'https://www.pbs.org/newshour/feeds/rss/headlines',
    category: 'General',
  },
  {
    name: 'BBC World News',
    url: 'https://feeds.bbci.co.uk/news/world/rss.xml',
    category: 'General',
  },
  {
    name: 'BBC US & Canada',
    url: 'https://feeds.bbci.co.uk/news/world/us_and_canada/rss.xml',
    category: 'General',
  },

  // Tier-1 newspapers (long track record, Pulitzer-winning)
  {
    name: 'The New York Times',
    url: 'https://rss.nytimes.com/services/xml/rss/nyt/HomePage.xml',
    category: 'General',
  },
  {
    name: 'NYT US News',
    url: 'https://rss.nytimes.com/services/xml/rss/nyt/US.xml',
    category: 'General',
  },
  {
    name: 'The Washington Post',
    url: 'https://feeds.washingtonpost.com/rss/national',
    category: 'General',
  },
  {
    name: 'The Guardian US',
    url: 'https://www.theguardian.com/us-news/rss',
    category: 'General',
  },
  {
    name: 'The Economist',
    url: 'https://www.economist.com/united-states/rss.xml',
    category: 'General',
  },
  {
    name: 'Financial Times',
    url: 'https://www.ft.com/rss/home',
    category: 'Business',
  },
  {
    name: 'Wall Street Journal',
    url: 'https://feeds.a.dj.com/rss/RSSWorldNews.xml',
    category: 'Business',
  },
  {
    name: 'Los Angeles Times',
    url: 'https://www.latimes.com/rss2.0.xml',
    category: 'General',
  },

  // Politics
  {
    name: 'NPR Politics',
    url: 'https://feeds.npr.org/1014/rss.xml',
    category: 'Politics',
  },
  {
    name: 'Politico',
    url: 'https://rss.politico.com/politics-news.xml',
    category: 'Politics',
  },
  {
    name: 'The Hill',
    url: 'https://thehill.com/rss/syndicator/19109',
    category: 'Politics',
  },

  // Science & Health
  {
    name: 'Science | AAAS',
    url: 'https://www.science.org/rss/news_current.xml',
    category: 'Science',
  },
  {
    name: 'Nature News',
    url: 'https://www.nature.com/nature.rss',
    category: 'Science',
  },
  {
    name: 'Scientific American',
    url: 'https://rss.sciam.com/ScientificAmerican-Global',
    category: 'Science',
  },
  {
    name: 'STAT News',
    url: 'https://www.statnews.com/feed/',
    category: 'Health',
  },

  // Business & Finance
  {
    name: 'Bloomberg',
    url: 'https://feeds.bloomberg.com/markets/news.rss',
    category: 'Business',
  },
  {
    name: 'CNBC',
    url: 'https://www.cnbc.com/id/100003114/device/rss/rss.html',
    category: 'Business',
  },

  // Technology
  {
    name: 'MIT Technology Review',
    url: 'https://www.technologyreview.com/feed/',
    category: 'Technology',
  },
  {
    name: 'Ars Technica',
    url: 'https://feeds.arstechnica.com/arstechnica/index',
    category: 'Technology',
  },
  {
    name: 'Wired',
    url: 'https://www.wired.com/feed/rss',
    category: 'Technology',
  },
];

// True for hosts a redirect must never lead to: localhost names and private, loopback, link-local,
// cloud-metadata, multicast and otherwise non-public IP literals. (Hostnames that merely resolve to
// such an address, e.g. DNS rebinding, are not caught here.)
function isBlockedHost(hostname) {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  if (net.isIPv4(h)) return isBlockedV4(h.split('.').map(Number));
  if (net.isIPv6(h)) {
    const b = ipv6Bytes(h);
    if (b.every((x, i) => x === 0 || i === 15)) return true; // :: and ::1
    const mapped = b.slice(0, 10).every((x) => x === 0) && b[10] === 0xff && b[11] === 0xff;
    const nat64 = b.slice(0, 12).join() === [0, 0x64, 0xff, 0x9b, 0, 0, 0, 0, 0, 0, 0, 0].join();
    if (mapped || nat64) return isBlockedV4(b.slice(12));
    return (b[0] & 0xfe) === 0xfc || (b[0] === 0xfe && (b[1] & 0xc0) === 0x80) || b[0] === 0xff; // fc00::/7, fe80::/10, multicast
  }
  return false;
}
function isBlockedV4([a, b]) {
  return a === 0 || a === 10 || a === 127 || a >= 224
    || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}
function ipv6Bytes(ip) {
  const [head, tail = ''] = ip.split('::');
  const groups = (x) => (x ? x.split(':') : []);
  const h = groups(head);
  const t = ip.includes('::') ? groups(tail) : [];
  const all = ip.includes('::') ? [...h, ...Array(8 - h.length - t.length).fill('0'), ...t] : h;
  return all.flatMap((g) => { const n = parseInt(g, 16); return [n >> 8, n & 0xff]; });
}

const MAX_REDIRECTS = 5;

// Feed content is untrusted: bound the time, size and redirects of every fetch.
// (rss-parser's own parseURL has a timeout but no size limit and follows redirects blindly.)
async function fetchFeedText(url) {
  const signal = AbortSignal.timeout(FEED_TIMEOUT_MS); // one budget for the whole chain, body included
  const origin = new URL(url).origin;
  let current = url;
  let res;
  for (let hops = 0; ; hops++) {
    res = await fetch(current, {
      signal,
      redirect: 'manual',
      headers: {
        'User-Agent': 'USNewsAggregator/1.0',
        Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*',
      },
    });
    const location = res.headers.get('location');
    if (res.status < 300 || res.status >= 400 || !location) break;
    await res.body?.cancel();
    if (hops >= MAX_REDIRECTS) throw new Error('Too many redirects');
    let next;
    try { next = new URL(location, current); } catch { throw new Error('Redirect to an invalid address'); }
    // Feed URLs are trusted constants; where they send us is not. Same-origin redirects are fine, a
    // cross-origin one must be http(s) and must not point at an internal address.
    if (!['http:', 'https:'].includes(next.protocol) || (next.origin !== origin && isBlockedHost(next.hostname))) {
      throw new Error('Redirect to a disallowed address');
    }
    current = next.href;
  }
  if (!res.ok) {
    await res.body?.cancel();
    throw new Error(`HTTP ${res.status}`);
  }
  const declared = Number(res.headers.get('content-length'));
  if (declared > FEED_MAX_BYTES) {
    await res.body?.cancel();
    throw new Error('Feed too large');
  }
  // Count bytes as they arrive: content-length may be absent or wrong, and fetch has
  // already decompressed the body, so this also bounds gzip bombs.
  const chunks = [];
  let total = 0;
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > FEED_MAX_BYTES) {
      await reader.cancel();
      throw new Error('Feed too large');
    }
    chunks.push(value);
  }
  const charset = /charset=["']?([\w-]+)/i.exec(res.headers.get('content-type') || '')?.[1] || 'utf-8';
  let decoder;
  try { decoder = new TextDecoder(charset); } catch { decoder = new TextDecoder('utf-8'); }
  return decoder.decode(Buffer.concat(chunks));
}

// Seam for tests: fetch and parse one feed URL.
const feedLoader = {
  parse: async (url) => parser.parseString(await fetchFeedText(url)),
};

async function fetchFeed(source) {
  const urls = [source.url];
  if (source.fallback) urls.push(source.fallback);

  for (const url of urls) {
    try {
      const feed = await feedLoader.parse(url);
      return (feed.items || []).slice(0, 10).map((item) => ({
        title: item.title || '',
        link: safeUrl(item.link || item.guid) || '',
        summary: stripHtml(item.contentSnippet || item.content || item.summary || '').slice(0, 300),
        pubDate: item.pubDate || item.isoDate || new Date().toISOString(),
        source: source.name,
        category: source.category,
        imageUrl: safeUrl(extractImage(item)),
      }));
    } catch {
      // try fallback or give up
    }
  }
  return [];
}

// Feed content is untrusted: only allow absolute http(s) URLs
function safeUrl(value) {
  try {
    const u = new URL(String(value));
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : null;
  } catch {
    return null;
  }
}

function stripHtml(html) {
  return html.replace(/<[^>]*>/g, '').replace(/&[a-z]+;/gi, ' ').trim();
}

function extractImage(item) {
  if (item.enclosure && item.enclosure.url) return item.enclosure.url;
  if (item['media:content']?.$?.url) return item['media:content'].$.url;
  if (item['media:thumbnail']?.$?.url) return item['media:thumbnail'].$.url;
  const match = (item.content || item.summary || '').match(/<img[^>]+src="([^"]+)"/i);
  return match ? match[1] : null;
}

// Concurrent cache misses for the same key share one fetch round instead of each fanning out to every feed.
const inflight = new Map();

async function getNews(category) {
  const cacheKey = `news_${category || 'all'}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;
  if (inflight.has(cacheKey)) return inflight.get(cacheKey);

  const round = loadNews(category, cacheKey).finally(() => inflight.delete(cacheKey));
  inflight.set(cacheKey, round);
  return round;
}

async function loadNews(category, cacheKey) {
  const sources = category && category !== 'all'
    ? NEWS_SOURCES.filter((s) => s.category === category)
    : NEWS_SOURCES;

  const results = await Promise.allSettled(sources.map(fetchFeed));
  const articles = results
    .filter((r) => r.status === 'fulfilled')
    .flatMap((r) => r.value)
    .filter((a) => a.title && a.link)
    .sort((a, b) => new Date(b.pubDate) - new Date(a.pubDate));

  // Deduplicate by title similarity
  const seen = new Set();
  const unique = articles.filter((a) => {
    const key = a.title.toLowerCase().slice(0, 60);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // Empty means every feed failed: remember that only briefly, so an outage recovers quickly
  // but is not re-fetched (27 requests) by every incoming call.
  cache.set(cacheKey, unique, unique.length ? undefined : NEGATIVE_CACHE_SECONDS);
  return unique;
}

app.use(express.static(path.join(__dirname, 'public')));

const CATEGORIES = new Set(NEWS_SOURCES.map((s) => s.category));

// Strict integer query param: a single plain-digit string, or the default when absent.
// Express 5 gives arrays for repeated params, and parseInt would accept '5abc' / '1e3'.
function intParam(value, fallback) {
  if (value === undefined) return fallback;
  return typeof value === 'string' && /^\d{1,6}$/.test(value) ? Number.parseInt(value, 10) : null;
}

app.get('/api/news', async (req, res) => {
  const { category } = req.query;
  if (category !== undefined && category !== 'all' && !CATEGORIES.has(category)) {
    return res.status(400).json({ error: 'Invalid category' });
  }
  const page = intParam(req.query.page, 1);
  const limit = intParam(req.query.limit, 20);
  if (page === null || page < 1 || limit === null || limit < 1 || limit > 50) {
    return res.status(400).json({ error: 'Invalid page or limit' });
  }
  try {
    const all = await getNews(category);
    const start = (page - 1) * limit;
    res.json({
      articles: all.slice(start, start + limit),
      total: all.length,
      page,
      pages: Math.ceil(all.length / limit),
    });
  } catch (err) {
    console.error('Failed to fetch news:', err);
    res.status(500).json({ error: 'Failed to fetch news' });
  }
});

app.get('/api/categories', (req, res) => {
  const cats = [...new Set(NEWS_SOURCES.map((s) => s.category))];
  res.json(cats);
});

app.get('/api/sources', (req, res) => {
  res.json(NEWS_SOURCES.map(({ name, category }) => ({ name, category })));
});

app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// Final handler: never send err.message, stacks or paths to clients.
function errorHandler(err, req, res, next) {
  if (res.headersSent) return next(err); // too late to send JSON; let Express close the connection
  const status = Number.isInteger(err && err.status) && err.status >= 400 && err.status < 500 ? err.status : 500;
  if (status === 500) console.error('Unhandled error:', err);
  res.status(status).json({ error: status === 500 ? 'Internal error' : status === 404 ? 'Not found' : 'Bad request' });
}
app.use(errorHandler);

module.exports = {
  app, safeUrl, fetchFeed, getNews, cache, errorHandler, feedLoader, FEED_MAX_BYTES, NEGATIVE_CACHE_SECONDS,
  parseTrustProxy,
};

if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  const server = app.listen(PORT, () => {
    console.log(`US News Aggregator running at http://localhost:${PORT}`);
  });
  process.on('SIGTERM', () => server.close(() => process.exit(0)));
}
