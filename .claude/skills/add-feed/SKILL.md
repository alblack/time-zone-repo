---
name: add-feed
description: Add a news source (RSS feed) or a new API route to the US News Aggregator, following the repo's security conventions and adding the required test. Use when asked to add a feed, source, category, or route.
---

# Add a feed or route

Follow CLAUDE.md. Feed content is untrusted.

## Adding a feed
1. Add an entry to `NEWS_SOURCES` in `server.js` (`name`, `url`, `category`), matching neighbouring entries. The URL must be https and the feed must exist (do not guess URLs).
2. Use an existing category unless asked; `CATEGORIES` is derived from `NEWS_SOURCES` automatically.
3. Add a test in `test/` that the source appears in `/api/sources` (and, for a new category, in `/api/categories`).

## Adding a route
1. Validate every query parameter (type, range, allowlist) and return `400` with a fixed message on failure.
2. Never return `err.message`; log with `console.error` and return a generic `500` message.
3. Add a test in `test/server.test.js` covering the happy path and invalid input.

## Frontend changes
- Wrap all feed data in `escHtml` before `innerHTML`; allow only http(s) URLs (regex check on the client, `safeUrl` on the server).
- No inline scripts, styles or event handlers (CSP).

## Before finishing
Run `npm test` and `npm run audit`; both must pass. Do not commit secrets or `.env`.
