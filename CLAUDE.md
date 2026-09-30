# US News Aggregator

Express app that aggregates RSS feeds and serves a static frontend from `public/`.

## Commands
- `npm start` — run server (PORT env, default 3000)
- `npm test` — node:test suite in `test/`
- `npm run audit` — dependency audit (must pass before merging)

## Conventions
- Feed content is untrusted. Never put feed data in `innerHTML` without `escHtml`, and only allow http(s) URLs (`safeUrl` on the server, regex check on the client).
- No inline scripts, inline styles or inline event handlers: the CSP (`server.js`) forbids them.
- Validate every query parameter in routes; never return `err.message` to clients.
- Never commit secrets or `.env`; add new config via environment variables.
- Add a test in `test/` for each new route or security control.
