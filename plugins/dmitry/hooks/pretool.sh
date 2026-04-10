#!/usr/bin/env bash
set -euo pipefail

# Bypass for Dmitry's internal CLI processes (research agent)
[ -n "${DMITRY_INTERNAL:-}" ] && echo '{}' && exit 0

STATE_FILE="${TMPDIR:-${TEMP:-/tmp}}/dmitry-pretool-state"
PLUGIN_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# Read counter (0 if file doesn't exist)
count=0
[ -f "$STATE_FILE" ] && count=$(cat "$STATE_FILE")

# Increment and save
count=$((count + 1))
echo "$count" > "$STATE_FILE"

# First call — block
if [ "$count" -eq 1 ]; then
  cat <<'BLOCK'
{
  "decision": "block",
  "reason": "Use dmitry_exec MCP tool for all shell commands. It filters output and keeps your context lean. Use Read tool when you need exact file content."
}
BLOCK
  exit 0
fi

# Every 3rd call after first — reminder
if [ $(( (count - 1) % 3 )) -eq 0 ]; then
  cat <<'REMIND'
{
  "additionalContext": "Reminder: use dmitry_exec for shell commands, Read for exact file content."
}
REMIND
  exit 0
fi

# Otherwise — pass through
echo '{}'
