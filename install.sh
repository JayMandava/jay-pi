#!/usr/bin/env bash
set -euo pipefail

# One-shot setup: installs/updates pi itself, installs this harness into
# ~/.pi/agent, applies the core patches, and hands off to pi's own /login
# flow for credentials. Safe to re-run: extensions/, agents/, and patches/
# are copied fresh every time (they're this repo's actual content), but
# config/*.example.json files are only copied the first time — an existing
# settings.json/models.json/mcp.json/AGENTS.md/external-sink.json is never
# overwritten.
#
# Env vars to skip specific steps on a re-run or a pinned setup:
#   PI_HARNESS_SKIP_PI_INSTALL=1   don't install/update pi itself
#   PI_HARNESS_SKIP_LAUNCH=1       don't offer to launch pi at the end

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AGENT_DIR="${PI_AGENT_DIR:-$HOME/.pi/agent}"

echo "=== 1/5: pi itself ==="
if ! command -v pi >/dev/null 2>&1; then
  echo "pi not found on PATH — installing @earendil-works/pi-coding-agent globally..."
  if ! npm install -g @earendil-works/pi-coding-agent; then
    echo "npm install -g failed — if that's a permission error, fix your global npm prefix (e.g. via nvm) rather than re-running this with sudo." >&2
    exit 1
  fi
elif [[ "${PI_HARNESS_SKIP_PI_INSTALL:-}" != "1" ]]; then
  echo "pi found ($(pi --version)) — checking for updates..."
  pi update pi || echo "Could not update pi automatically — continuing with the installed version."
else
  echo "pi found ($(pi --version)) — skipping update (PI_HARNESS_SKIP_PI_INSTALL=1)."
fi
echo "Using pi $(pi --version 2>/dev/null || echo 'unknown')"

echo
echo "=== 2/5: sqlite3 ==="
if command -v sqlite3 >/dev/null 2>&1; then
  echo "sqlite3 found — record_cycle and every other DB-backed extension here need it, and it's present."
else
  echo "sqlite3 not found on PATH. Every DB-backed extension in this harness (record_cycle, grill, plan-approval, the Jev cross-check) shells out to it and will fail without it." >&2
  case "$(uname -s)" in
    Darwin) echo "  Install it with: brew install sqlite" >&2 ;;
    Linux) echo "  Install it with: sudo apt-get install sqlite3   (or your distro's equivalent)" >&2 ;;
    *) echo "  Install sqlite3 for your platform, then re-run this script." >&2 ;;
  esac
  echo "Continuing installation anyway — fix this before relying on any DB write."
fi

echo
echo "=== 3/5: Harness files ==="
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
echo "=== 4/5: Core patches ==="
if "$AGENT_DIR/patches/self-heal.sh" check; then
  echo "Reapplying to the live install..."
  "$AGENT_DIR/patches/reapply.sh"
else
  echo "self-heal reported an issue on the currently-installed pi version — not auto-reapplying blind." >&2
  echo "Review the sandbox it printed above, fix core-patches.mjs, then run: $AGENT_DIR/patches/reapply.sh" >&2
fi

echo
echo "=== 5/5: Credentials ==="
echo "Edit $AGENT_DIR/models.json for the models you actually have (see docs/model-provider-setup.md for a self-hosted/vLLM walkthrough)."
echo "For hosted providers, pi handles login itself — no separate wizard needed here:"
echo "  - Subscriptions (Claude Pro/Max, ChatGPT Plus/Pro, GitHub Copilot, xAI, Meta, OpenRouter, Radius): run pi, then /login"
echo "  - API keys: export e.g. ANTHROPIC_API_KEY or OPENAI_API_KEY before running pi (see docs/providers.md for the full variable list)"
echo
echo "Done."

if [[ "${PI_HARNESS_SKIP_LAUNCH:-}" != "1" && -t 0 && -t 1 ]]; then
  read -r -p "Launch pi now? [Y/n] " reply
  case "$reply" in
    [nN]*) echo "You're set — run 'pi' whenever you're ready." ;;
    *) exec pi ;;
  esac
else
  echo "Run 'pi' (or '/reload' if it's already running) to pick up the installed harness."
fi
