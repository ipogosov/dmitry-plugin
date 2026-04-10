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

# WebSearch/WebFetch — reminder
if [ "$MODE" = "remind-web" ]; then
  cat <<'REMIND'
{
  "additionalContext": "Use dmitry_web instead. It filters web results and keeps your context lean. Raw WebSearch/WebFetch output stays in context for the rest of the session."
}
REMIND
  exit 0
fi

echo '{}'
