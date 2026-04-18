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

# Task (native subagent spawn) — block, redirect to dmitry_task
if [ "$MODE" = "block-task" ]; then
  cat <<'BLOCK'
{
  "decision": "block",
  "reason": "BLOCKED. Native Task spawns Opus (expensive). Use dmitry_task(task, model=\"sonnet\") for mechanical code work, exploration, log/session analysis, build triage. model=\"haiku\" for cheap inventory, model=\"opus\" only for novel design/debug. If dmitry_task returned 'No such tool available': the MCP server disconnected. Ask the operator to run /mcp (reconnect dmitry). If that fails, STOP the current task and ask the operator how to proceed — do NOT fall back to native Task/Agent."
}
BLOCK
  exit 0
fi

echo '{}'
