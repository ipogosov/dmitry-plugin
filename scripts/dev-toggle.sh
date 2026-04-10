#!/usr/bin/env bash
set -euo pipefail

PLUGINS_JSON="$HOME/.claude/plugins/installed_plugins.json"
CACHE_DIR="$HOME/.claude/plugins/cache/dmitry-plugin/dmitry"
DEV_LINK="$CACHE_DIR/dev"
PLUGIN_DIR="$(cd "$(dirname "$0")/.." && pwd)/plugins/dmitry"
MODE="${1:-status}"

get_install_path() {
  node -e "
    const d = require('$PLUGINS_JSON');
    const e = d.plugins['dmitry@dmitry-plugin']?.[0];
    console.log(e?.installPath || '');
  "
}

set_install_path() {
  node -e "
    const fs = require('fs');
    const d = JSON.parse(fs.readFileSync('$PLUGINS_JSON', 'utf8'));
    d.plugins['dmitry@dmitry-plugin'][0].installPath = '$1';
    fs.writeFileSync('$PLUGINS_JSON', JSON.stringify(d, null, 2) + '\n');
  "
}

case "$MODE" in
  on)
    # Create symlink if missing
    if [ ! -L "$DEV_LINK" ]; then
      ln -sfn "$PLUGIN_DIR" "$DEV_LINK"
    fi
    set_install_path "$DEV_LINK"
    echo "DEV mode ON → $DEV_LINK -> $PLUGIN_DIR"
    echo "Restart Claude session to apply."
    ;;
  off)
    # Get version from plugin.json (the last published version)
    LATEST=$(node -e "console.log(require('$PLUGIN_DIR/.claude-plugin/plugin.json').version)")
    if [ -z "$LATEST" ] || [ ! -d "$CACHE_DIR/$LATEST" ]; then
      echo "ERROR: version $LATEST not found in $CACHE_DIR"
      exit 1
    fi
    set_install_path "$CACHE_DIR/$LATEST"
    echo "DEV mode OFF → $CACHE_DIR/$LATEST"
    echo "Restart Claude session to apply."
    ;;
  status)
    CURRENT=$(get_install_path)
    if echo "$CURRENT" | grep -q "/dev$"; then
      echo "DEV mode (→ $CURRENT)"
    else
      echo "PROD mode (→ $CURRENT)"
    fi
    ;;
  *)
    echo "Usage: $0 [on|off|status]"
    exit 1
    ;;
esac
