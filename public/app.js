(function () {
  'use strict';

  const CATEGORY_ICONS = {
    General: '📰', Politics: '🏛️', Business: '💼',
    Technology: '💻', Sports: '🏆', Health: '🏥', Science: '🔬',
  };

  let state = {
    category: 'all',
    page: 1,
    totalPages: 1,
    allArticles: [],
    query: '',
  };

  const grid = document.getElementById('news-grid');
  const loading = document.getElementById('loading');
  const errorMsg = document.getElementById('error-msg');
  const loadMoreBtn = document.getElementById('load-more-btn');
  const statsBar = document.getElementById('stats-bar');
  const lastUpdated = document.getElementById('last-updated');
  const refreshBtn = document.getElementById('refresh-btn');
  const searchInput = document.getElementById('search-input');

  function showLoading(show) {
    loading.classList.toggle('hidden', !show);
    grid.classList.toggle('hidden', show);
  }

  function showError(msg) {
    errorMsg.textContent = msg;
    errorMsg.classList.remove('hidden');
  }

  function hideError() {
    errorMsg.classList.add('hidden');
  }

  function formatDate(dateStr) {
    if (!dateStr) return '';
    const d = new Date(dateStr);
    if (isNaN(d)) return '';
    const now = new Date();
    const diff = Math.floor((now - d) / 1000);
    if (diff < 60) return 'Just now';
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  }

  function createCard(article) {
    const card = document.createElement('a');
    card.className = 'news-card';
    card.href = /^https?:\/\//i.test(article.link) ? article.link : '#';
    card.target = '_blank';
    card.rel = 'noopener noreferrer';

    // No inline handlers/styles: the CSP forbids them
    const icon = CATEGORY_ICONS[article.category] || '📰';
    const imageHtml = article.imageUrl && /^https?:\/\//i.test(article.imageUrl)
      ? `<img class="card-image" src="${escHtml(article.imageUrl)}" alt="" loading="lazy">`
        + `<div class="card-image-placeholder hidden">${icon}</div>`
      : `<div class="card-image-placeholder">${icon}</div>`;

    card.innerHTML = `
      ${imageHtml}
      <div class="card-body">
        <div class="card-meta">
          <span class="card-source">${escHtml(article.source)}</span>
          <span class="card-tag">${escHtml(article.category)}</span>
        </div>
        <div class="card-title">${escHtml(article.title)}</div>
        ${article.summary ? `<div class="card-summary">${escHtml(article.summary)}</div>` : ''}
        <div class="card-date">&#128337; ${formatDate(article.pubDate)}</div>
      </div>
    `;
    const img = card.querySelector('img.card-image');
    if (img) {
      img.addEventListener('error', () => {
        img.classList.add('hidden');
        img.nextElementSibling.classList.remove('hidden');
      });
    }
    return card;
  }

  function escHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function filterArticles(articles) {
    if (!state.query) return articles;
    const q = state.query.toLowerCase();
    return articles.filter(
      (a) => a.title.toLowerCase().includes(q) || (a.summary && a.summary.toLowerCase().includes(q))
    );
  }

  function renderArticles(articles, append) {
    if (!append) grid.innerHTML = '';
    const filtered = filterArticles(articles);
    if (!filtered.length && !append) {
      grid.innerHTML = '<p class="empty-state">No articles found.</p>';
      return;
    }
    const frag = document.createDocumentFragment();
    filtered.forEach((a) => frag.appendChild(createCard(a)));
    grid.appendChild(frag);
  }

  async function fetchNews(append) {
    hideError();
    if (!append) showLoading(true);

    const params = new URLSearchParams({
      page: state.page,
      limit: 24,
      ...(state.category !== 'all' ? { category: state.category } : {}),
    });

    try {
      const res = await fetch(`/api/news?${params}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();

      if (append) {
        state.allArticles = [...state.allArticles, ...data.articles];
      } else {
        state.allArticles = data.articles;
      }

      state.totalPages = data.pages;

      showLoading(false);
      renderArticles(state.allArticles, false);

      const total = filterArticles(state.allArticles).length;
      statsBar.textContent = `Showing ${total} articles${state.query ? ` matching "${state.query}"` : ''}`;

      loadMoreBtn.classList.toggle('hidden', state.page >= state.totalPages);
      lastUpdated.textContent = `Updated ${formatDate(new Date().toISOString())}`;
    } catch (err) {
      showLoading(false);
      showError(`Failed to load news: ${err.message}. Please try again.`);
    }
  }

  // Category buttons
  document.querySelectorAll('.cat-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.cat-btn').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      state.category = btn.dataset.cat;
      state.page = 1;
      state.allArticles = [];
      state.query = '';
      searchInput.value = '';
      fetchNews(false);
    });
  });

  // Load more
  loadMoreBtn.addEventListener('click', () => {
    state.page++;
    fetchNews(true);
  });

  // Refresh
  refreshBtn.addEventListener('click', () => {
    refreshBtn.classList.add('spinning');
    state.page = 1;
    state.allArticles = [];
    fetchNews(false).then(() => refreshBtn.classList.remove('spinning'));
  });

  // Search
  let searchTimer;
  searchInput.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      state.query = searchInput.value.trim();
      renderArticles(state.allArticles, false);
      const total = filterArticles(state.allArticles).length;
      statsBar.textContent = `Showing ${total} articles${state.query ? ` matching "${state.query}"` : ''}`;
    }, 300);
  });

  // Auto-refresh every 5 minutes
  setInterval(() => {
    state.page = 1;
    state.allArticles = [];
    fetchNews(false);
  }, 5 * 60 * 1000);

  // Initial load
  fetchNews(false);
})();
