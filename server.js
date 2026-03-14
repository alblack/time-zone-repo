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
  {
    name: 'AP News',
    url: 'https://rsshub.app/apnews/topics/apf-usnews',
    category: 'General',
    fallback: 'https://feeds.apnews.com/rss/apf-usnews',
  },
  {
    name: 'NPR News',
    url: 'https://feeds.npr.org/1001/rss.xml',
    category: 'General',
  },
  {
    name: 'NPR Politics',
    url: 'https://feeds.npr.org/1014/rss.xml',
    category: 'Politics',
  },
  {
    name: 'Reuters US',
    url: 'https://feeds.reuters.com/reuters/domesticNews',
    category: 'General',
  },
  {
    name: 'The Hill',
    url: 'https://thehill.com/rss/syndicator/19109',
    category: 'Politics',
  },
  {
    name: 'CBS News',
    url: 'https://www.cbsnews.com/latest/rss/us',
    category: 'General',
  },
  {
    name: 'NBC News',
    url: 'https://feeds.nbcnews.com/nbcnews/public/news',
    category: 'General',
  },
  {
    name: 'ABC News',
    url: 'https://abcnews.go.com/abcnews/usheadlines',
    category: 'General',
  },
  {
    name: 'CNN',
    url: 'http://rss.cnn.com/rss/cnn_us.rss',
    category: 'General',
  },
  {
    name: 'Fox News',
    url: 'https://moxie.foxnews.com/google-publisher/us.xml',
    category: 'General',
  },
  {
    name: 'USA Today',
    url: 'https://rssfeeds.usatoday.com/usatoday-NewsTopStories',
    category: 'General',
  },
  {
    name: 'Washington Post',
    url: 'https://feeds.washingtonpost.com/rss/national',
    category: 'General',
  },
  {
    name: 'NYT US',
    url: 'https://rss.nytimes.com/services/xml/rss/nyt/US.xml',
    category: 'General',
  },
  {
    name: 'Politico',
    url: 'https://rss.politico.com/politics-news.xml',
    category: 'Politics',
  },
  {
    name: 'ESPN',
    url: 'https://www.espn.com/espn/rss/news',
    category: 'Sports',
  },
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
  {
    name: 'TechCrunch',
    url: 'https://techcrunch.com/feed/',
    category: 'Technology',
  },
  {
    name: 'Ars Technica',
    url: 'https://feeds.arstechnica.com/arstechnica/index',
    category: 'Technology',
  },
  {
    name: 'Healthline',
    url: 'https://www.healthline.com/rss/health-news',
    category: 'Health',
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
