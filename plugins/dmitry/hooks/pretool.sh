#!/usr/bin/env bash
set -euo pipefail

# Bypass for Dmitry's internal CLI processes (research agent)
[ -n "${DMITRY_INTERNAL:-}" ] && echo '{}' && exit 0

MODE="${1:-block}"

# Bash, Glob — always block
if [ "$MODE" = "block" ]; then
  cat <<'BLOCK'
{
  "decision": "block",
  "reason": "You MUST use dmitry_exec for all commands. Bash and Glob are not allowed. Route through dmitry_exec instead."
}
BLOCK
  exit 0
fi

# Grep — soft reminder every 3rd call
STATE_FILE="${TMPDIR:-${TEMP:-/tmp}}/dmitry-pretool-grep-state"
count=0
[ -f "$STATE_FILE" ] && count=$(cat "$STATE_FILE")
count=$((count + 1))
echo "$count" > "$STATE_FILE"

if [ $(( (count - 1) % 3 )) -eq 0 ]; then
  cat <<'REMIND'
{
  "additionalContext": "You SHOULD use dmitry_exec(\"grep ...\") instead of Grep directly. It filters output and keeps your context lean."
}
REMIND
  exit 0
fi

echo '{}'
