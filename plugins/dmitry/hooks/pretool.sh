#!/usr/bin/env bash
set -euo pipefail

# Bypass for Dmitry's internal CLI processes (research agent)
[ -n "${DMITRY_INTERNAL:-}" ] && echo '{}' && exit 0

# Bash — always block
cat <<'BLOCK'
{
  "decision": "block",
  "reason": "BLOCKED. You MUST use dmitry_exec instead of Bash. Use Grep and Glob freely, use Read for exact file content."
}
BLOCK
