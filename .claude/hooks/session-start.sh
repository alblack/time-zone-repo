#!/bin/bash
# SessionStart hook: install dependencies so `npm test` and `npm run audit` work
# in Claude Code on the web. Idempotent and non-interactive.
set -euo pipefail

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "${CLAUDE_PROJECT_DIR:-.}"

# npm install (not ci) so the container's cached node_modules is reused.
npm install --no-audit --no-fund
