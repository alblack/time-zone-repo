const express = require('express');
const Parser = require('rss-parser');
const NodeCache = require('node-cache');
const path = require('path');

const app = express();
const parser = new Parser({
  timeout: 10000,
  headers: { 'User-Agent': 'USNewsAggregator/1.0' },
});
const cache = new NodeCache({ stdTTL: 300 }); // 5-minute cache

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

async function fetchFeed(source) {
  const urls = [source.url];
  if (source.fallback) urls.push(source.fallback);

  for (const url of urls) {
    try {
      const feed = await parser.parseURL(url);
      return (feed.items || []).slice(0, 10).map((item) => ({
        title: item.title || '',
        link: item.link || item.guid || '',
        summary: stripHtml(item.contentSnippet || item.content || item.summary || '').slice(0, 300),
        pubDate: item.pubDate || item.isoDate || new Date().toISOString(),
        source: source.name,
        category: source.category,
        imageUrl: extractImage(item),
      }));
    } catch {
      // try fallback or give up
    }
  }
  return [];
}

function stripHtml(html) {
  return html.replace(/<[^>]*>/g, '').replace(/&[a-z]+;/gi, ' ').trim();
}

function extractImage(item) {
  if (item.enclosure && item.enclosure.url) return item.enclosure.url;
  if (item['media:content'] && item['media:content'].$.url) return item['media:content'].$.url;
  if (item['media:thumbnail'] && item['media:thumbnail'].$.url) return item['media:thumbnail'].$.url;
  const match = (item.content || item.summary || '').match(/<img[^>]+src="([^"]+)"/i);
  return match ? match[1] : null;
}

async function getNews(category) {
  const cacheKey = `news_${category || 'all'}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

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

  cache.set(cacheKey, unique);
  return unique;
}

app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/news', async (req, res) => {
  try {
    const { category, page = 1, limit = 20 } = req.query;
    const all = await getNews(category);
    const start = (page - 1) * limit;
    const items = all.slice(start, start + Number(limit));
    res.json({
      articles: items,
      total: all.length,
      page: Number(page),
      pages: Math.ceil(all.length / limit),
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch news', message: err.message });
  }
});

app.get('/api/categories', (req, res) => {
  const cats = [...new Set(NEWS_SOURCES.map((s) => s.category))];
  res.json(cats);
});

app.get('/api/sources', (req, res) => {
  res.json(NEWS_SOURCES.map(({ name, category }) => ({ name, category })));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`US News Aggregator running at http://localhost:${PORT}`);
});
