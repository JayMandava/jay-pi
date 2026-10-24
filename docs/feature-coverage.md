# Feature coverage and remaining checks

This is a feature inventory, not a claim of exhaustive correctness. Tests exercise
specific cases; passing fixtures do not certify a vendor, a sandbox, or every UI
interaction. Run `npm test` and `npm run check` against the final checkout; see
[verification](verification.md) for the dated aggregate result and
[functional testing](functional-testing.md) for fixture mechanics.

Independent final run for `HARNESS-FEATURE-QA-R1` (24 October 2026, Linux,
Node 24): **151 tests passed, zero failures/skips**, plus syntax and TypeScript
checks and `git diff --check`. This includes real local PTY transport, not a
live human or authenticated vendor session.

## Evidence levels

- **Unit/API:** production functions or extension callbacks with controlled inputs;
  a fake UI host is not an actual pi terminal session.
- **Process:** actual local executable/controller/stdio boundary and persistence.
- **Provider stub:** production adapter launching repository-owned fake vendor
  executable. No authenticated model execution.
- **Gap:** no direct automated behavioral evidence identified in this inventory.
  Type checking alone does not count as functional coverage.

All test paths below are relative to `tests/`. Named cases identify assertions,
not merely code that happens to run.

## Shared engine and records

| Shipped feature | Specific evidence | Level and limit |
|---|---|---|
| Planner → approved Developer → Tester → Lead | `runtime.test.mjs`: “full four-role lifecycle”; `provider-process.test.mjs`: “approved four-stage lifecycle” for pi/Claude/Codex | Process + provider stub; approvals are synthetic trusted-host calls |
| Exact latest-plan approval, digest and revision binding | `approval.test.mjs`: explicit actor/confirmation/digest, in-place mutation, legacy approval/replay; `provider-boundary-independent.test.mjs`: plan revision and wrong cycle refused before dispatch | API + provider-stub prelaunch; not remote identity |
| One Developer at a time | `runtime.test.mjs`: “single Developer lease”; `independent-runtime.test.mjs`: dead/live lease and surviving orphan child | API/process; not distributed scheduling |
| Completed versus incomplete/failed | `runtime.test.mjs`: absent/wrong-stage/failure/malformed/signal cases; `provider-process.test.mjs`: missing/wrong/rejected evidence, error and nonzero exit after receipt | Process + provider stub |
| Proof bound to real stage/run/cycle/row/tool | `runtime.test.mjs`: “proof rejects narration, stale receipts, wrong cycle and untrusted tool names”; `independent-runtime.test.mjs`: nonexistent/wrong-stage persisted row | API with actual SQLite; representative provider traces |
| SQLite stage schemas, role derivation and correlation | `cycle-store.test.mjs`: all-stage roundtrip, malformed input, additive migration, concurrent controller append | API + actual controller processes |
| Local audit history | `cycle-store.test.mjs`: four writes produce four history entries | API; only record-write count directly asserted, not every grill/approval history detail |
| Private storage and path boundaries | `cycle-store.test.mjs`: private modes and linked data/DB/journals; `approval.test.mjs`: linked ATTACH refusal; `independent-runtime.test.mjs`: linked runs; `runtime.test.mjs`: traversal/artifact tampering | Real filesystem, Linux; no hostile same-user isolation |
| Run state, terminal outcomes and corruption | `runtime.test.mjs`: corrupt state settles, spawn failure; `independent-runtime.test.mjs`: corrupted running snapshot | API/process; no crash-consistency proof for every filesystem failure |
| Cancellation, timeout, bounded output | `runtime.test.mjs`: cancel/close, timeout/overflow and foreign cancel; `provider-process.test.mjs`: cancel/timeout per adapter | Process + provider stub |
| Separate-controller cancellation | `provider-boundary-independent.test.mjs`: “foreign controller requests persisted cancellation” for all three providers | Actual separate owner process + provider stub; not two objects in one process |
| Interrupted controller and no automatic replay | `provider-boundary-independent.test.mjs`: interrupted Claude controller; `runtime.test.mjs`: recovery never signals stored PID/retries; CLI demo recovery | Actual interrupted controller; common recovery path, not every provider/OS combination |
| Explicit context continuation | `runtime.test.mjs`: terminal context/no replay; `provider-boundary-independent.test.mjs`: exact approved plan preserved for all three adapters | Process + provider stub; deliberately not native provider resume |
| Cleanup and child-close race | `runtime.test.mjs` and `independent-runtime.test.mjs`: live cleanup denied/cancel then cleanup | API/process; cleanup exists in runtime/pi, not standalone CLI |

## Provider contract

| Shipped feature | Specific evidence | Level and limit |
|---|---|---|
| Correct provider selection and invalid identifiers | `provider-boundary-independent.test.mjs`: inherited keys/nonstring rejection, omitted runner defaults pi | API + isolated refusal executable; regression for accidental Codex fallback |
| argv/stdin, role/task/model delivery, no shell evaluation | `adapters.test.mjs`: policy/argv construction; `provider-process.test.mjs`: captured invocation and literal shell-like task | Provider stub; vendor flag acceptance not proven |
| Read-only/default, explicit edits, unsupported capabilities | `adapters.test.mjs`: pi/Claude/Codex profiles; `provider-boundary-independent.test.mjs`: resume/isolation/unsafe rejection | API + provider stub; actual sandbox behavior unverified |
| Allowlisted environment and redaction | `adapters.test.mjs`: injection variables absent; `provider-process.test.mjs`: captured allow/deny; `independent-pi.test.mjs`: escaped forwarded secret redaction | API/process; HOME credentials remain accessible; arbitrary secrets cannot all be recognized |
| Fragmented streams, errors, usage/cost | `adapters.test.mjs`: errors/metrics; `runtime.test.mjs`: fragmented Unicode/no newline; `provider-process.test.mjs`: fragmented events and usage | Representative fixtures, not live captured vendor sessions |
| Claude/Codex MCP configuration and record tool | `mcp.test.mjs`: actual stdio initialize/catalog/receipt; `provider-process.test.mjs`: generated JSON/TOML parsed and real MCP server invoked | Actual MCP process/SQLite + fake vendor client |
| Temporary prompt/MCP config removal | `provider-process.test.mjs`: successful-cycle artifact cleanup assertions | Provider stub; not every interruption point |

## CLI and pi frontend

| Shipped feature | Current evidence | Level and remaining gap |
|---|---|---|
| CLI help and offline doctor | `cli.test.mjs`: “help and doctor are offline and usable” | Actual CLI subprocess |
| CLI argument rejection | `cli.test.mjs`: unknown/incomplete options and invalid timeout | Actual CLI subprocess; not an exhaustive parser matrix |
| CLI exact-phrase approval and refusal | `cli.test.mjs`: piped input refusal; `cli-e2e.test.mjs`: actual PTY approval, decline/wrong phrase/interruption, JSON, stale row and revision-during-prompt refusal | Actual CLI/PTY with synthetic keystrokes, not human consent |
| CLI nine-scenario demo | `cli.test.mjs`: persisted lifecycle/failure outcomes | Actual CLI + mock provider; synthetic approval |
| CLI run/list/status/result/events/plan/recover surfaces | `cli-e2e.test.mjs`: four-role cycle inspection, event sequence, negative arguments, exit codes, SIGINT and interrupted-controller recovery | Actual CLI + provider stub; both human output and JSON assertions |
| Pi approval tool | `approval.test.mjs`: headless/declined dialog, full plan display, change during dialog | Actual callback + fake UI; not actual TUI human interaction |
| Pi project trust and abort-before-launch | `independent-pi.test.mjs`: headless project refusal, already-aborted foreground invocation | Actual wrapper + controlled host/stub process |
| Pi catalog/status/result/cancel/cleanup, foreground updates, background auto-handoff, startup sweep | `pi-frontend-e2e.test.mjs`: foreground roundtrip, background handoff/cancel/bulk cleanup, interactive-only recovery and command listing | Actual wrapper callbacks + fake host/UI + provider subprocess; no actual TUI |
| Pi edits/environment dialogs and abort during confirmation | `pi-frontend-e2e.test.mjs`: accepted/refused trust/edit/env gates, canceled approval and project confirmation | Callback/API + fake UI; neither human identity nor rendered terminal |
| Layered session/project/global profiles | `profile.test.mjs`: field merges, clear semantics, invalid files, no-state default | Unit/API; `pi-frontend-e2e.test.mjs` also covers command show/use/dismiss/error/clear; full edit wizard/model discovery not exercised |
| Model-scope matching | `model-patterns.test.mjs`: exact/wildcard/thinking suffix/literal regex | Unit; real model availability not checked |
| External sink payload gate | `external-sink.test.mjs`: absent/malformed policy, literal approval/decline, headless and oversize denial, reread | Actual callback + fake UI; no tracker/network writes |
| Installer compatibility | `install.test.mjs`: temporary HOME, preserved config, copied shared engine, skip flags | Actual shell script + stub npm/pi; real global installation/patching not performed |

## Other documented repository features

These features are inventoried separately so core runtime coverage is not
mistaken for whole-repository UI or external-service certification.

| Feature | Specific evidence and remaining limit |
|---|---|
| `grill` required recommendation, one-question UI, cancel and history | `legacy-extensions.test.mjs`: required schema field, headless/invalid rejection, answer/dismissal, literal suffix/ambiguous labels, parallel-question/cancellation refusal and audit events; fake selector, not actual TUI |
| AGENTS.md freshness warning | `legacy-extensions.test.mjs`: absent/new/resumed/changed/untracked and non-TUI paths; isolated process/HOME |
| Subagent status ticker | `legacy-extensions.test.mjs`: synthetic-record filtering, fixed-height render strings, refresh/remove; `pi-frontend-e2e.test.mjs` additionally starts a real hanging fixture run, reads its persisted sessionId, checks same-session visibility/other-session hiding and removal after cancel; no actual terminal rendering |
| Token-rate footer | `legacy-extensions.test.mjs`: non-assistant/near-zero filtering and completed throughput; fake clock/UI |
| TUI console guard | `legacy-extensions.test.mjs`: TUI-only wrapping, log output, URL notification, reload/restore; mock-timer error-burst batching/cooldown, rotation and stale UI handling also asserted; no actual terminal rendering |
| Optional Jev checker | `legacy-extensions.test.mjs`: no-key/irrelevant-event no-op, mocked fetch failure and malformed JSON preserve tool result; no live response/auth/billing or successful classifier DB roundtrip |
| Content-anchored patcher | `legacy-extensions.test.mjs`: actual patcher process on disposable fake package, unique/idempotent/ambiguous/missing anchors; not installed pi core |
| Self-heal/reapply wrappers | Installer test explicitly disables patches; real global self-heal/reapply flow not run |
| Model-provider configuration walkthrough | Documentation, not a live self-hosted endpoint test |
| Static presentation deck | Not part of runtime suite; no visual QA in this pass |

## Supervised live checklist (not executed)

1. Use a disposable repository and isolated user configuration. Record exact OS,
   Node, pi/Claude/Codex and MCP SDK versions; inspect managed settings.
2. Obtain explicit authorization for account/model usage and any costs. Do not
   repair authentication by broadening environment inheritance or bypass flags.
3. Run a tiny read-only Planner on each installed provider. Verify the real
   event stream, `record_cycle` tool result, correlated SQLite row and final status.
4. Review a plan in the actual CLI TTY/pi UI. Decline once; approve the exact
   current plan; revise it and verify the old approval no longer authorizes work.
5. Only with explicit edit authorization, run a tiny Developer change; then
   independent Tester and Lead. Inspect files, approval identity and every receipt.
6. Exercise real pi background handoff, visible status, cancel, output/result and
   cleanup. Interrupt the controller; inspect partial work before manual retry.
7. Verify target-machine permission behavior and provider error/auth-expiry
   reporting. Separately validate Windows process-tree handling if required.

Stop on unexpected account access, effects outside the disposable workspace or
permission widening. A green offline suite does not authorize any live step.
