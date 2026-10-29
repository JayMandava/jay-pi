#!/usr/bin/env bash
# Self-test for cycle.sh. Runs in a temp directory; touches nothing else.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CYCLE="$HERE/cycle.sh"
WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT
cd "$WORK"; export CYCLE_ROOT="$WORK/docs/cycle"
pass=0; fail=0
ok()   { pass=$((pass+1)); echo "  ok   $1"; }
bad()  { fail=$((fail+1)); echo "  FAIL $1"; }
expect_ok()   { local name="$1"; shift; if "$@" >/dev/null 2>&1; then ok "$name"; else bad "$name"; fi; }
expect_fail() { local name="$1"; shift; if "$@" >/dev/null 2>&1; then bad "$name"; else ok "$name"; fi; }
# Run a command under a real pseudo-terminal, feeding it one line of input.
with_tty() { python3 - "$1" "${@:2}" <<'PY'
import os, pty, sys, select
answer, argv = sys.argv[1], sys.argv[2:]
pid, fd = pty.fork()
if pid == 0:
    os.execv(argv[0], argv)
os.write(fd, (answer + "\n").encode())
while True:
    r, _, _ = select.select([fd], [], [], 5)
    if not r: break
    try:
        if not os.read(fd, 4096): break
    except OSError: break
_, status = os.waitpid(pid, 0)
sys.exit(os.waitstatus_to_exitcode(status))
PY
}
fill() { sed -i.bak 's/{{FILL}}/filled in/g' "$1" && rm -f "$1.bak"; }
ID=T-1

expect_ok   "init creates a cycle"                       "$CYCLE" init $ID
expect_fail "init twice is refused"                      "$CYCLE" init $ID
expect_fail "path traversal id is refused"               "$CYCLE" init ../escape
expect_fail "id with slash is refused"                   "$CYCLE" init a/b
expect_fail "implement blocked before approval"          "$CYCLE" check $ID implement
expect_fail "approve refuses without a terminal"         "$CYCLE" approve $ID
expect_fail "approve refuses an unfilled plan"           with_tty "approve $ID" "$CYCLE" approve $ID
fill "$CYCLE_ROOT/$ID/plan.md"
expect_fail "declining leaves no approval"               with_tty "no" "$CYCLE" approve $ID
[[ ! -f "$CYCLE_ROOT/$ID/approval.md" ]] && ok "no approval file after decline" || bad "approval file exists after decline"
expect_ok   "approve with the exact phrase"              with_tty "approve $ID" "$CYCLE" approve $ID
expect_ok   "implement allowed after approval"           "$CYCLE" check $ID implement
echo "extra scope" >> "$CYCLE_ROOT/$ID/plan.md"
expect_fail "editing the plan voids the approval"        "$CYCLE" check $ID implement
expect_ok   "re-approving the revised plan"              with_tty "approve $ID" "$CYCLE" approve $ID
expect_ok   "implement allowed again"                    "$CYCLE" check $ID implement

expect_fail "test blocked without implementation.md"     "$CYCLE" check $ID test
cp "$HERE/../references/implementation.md" "$CYCLE_ROOT/$ID/implementation.md"
expect_fail "test blocked with placeholders"             "$CYCLE" check $ID test
fill "$CYCLE_ROOT/$ID/implementation.md"
expect_ok   "test allowed with evidence"                 "$CYCLE" check $ID test
python3 - "$CYCLE_ROOT/$ID/implementation.md" <<'PY'
import sys,re
p=sys.argv[1]; s=open(p).read()
s=re.sub(r"(## Evidence\n)[^\n]*\n", r"\1\n", s); open(p,"w").write(s)
PY
expect_fail "test blocked when evidence is empty"        "$CYCLE" check $ID test

expect_fail "review blocked without feedback.md"         "$CYCLE" check $ID review
cp "$HERE/../references/feedback.md" "$CYCLE_ROOT/$ID/feedback.md"
fill "$CYCLE_ROOT/$ID/feedback.md"
expect_fail "review blocked on an invalid severity"      "$CYCLE" check $ID review
sed -i.bak 's/^- Severity: filled in/- Severity: gap/' "$CYCLE_ROOT/$ID/feedback.md" && rm -f "$CYCLE_ROOT/$ID/feedback.md.bak"
expect_ok   "review allowed with a complete finding"     "$CYCLE" check $ID review
sed -i.bak '/^- Evidence:/d' "$CYCLE_ROOT/$ID/feedback.md" && rm -f "$CYCLE_ROOT/$ID/feedback.md.bak"
expect_fail "review blocked when a finding lacks evidence" "$CYCLE" check $ID review

expect_fail "done blocked without review.md"             "$CYCLE" check $ID done
cp "$HERE/../references/review.md" "$CYCLE_ROOT/$ID/review.md"; fill "$CYCLE_ROOT/$ID/review.md"
expect_fail "done blocked on an invalid verdict"         "$CYCLE" check $ID done
sed -i.bak 's/^Verdict: filled in/Verdict: approve/' "$CYCLE_ROOT/$ID/review.md" && rm -f "$CYCLE_ROOT/$ID/review.md.bak"
expect_ok   "done allowed with a valid verdict"          "$CYCLE" check $ID done
expect_ok   "status runs"                                "$CYCLE" status $ID
[[ -s "$CYCLE_ROOT/$ID/ledger.log" ]] && ok "ledger records every event" || bad "ledger empty"
grep -q "FAILED" "$CYCLE_ROOT/$ID/ledger.log" && ok "ledger records failed checks too" || bad "ledger missing failures"

echo; echo "$pass passed, $fail failed"
[[ $fail -eq 0 ]]
