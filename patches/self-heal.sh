#!/usr/bin/env bash
set -euo pipefail

# Detects when a pi update broke one or more core-patches.mjs operations, and
# prepares a sandbox (pristine copy + patches applied where possible) for
# diagnosis. Never touches the live install — that only happens via
# reapply.sh, and only after a human has reviewed a fix to core-patches.mjs.
#
# There is no per-version patch file: a broken operation gets fixed by
# editing that one file's anchor/replacement in place, then re-running
# `check` to confirm.

PACK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PI_PKG="${PI_PKG:-$(npm root -g)/@earendil-works/pi-coding-agent}"
STATE_FILE="$PACK_DIR/.last-healed-version"
WORK_ROOT="$PACK_DIR/.self-heal-work"

pi_version() {
  node -e 'console.log(require(process.argv[1]).version)' "$PI_PKG/package.json"
}

fetch_pristine() {
  local version="$1" dest="$2"
  rm -rf "$dest" && mkdir -p "$dest"
  ( cd "$dest" && npm init -y >/dev/null 2>&1 && npm install "@earendil-works/pi-coding-agent@$version" --no-save >/dev/null 2>&1 )
}

cmd_check() {
  local version; version="$(pi_version)"
  local last=""
  [[ -f "$STATE_FILE" ]] && last="$(cat "$STATE_FILE")"

  if [[ "$version" == "$last" ]]; then
    echo "core-patches: pi $version already verified healthy — nothing to do."
    return 0
  fi

  echo "core-patches: pi version changed ($last -> $version). Preparing sandbox..."
  local work="$WORK_ROOT/$version"
  local pristine="$work/pristine/node_modules/@earendil-works/pi-coding-agent"
  local candidate="$work/candidate"

  fetch_pristine "$version" "$work/pristine"
  rm -rf "$candidate" && cp -R "$pristine" "$candidate"

  local report="$work/apply-report.json"
  local apply_ok=1
  node "$PACK_DIR/apply-patches.mjs" "$candidate" > "$report" 2>&1 || apply_ok=0
  cat "$report"

  local syntax_failed=0
  if command -v python3 >/dev/null 2>&1; then
    while IFS= read -r rel; do
      [[ -z "$rel" ]] && continue
      node --check "$candidate/$rel" || syntax_failed=1
    done < <(python3 -c "import json;d=json.load(open('$report'));print('\n'.join(d.get('touchedFiles',[])))" 2>/dev/null)
  fi

  if [[ "$apply_ok" -eq 1 && "$syntax_failed" -eq 0 ]]; then
    echo "$version" > "$STATE_FILE"
    echo
    echo "HEALTHY: all core-patches.mjs operations applied clean on pi $version. Run reapply.sh to apply to the live install."
    rm -rf "$work"
    return 0
  fi

  echo
  echo "NEEDS ATTENTION: pi $version broke one or more patch operations (see \"failed\" entries above — anchor-not-found means upstream code near that spot changed; ambiguous means the anchor text is no longer unique)."
  echo "Sandbox prepared at: $work"
  echo "  - pristine copy:  $pristine"
  echo "  - candidate copy (operations that DID apply are already reflected here): $candidate"
  echo "Fix by finding the new surrounding text for each failing operation's anchor and editing it directly in:"
  echo "  $PACK_DIR/core-patches.mjs"
  echo "Then re-run: $0 check"
  echo "Once healthy, review the core-patches.mjs diff and run reapply.sh to apply it to the live install."
  return 1
}

case "${1:-check}" in
  check) cmd_check ;;
  *) echo "Usage: $0 {check}" >&2; exit 1 ;;
esac
