#!/usr/bin/env bash
# cycle.sh — file-based gate for the gated-delivery skill.
#
#   cycle.sh init <ID>             start a cycle from the plan template
#   cycle.sh approve <ID>          HUMAN ONLY: approve the exact current plan (needs a real terminal)
#   cycle.sh check <ID> <stage>    stage: implement | test | review | done — exits 1 if preconditions are not met
#   cycle.sh status <ID>           show where the cycle stands
#
# Ledger: docs/cycle/<ID>/ (override the root with CYCLE_ROOT). Approval is bound to the
# sha256 of plan.md, so a plan edited after approval no longer authorizes the build.
set -euo pipefail

ROOT="${CYCLE_ROOT:-docs/cycle}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEMPLATES="$HERE/../references"

die() { echo "cycle: $*" >&2; exit 1; }
usage() { sed -n '2,9p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//' >&2; exit 2; }

sha() { if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi; }
now() { date -u +%Y-%m-%dT%H:%M:%SZ; }

valid_id() { [[ "$1" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$ ]]; }
dir_of() { valid_id "$1" || die "invalid cycle id '$1' (letters, digits, . _ - only)"; echo "$ROOT/$1"; }
log() { echo "$(now) $2" >> "$1/ledger.log"; }

# A stage file counts only if it exists and no template placeholder is left in it.
filled() {
  [[ -s "$1" ]] || return 1
  ! grep -q '{{FILL}}' "$1"
}

section_has_text() { # file, heading — true if the section has at least one non-empty line
  awk -v h="$2" '
    $0 == h { on = 1; next }
    /^## / { on = 0 }
    on && $0 !~ /^[[:space:]]*$/ && $0 !~ /^<!--/ { found = 1 }
    END { exit found ? 0 : 1 }' "$1"
}

approval_ok() { # dir
  local d="$1"
  [[ -f "$d/plan.md" ]] || { echo "no plan.md"; return 1; }
  [[ -f "$d/approval.md" ]] || { echo "plan has not been approved by a human (run: cycle.sh approve)"; return 1; }
  local approved current
  approved="$(sed -n 's/^plan_sha256: *//p' "$d/approval.md" | head -1)"
  current="$(sha "$d/plan.md")"
  [[ "$approved" == "$current" ]] || { echo "plan.md changed after it was approved — review it and approve again"; return 1; }
}

findings_ok() { # feedback.md: every '### Finding' block needs all four fields and a valid severity
  awk '
    function flush() {
      if (n == 0) return
      if (!(sc && ex && ac && ev && sv)) bad++
      sc = ex = ac = ev = sv = 0
    }
    /^### Finding/ { flush(); n++; next }
    /^- Scenario:[[:space:]]*[^[:space:]]/ { sc = 1 }
    /^- Expected:[[:space:]]*[^[:space:]]/ { ex = 1 }
    /^- Actual:[[:space:]]*[^[:space:]]/ { ac = 1 }
    /^- Evidence:[[:space:]]*[^[:space:]]/ { ev = 1 }
    /^- Severity:[[:space:]]*(blocker|defect|gap|informational)[[:space:]]*$/ { sv = 1 }
    END { flush(); exit (n > 0 && bad == 0) ? 0 : 1 }' "$1"
}

cmd_init() {
  local d; d="$(dir_of "${1:-}")"
  [[ -e "$d" ]] && die "cycle $1 already exists at $d"
  mkdir -p "$d"
  cp "$TEMPLATES/plan.md" "$d/plan.md"
  log "$d" "init"
  echo "Started $1. Fill in $d/plan.md, then ask the human to approve it."
}

cmd_approve() {
  local d; d="$(dir_of "${1:-}")"
  [[ -t 0 && -t 1 ]] || die "approval needs a real terminal. An agent cannot approve its own plan."
  filled "$d/plan.md" || die "plan.md is missing or still has {{FILL}} placeholders"
  echo "----- $d/plan.md -----"; cat "$d/plan.md"; echo "----------------------"
  local sum; sum="$(sha "$d/plan.md")"
  echo "sha256: $sum"
  read -r -p "Approve this exact plan? Type \"approve $1\" (anything else declines): " answer
  if [[ "$answer" != "approve $1" ]]; then log "$d" "approve declined"; die "not approved"; fi
  printf 'cycle: %s\nplan_sha256: %s\napproved_at: %s\napproved_by: %s\n' "$1" "$sum" "$(now)" "${USER:-unknown}" > "$d/approval.md"
  log "$d" "approved $sum"
  echo "Approved. Any later edit to plan.md invalidates this approval."
}

cmd_check() {
  local id="${1:-}" stage="${2:-}" d; d="$(dir_of "$id")"
  [[ -d "$d" ]] || die "no cycle $id (run: cycle.sh init $id)"
  local why=""
  case "$stage" in
    implement) why="$(approval_ok "$d")" || true ;;
    test)
      why="$(approval_ok "$d")" || true
      if [[ -z "$why" ]]; then
        if ! filled "$d/implementation.md"; then why="implementation.md is missing or still has {{FILL}} placeholders"
        elif ! section_has_text "$d/implementation.md" "## Evidence"; then why="implementation.md has no evidence (command output, test results, file paths) under '## Evidence'"; fi
      fi ;;
    review)
      why="$(approval_ok "$d")" || true
      if [[ -z "$why" ]]; then
        if ! filled "$d/feedback.md"; then why="feedback.md is missing or still has {{FILL}} placeholders"
        elif ! findings_ok "$d/feedback.md"; then why="feedback.md needs at least one '### Finding' and every finding needs Scenario, Expected, Actual, Evidence and Severity (blocker|defect|gap|informational)"; fi
      fi ;;
    done)
      if ! filled "$d/review.md"; then why="review.md is missing or still has {{FILL}} placeholders"
      elif ! grep -Eq '^Verdict:[[:space:]]*(approve|changes-requested|inconclusive)[[:space:]]*$' "$d/review.md"; then why="review.md needs 'Verdict: approve|changes-requested|inconclusive'"; fi ;;
    *) usage ;;
  esac
  if [[ -n "$why" ]]; then log "$d" "check $stage FAILED: $why"; echo "BLOCKED ($stage): $why" >&2; exit 1; fi
  log "$d" "check $stage ok"
  echo "OK ($stage)"
}

cmd_status() {
  local id="${1:-}" d; d="$(dir_of "$id")"
  [[ -d "$d" ]] || die "no cycle $id"
  mark() { if "$@" >/dev/null 2>&1; then echo "yes"; else echo "no"; fi; }
  echo "cycle $id"
  echo "  plan written:    $(mark filled "$d/plan.md")"
  local why; if why="$(approval_ok "$d")"; then echo "  plan approved:   yes (matches current plan.md)"; else echo "  plan approved:   no — $why"; fi
  echo "  implementation:  $(mark filled "$d/implementation.md")"
  echo "  feedback:        $(mark filled "$d/feedback.md")"
  echo "  review:          $(mark filled "$d/review.md")"
}

case "${1:-}" in
  init) shift; cmd_init "$@" ;;
  approve) shift; cmd_approve "$@" ;;
  check) shift; cmd_check "$@" ;;
  status) shift; cmd_status "$@" ;;
  *) usage ;;
esac
