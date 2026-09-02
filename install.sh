#!/usr/bin/env bash
set -euo pipefail

# Installs this harness into ~/.pi/agent. Safe to re-run: extensions/, agents/,
# and patches/ are copied fresh every time (they're this repo's actual
# content), but config/*.example.json files are only copied the first time —
# an existing settings.json/models.json/mcp.json/AGENTS.md/external-sink.json
# is never overwritten.

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AGENT_DIR="${PI_AGENT_DIR:-$HOME/.pi/agent}"

mkdir -p "$AGENT_DIR"/{extensions,agents,patches}

echo "Installing extensions..."
cp -R "$REPO_DIR"/extensions/. "$AGENT_DIR/extensions/"

echo "Installing agent role prompts (planner/developer/tester)..."
cp -R "$REPO_DIR"/agents/. "$AGENT_DIR/agents/"

echo "Installing core patch pack..."
cp -R "$REPO_DIR"/patches/. "$AGENT_DIR/patches/"
chmod +x "$AGENT_DIR/patches/reapply.sh" "$AGENT_DIR/patches/self-heal.sh"

echo "Installing record_cycle's MCP server dependencies (needed for Developer runs routed through Claude CLI)..."
( cd "$AGENT_DIR/extensions/mcp/record-cycle-server" && npm ci --omit=dev >/dev/null )

copy_if_absent() {
  local src="$1" dest="$2"
  if [[ -f "$dest" ]]; then
    echo "Skipping $dest (already exists)"
  else
    cp "$src" "$dest"
    echo "Wrote $dest"
  fi
}

copy_if_absent "$REPO_DIR/config/settings.example.json" "$AGENT_DIR/settings.json"
copy_if_absent "$REPO_DIR/config/models.example.json" "$AGENT_DIR/models.json"
copy_if_absent "$REPO_DIR/config/mcp.example.json" "$AGENT_DIR/mcp.json"
# external-sink.json is intentionally NOT copied automatically — nothing is
# gated until you opt in by copying config/external-sink.example.json
# yourself and editing it for your actual tracker.

if [[ ! -f "$HOME/AGENTS.md" ]]; then
  cp "$REPO_DIR/AGENTS.md" "$HOME/AGENTS.md"
  echo "Wrote $HOME/AGENTS.md"
else
  echo "Skipping $HOME/AGENTS.md (already exists) — diff against $REPO_DIR/AGENTS.md if you want to merge changes"
fi

echo
echo "Done. Next steps:"
echo "  1. Edit $AGENT_DIR/models.json / settings.json for the models you actually have (see docs/model-provider-setup.md)"
echo "  2. Run $AGENT_DIR/patches/self-heal.sh check, then $AGENT_DIR/patches/reapply.sh"
echo "  3. Restart pi (or /reload)"
