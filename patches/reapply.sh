#!/usr/bin/env bash
set -euo pipefail

PACK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PI_PKG="${PI_PKG:-$(npm root -g)/@earendil-works/pi-coding-agent}"

if [[ ! -d "$PI_PKG/dist" ]]; then
  echo "pi package not found: $PI_PKG" >&2
  exit 1
fi

# apply-patches.mjs searches every dist/**/*.js file for each operation's
# content anchor — this works whether pi ships modular dist/*.js files or a
# pre-built dist/bundle/chunks/*.js bundle, unlike file-path-keyed line diffs
# which break the moment pi reshuffles its own build output.
if node "$PACK_DIR/apply-patches.mjs" "$PI_PKG"; then
  echo "Patches applied cleanly."
else
  echo "Some patches could not be applied — see the anchor-not-found/ambiguous entries in the report above. Run '$PACK_DIR/self-heal.sh check' for a diagnosis sandbox before editing core-patches.mjs by hand." >&2
  exit 1
fi

echo "Restart pi or run /reload."
