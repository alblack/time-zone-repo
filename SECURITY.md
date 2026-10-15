# Security & Claude Code Hardening — Change Log

## Review findings (before)
| # | Finding | Severity | Status |
|---|---------|----------|--------|
| 1 | Feed `link`/`imageUrl` unvalidated → `javascript:` URL in `href` (XSS on click) | High | Fixed: `safeUrl()` server-side + client regex |
| 2 | 3 vulnerable deps (express/qs, path-to-regexp) per `npm audit` | High | Fixed: `npm audit fix` + `overrides.qs` → 0 vulns |
| 3 | No security headers / CSP | Medium | Fixed: helmet with strict CSP (no inline script/style/handlers) |
| 4 | No rate limiting on `/api/*` | Medium | Fixed: 60 req/min/IP |
| 5 | `limit`/`page`/`category` unvalidated (huge/NaN values) | Medium | Fixed: 400 on invalid input, `limit` ≤ 50 |
| 6 | 500 responses leaked `err.message` | Low | Fixed: generic message, detail logged |
| 7 | Unbounded cache keys; `X-Powered-By` exposed | Low | Fixed: `maxKeys: 50`, header disabled |
| 8 | Inline `onerror`/`style` blocked CSP | — | Refactored to listeners/CSS classes |

## Claude Code configuration added
- `CLAUDE.md` — project commands and security conventions.
- `.claude/settings.json` — allowlist for safe commands; denies `.env`/key reads, `curl`/`wget`, `rm -rf`, force-push, `reset --hard`; PreToolUse secret-scanning hook; PostToolUse test run.
- `.claude/hooks/block-secrets.js` — blocks writes containing AWS/GitHub/Anthropic keys or private keys.
- `.github/workflows/ci.yml` — tests + audit, least-privilege token.
- `.github/dependabot.yml` — weekly npm and Actions updates.
- `.gitignore` — extended for keys and local Claude settings.

## Testing
`npm test` (8 tests: URL sanitizer, headers, input validation, source exposure, static serving, feed sanitization/cap/error handling) passes; `npm audit` reports 0 vulnerabilities; live server smoke test confirmed CSP, rate-limit headers, and 400 on `limit=999`.

## Known gaps / inference (not verified)
- Live RSS fetching was not exercised (sandbox network); feed handling is covered by `test/feed.test.js` with a stubbed parser, not real feeds.
- CSP and client sanitization were verified in headless Chromium with a stubbed `/api/news` containing hostile data (`javascript:` link, HTML in title, broken image): link became `#`, no HTML injected, image fell back to the placeholder, CSP raised no violations on the app's own assets. This check is a one-off script, not part of `npm test`.
- Side effect of the CSP: `img-src` is `'self' https:` (no `data:`), so articles with plain-http images show the placeholder icon. Allowing any https host is deliberate (feed images come from publisher CDNs) but means a publisher can see reader IPs, like a tracking pixel.
- Rate limiting is per-IP. Behind a reverse proxy set `TRUST_PROXY` (hop count such as `1`, or a list of `loopback`/IPs/CIDRs); otherwise every user shares the proxy's single 60 req/min bucket. `true`, `*` and CIDRs wider than /8 (IPv4) or /16 (IPv6, except fc00::/7 and fe80::/10) are rejected because they let clients pick their own IP; an invalid value stops startup. The hop count must equal the real number of proxies. Unset = trust no proxy.
- Some feed URLs (e.g. Reuters) may be defunct — a reliability, not security, issue.
- Enable branch protection and GitHub secret scanning in repo settings (cannot be done from code).
- Feed fetching is bounded: 10 s total, 2 MiB after decompression (`FEED_TIMEOUT_MS`, `FEED_MAX_BYTES`), at most 5 redirects. A redirect to another origin must be http(s) and may not point at localhost or a private, link-local, metadata or multicast IP literal. A hostname that merely resolves to an internal address (DNS rebinding) is not blocked. Feed URLs are fixed constants, not request input.
- The secret-blocking hook is a pattern list (AWS, GitHub, Anthropic, Slack, Google, Stripe, private keys); it does not see Bash redirects such as `echo > file`.
