---
name: gated-delivery
title: Gated Delivery Flow
description: Run agent-assisted delivery as a gated cycle — Planner writes a plan, a human approves that exact plan, Developer builds against it, an independent Tester checks it, Lead reviews. Every stage leaves a record with evidence, and a stage that has no record is reported incomplete, not done. Use when building or changing something non-trivial where you want plan approval, evidence over claims, and an independent check; skip for quick one-off edits.
version: 0.1.0
default: false
agents:
  claude-code: { enabled: true }
  codex: { enabled: true }
  opencode: { enabled: true }
  pi: { enabled: false }
tags: [delivery, planning, review, evidence, workflow]
---

# Gated Delivery Flow

A way to run agent work so that "done" has to be earned. One human gate, four roles, and a file ledger that makes each claim checkable.

```
Plan  ->  Approve  ->  Build  ->  Check  ->  Review
Planner   HUMAN        Developer  Tester     Lead
```

## When to use it

Use it for a story, feature, or fix where a wrong turn is expensive: more than a few files, anything touching shared or production behaviour, or work someone else will review. Do not use it for a typo fix or a question; the overhead is not worth it.

## Setup (once per task)

Let `CYCLE` be this skill's script: `<skill dir>/scripts/cycle.sh` (for example `~/.claude/skills/gated-delivery/scripts/cycle.sh` or `~/.codex/skills/gated-delivery/scripts/cycle.sh`). Run it from the project root. Pick a cycle id such as `US-123-R1` (story id plus a revision suffix).

```bash
"$CYCLE" init US-123-R1      # creates docs/cycle/US-123-R1/plan.md from the template
```

The ledger lives in `docs/cycle/<id>/`: `plan.md`, `approval.md`, `implementation.md`, `feedback.md`, `review.md`, `ledger.log`. Templates are in `references/`. Commit the ledger if you want an audit trail.

## The roles

You may be one agent playing all roles in turn, or several. What matters is **independence**: the Tester must not be the context that wrote the code.

- **Claude Code:** run Planner, Developer and Tester as separate subagents (fresh context each); the main session is Lead. If subagents are unavailable, use a new session for the Tester.
- **Codex:** run each role as its own `codex exec` invocation (or a fresh session), passing only what that role needs. Do not carry the Developer's reasoning into the Tester run.

### Planner
Read the real inputs first (the story, the code, related issues) and look up anything discoverable yourself. Ask the human only genuine decisions, **one question at a time, each with a recommended default**, until no branch is open. Then fill `plan.md`: goal, scope (in and out), assumptions (mark unverified ones), ordered steps, acceptance criteria, positive/negative/edge test ideas, risks, open decisions. Do not write code.

### The human gate
Present the plan and stop. The human reviews it and runs `"$CYCLE" approve <id>` in a real terminal. The script refuses without one, so an agent cannot approve its own plan. **Never create or edit `approval.md` yourself.** Approval is bound to the sha256 of `plan.md`: if the plan changes afterwards, the approval no longer counts and the human must approve again.

### Developer
Before building, run `"$CYCLE" check <id> implement`. If it is blocked, stop and say why; do not work around it. Build only what the approved plan says. If scope has to change, write a new plan revision (`US-123-R2`) and get it approved; do not edit the plan quietly. Fill `implementation.md`: what changed (mapped to plan steps), **evidence** (real command output, test results, file paths), and deviations. A sentence saying something works is not evidence.

### Tester
Run `"$CYCLE" check <id> test`, then work **only from the approved plan and the real diff**, not from the Developer's summary. Run the tests and the scenarios yourself. Record each finding in `feedback.md` with scenario, expected, actual, evidence, and severity (`blocker`, `defect`, `gap`, `informational`). List what you could not check. If you cannot see the diff or the plan, say so; do not guess.

### Lead
Run `"$CYCLE" check <id> review`, then review the final diff for correctness, scope against the plan, and over-engineering. Fill `review.md` ending with `Verdict: approve`, `changes-requested`, or `inconclusive`. **Use `inconclusive` when you could not verify something**; do not invent a review. If changes are requested, route back to the Developer and repeat Check and Review. Finish with `"$CYCLE" check <id> done`.

## Rules that do the work

1. **Evidence, not narration.** A claim ("tests pass", "recorded") only counts with something a reader can verify: output, a path, a row. The scripts check that the records exist and are filled in; you check that they are true.
2. **Approval is bound to the exact plan.** Edited plan, new approval.
3. **A stage with no record is `incomplete`, not done.** Report it plainly. Some tasks legitimately produce no record, but say so rather than rounding up.
4. **Independent checking.** The role that built it does not grade it.
5. **External writes are previewed.** Anything that leaves the repo (a ticket, a PR comment, a chat message) is shown to the human as the literal text first, and only posted after an explicit yes.
6. **Keep records outcome-focused.** What was decided, built, found. Not a narration of how you worked.

## Checking where you are

```bash
"$CYCLE" status <id>
```

## What this skill can and cannot enforce

The scripts enforce the file-level gates: the approval hash, the presence and completeness of each stage's record. They cannot stop an agent from editing files outside the cycle or from writing a false claim into a record. That is what the independent Tester and the human gate are for. If you need code-level enforcement (recorded tool-call receipts, write gates), that needs a harness that provides it; this skill is the portable process contract.

## Quick start prompt

> Use the gated-delivery skill for `<story or task>`. Start cycle `<ID>-R1`, interview me one question at a time to build the plan, then stop at the approval gate.
