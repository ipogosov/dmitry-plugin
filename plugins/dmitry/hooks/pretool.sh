#!/usr/bin/env bash
set -euo pipefail

# Bypass for Dmitry's internal CLI processes (research agent)
[ -n "${DMITRY_INTERNAL:-}" ] && echo '{}' && exit 0

MODE="${1:-block}"

# Bash — always block
if [ "$MODE" = "block" ]; then
  cat <<'BLOCK'
{
  "decision": "block",
  "reason": "BLOCKED. You MUST use dmitry_exec instead of Bash."
}
BLOCK
  exit 0
fi

# Grep/Glob — block, redirect to dmitry
if [ "$MODE" = "block-search" ]; then
  cat <<'BLOCK'
{
  "decision": "block",
  "reason": "BLOCKED. Use dmitry_exec for single grep/find, or ONE dmitry_ask call for bulk search across multiple files."
}
BLOCK
  exit 0
fi

# WebSearch/WebFetch — block, redirect to dmitry_web
if [ "$MODE" = "block-web" ]; then
  cat <<'BLOCK'
{
  "decision": "block",
  "reason": "BLOCKED. Use dmitry_web for web search and fetching pages."
}
BLOCK
  exit 0
fi

echo '{}'
