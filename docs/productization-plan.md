# Jay Pi: productization plan — HARNESS-PRODUCT-R1

Status: frozen implementation baseline, 23 October 2026. Changes to this scope should be documented as explicit revisions rather than silently expanding it.

## Product thesis

**A local, evidence-first process engine for human-approved agent work.** Keep the existing Planner → human approval → Developer → independent Tester → Lead review lifecycle, separate provider subprocesses, SQLite cycle records, and the distinction between narration and verified tool activity. Make the engine usable independently of pi without maintaining a second execution implementation.

This is not a company operating system, hosted agent service, multi-tenant scheduler, or a promise of an OS sandbox. The strongest first product is an inspectable engine with a repeatable offline demonstration and a clear extension contract. Kylon's human/agent collaboration framing is useful inspiration, not a reason to copy its platform breadth.

## Authorization and constraints

The user explicitly requested a separate branch, full creative freedom, provider agnosticism, and an overnight working result. That supplies task-level authority for this development cycle; it does **not** authorize weakening the product's runtime human approval gates. Main remains untouched. No paid calls, live provider runs, external tracker writes, credential changes, global installation, production deployment, or release publication during development. Tests use controlled fixture subprocesses and temporary directories.

Existing `AGENTS.md` role ownership and evidence conventions remain the design basis. Native Planner/Developer/Tester delegation is used where available; this environment does not expose the installed pi tools. The existing `writeCycleRecord` implementation requires a `sqlite3` executable, absent at initial inspection. No Approach row or `record_cycle` invocation is claimed until a real supported write succeeds. Do not manufacture SQL records to look compliant.

## Baseline and evidence-based gap map

Baseline commit: `238d235`. Main runtime is TypeScript pi extensions; shared cycle persistence is `extensions/cycle-store.mjs`. Existing MCP server uses the official MCP SDK. There is no root package manifest, automated test suite, or CI workflow.

| Priority | Evidence | Gap and required outcome |
|---|---|---|
| P0 | `lifecycle-subagent/index.ts`, `RECORD_CYCLE_MCP_SERVER_PATH` resolves `./mcp/...` from the lifecycle directory; actual server is under `extensions/mcp/` | Correct package-relative resolution and test installed and checkout layouts. |
| P0 | `plan-approval.ts`, `execute` checks `ctx.hasUI`, then inserts immediately | Presence of UI is not human consent. Show the exact selected plan and require actual confirmation. Decline/noninteractive cannot approve. |
| P0 | `plan-approval.ts`, supplied `approachRowId` is inserted without existence check | Reject nonexistent/future row IDs. Bind approval to current immutable plan identity and recheck after confirmation before inserting. |
| P0 | `lifecycle-subagent/index.ts`, `getArtifactPath`, cleanup and load | Validate run identifiers and derive filesystem paths; do not trust persisted `artifactPath` for deletion. Prevent traversal and cleanup of active runs. |
| P0 | `saveRun` directly overwrites JSON; parse errors disappear as unknown records | Atomic same-directory write/rename, schema/version checks, useful corruption diagnostics. Never silently turn corrupt state into successful or absent work. |
| P0 | child `close` uses `code ?? 0` | Signal termination must not become success. Preserve `canceled` against asynchronous close updates; classify spawn failures and provider errors consistently. |
| P0 | `cancel` can signal persisted PID even for terminal run | Never signal stale/reused PIDs blindly. Only cancel owned active children, or require verified ownership. Terminal cancellation is idempotent and does not rewrite status. |
| P0 | Claude always passes `--dangerously-skip-permissions`; `scopedEnv` clones all environment | Remove implicit permission bypass. Explicit runtime policy and environment allowlist with documented compatibility migration. Fail closed on unsupported policy. |
| P0 | project-agent trust check only runs when `ctx.hasUI` is true | Untrusted project prompts cannot silently run in headless mode. Explicit trusted configuration or refusal. |
| P1 | `spawnPiAgent` and `spawnClaudeAgent` duplicate process handling and normalize inline | Extract adapter interface and shared process runner, used by pi extension and CLI. Provider parsing must not define lifecycle truth. |
| P1 | `hasSuccessfulCycleRecord` matches any tool suffix and stage only | Tighten supported tool names and correlate run/cycle/stage with structured successful evidence when available. A claimed prose write or wrong-stage event remains incomplete. |
| P1 | `cycle-store.mjs` shells to sqlite3 with unvalidated JS inputs | Shared typed/validated persistence API, parameter binding where possible, useful errors, existing DB schema retained. Node 24 built-in SQLite removes the external binary dependency for the standalone CLI; preserve a documented legacy extension compatibility path only if needed. |
| P1 | full traces/stderr/raw stdout accumulate with no bound | Bound parsing buffers and retained output, record truncation explicitly, redact configured sensitive values, preserve final result and stage proof. |
| P1 | `external-sink-gate.ts` malformed configuration means no gated tools | Distinguish absent optional config from invalid configured policy; invalid policy must warn/refuse rather than silently disable protection. |
| P1 | crash recovery uses PID liveness, only during interactive startup | Expose read-only status and deliberate recovery inspection; track supervisor identity. Never auto-replay a potentially side-effecting run. |
| P1 | `profile.ts` and profile UI hard-code two runners | Add capability-aware registry; do not advertise an adapter solely because its name is accepted. |
| P1 | `install.sh` installs missing pi despite skip flag and continues without SQLite | Honor skip semantics and offer non-mutating doctor checks. Do not run installer in development. |

## Architecture: one engine, multiple entry points

Extract small, focused modules under `extensions/harness/` as `.mjs` modules copied by the existing installer, retaining existing external contracts wherever feasible:

1. **Types and validation:** versioned run record, normalized provider events, role/stage map, policy and capability types. Run IDs generated securely and accepted only in canonical form; legacy IDs may be read through a narrow compatibility path.
2. **Persistence:** one durable run-store API for atomic snapshots, listing, diagnostics, and terminal transitions. Preserve `data/subagent-runs`, cycle DBs, and `history.jsonl`; avoid a second competing task database. SQLite remains authoritative for stage records. Events include run/cycle/provider/status metadata but not credentials.
3. **Approval service:** shared plan reading and approval validation. Presentation and human confirmation stay in trusted entry points, not model-callable provider APIs. Pin row/content identity and fail on revision races. An approval records authorization for a plan, not universal authority to all tools.
4. **Adapters:** pi, Claude CLI, and Codex CLI implement command construction and stream normalization against a declared capability contract. Shared process runner owns timeout, bounded streams, cancellation, lifecycle transitions, cleanup, and persistence.
5. **Engine:** resolves role/profile, enforces prerequisites, starts a distinct subprocess, consumes normalized events, verifies stage evidence, and exposes run/status/result/cancel/recovery operations. Never mark a clean exit completed for a lifecycle role missing actual stage proof.
6. **Entry points:** existing pi tools remain thin wrappers. Add a small `jay-pi` CLI for doctor, catalog, runs/status/show, and safe demo. Run/approval commands may be added only when they call the same engine and preserve confirmation boundaries. Library exports allow integration without adding a network server.

Prefer readable modules and Node's built-in test runner over a framework migration. Do not require React, a web server, an ORM, Redis, or a hosted database. CLI output plus JSON export is enough for an end-to-end product demo. If UI is added later it needs actual browser QA, not compile-only evidence.

### Provider support honesty

- **pi:** existing supported execution path; preserve JSON messages and role prompts. Fixture coverage does not substitute for a live authenticated smoke test.
- **Claude CLI:** existing execution path; repair MCP resolution and permission handling. Normalize supported stream-json events; unexpected protocol must fail diagnostically or remain incomplete, not silently succeed.
- **Codex CLI:** implement only against current official documented CLI/protocol. Use explicit sandbox/approval settings and record-cycle MCP wiring if the installed CLI supports an isolated config. If faithful structured stage evidence or permission isolation is not available, ship a clearly marked experimental adapter or capability refusal, not a fake successful integration. Do not silently fall back to pi.
- **Mock/fixture:** first-class offline testing/demo provider, conspicuously labeled non-LLM. Never count mocked calls as live integration validation.

Provider names and capability metadata must flow through discovery/profile/CLI coherently. Model selection is user configuration, not a hard-coded promise of current availability. Exact command flags and external interfaces require official-source verification before implementation.

### Trust boundaries

This harness is a workflow controller on a trusted local machine. A child with unrestricted filesystem/shell access can edit its own records; an audit ledger is not a tamper-proof security boundary. Configuration gates intercept only controlled entry points, not arbitrary network writes from shell. State this clearly and stop using absolute “unbypassable” claims where the runtime cannot enforce them.

Default policy should minimize inherited environment and avoid all permission-bypass flags. Provider auth/config requirements must be explicit. Never silently resolve compatibility problems by passing the entire parent environment or enabling dangerous execution. Approval tokens/records should not be writable through provider-facing interfaces. True hostile-agent isolation is a future OS/container capability, not a string in a config file.

## Frozen module boundary and API sketch

Names below are the agreed implementation seam, not a second system. Owners may refine argument fields together before coding; report any material scope revision.

- `extensions/cycle-store.mjs`: preserve `writeCycleRecord({ cwd, stage, summary, data?, cycleId? })` result contract and stage DB schema; add safe read helpers. Shared by pi tool, MCP server, demo, and CLI. Node 24 standalone baseline.
- `extensions/harness/approval-store.mjs`: `getLatestApproach(cwd)`, `approveApproach(cwd, rowId, { confirmed, actor, expectedDigest })`, `isApproachApproved(cwd, rowId)`; row lookup uses `readCycleRecord` from the cycle store. Low-level write API is trusted-host only; pi/CLI must show the selected content and obtain explicit human confirmation before calling it. Never expose approval as a child provider tool.
- `extensions/harness/run-store.mjs`: `createRunStore(cwd)` exposes `createRun(...)`, `readRun(cwd, runId)`, `listRuns(cwd)`, atomic `saveRun(record)`, `transitionRun(runId, expectedState, nextState, details)`, and recovery inspection. Derive paths from cwd/runId, validate records, preserve legacy artifact compatibility.
- `extensions/harness/adapters.mjs`: adapter registry with `{ id, capabilities, buildInvocation(context), createParser(context) }`. Invocation is `{ command, args, env, stdin?, cleanup? }`; parser emits normalized message/tool-result/usage/error events. No shell interpolation. Capability refusal precedes child launch.
- `extensions/harness/runtime.mjs`: `createHarness({ cwd })` exposes `startRun({ agent, task, cycleId?, previousRunId?, policy?, onEvent? })`, returning `{ runId, completion, cancel }`; completion resolves to persisted terminal record. Export read/list/result/recovery functions or reuse store exports. Runtime owns proof-based completion, timers, streams, active-child ownership, and resource cleanup. Provider adapters do not set run status themselves.
- `extensions/lifecycle-subagent/index.ts`: retain current pi tool names/actions and result shape; delegate execution and persistence to shared modules. Keep pi-specific UI, confirmation, profile resolution and auto-handoff here.
- `bin/jay-pi.mjs`: thin CLI over the same core, root package scripts, doctor/status/show/demo commands. JSON mode for machine consumption; no network listener.

Implementation ownership: storage/approval developer owns cycle store and approval foundation; runtime developer owns runtime/adapters and lifecycle wrapper; engineering lead owns CLI/package/demo/docs and profile integration. Coordinate signatures before overlapping edits. Independent tester owns verification rather than implementation.

Additional verified gap: profile resolution currently selects a whole profile while documentation promises field-by-field session > project > global merging; repair and regression-test with mixed partial role configurations. Pi error stop reasons must also prevent clean-exit completion.

## Ordered implementation slices

1. Establish root package scripts, supported Node version, test fixtures, and temporary-directory helpers. Capture regression tests for identified defects before broad refactoring.
2. Repair plan confirmation, MCP path, run-path safety, terminal transition handling, and project-agent trust. Keep these changes independently reviewable.
3. Extract storage/approval/evidence modules; preserve SQLite and existing run artifacts. Introduce stable exports and compatibility tests.
4. Extract provider normalization and shared process lifecycle; wire the existing pi extension to them, proving no duplicate execution engine remains.
5. Add Codex capability only to the extent safely implementable and fixture-verifiable. Validate permission/environment policy for every adapter.
6. Add doctor/status/demo CLI. Demo runs a deterministic Planner → approval boundary → Developer → Tester → Lead sequence in a temporary workspace; also demonstrates wrong-stage/missing-record incomplete, declined approval, cancellation, and crash inspection. No account or global install required.
7. Update README, architecture/security/provider support matrix, migration notes, and morning walkthrough. Add CI running offline tests and syntax/type checks as appropriate.
8. Independent Tester pass plus Lead correctness/security/complexity review. Record stage evidence through the shared supported tool/store, identify any never-run checks. Review final diff, commit subjects/identity and secrets before authorized branch push/draft PR.

If time is constrained, deliver slices 1–4 and a credible CLI demo before expanding providers. A smaller real engine is preferable to a broad integration facade.

## Acceptance criteria and test matrix

- One documented command runs the offline suite on a clean checkout; no credentials/network calls required by tests.
- Correctly recorded role completes; prose-only claim, wrong stage, failed tool result, unrelated tool suffix, and absent evidence are incomplete.
- Approval is denied without real confirmation; decline leaves no row; future/nonexistent row rejected; revised plan invalidates prior authorization; revision during prompt cannot approve stale content silently.
- Input run IDs containing separators, `..`, absolute paths, and malformed values cannot read/write/delete outside run storage. Persisted arbitrary artifact paths cannot drive deletion.
- Atomic snapshots remain valid under interrupted writes; malformed/truncated/unsupported-version state yields an explicit diagnostic. Legacy records remain readable or produce documented migration guidance.
- Cancel is idempotent; terminal runs never become canceled later; no kill of unowned persisted PID; timeout/signal/spawn errors do not become completed. Temporary files are cleaned on every terminal path.
- Unknown/unsupported provider or capability fails before launch. Every supported adapter's argv, env, stdin, parser, final result and error normalization are fixture-tested, including malformed JSON, fragmented lines, trailing non-newline, large stderr, and provider-declared error on process exit zero.
- Default environment does not leak an unrelated `EXAMPLE_SECRET`; no unsafe permission bypass flag appears by default. Headless project-agent execution requires explicit trust.
- `doctor` is non-mutating and reports missing CLI/runtime/MCP prerequisites distinctly. CLI JSON output has stable shape and exit codes; human output is useful without requiring raw trace inspection.
- Demo uses actual shared lifecycle/persistence modules and shows inspectable stage records and outcome evidence, not canned screenshots or manually fabricated final state.
- Installer compatibility checks use a temporary HOME and stubbed official commands; never touch user's real install.
- Final report separates passed automated tests, fixture-validated adapter contracts, never-run live integrations, and known limitations.

## Deliverables and stop condition

A reviewed feature branch with a working offline demo, regression suite, shared reusable engine exercised by the existing pi entry point, safe defaults and honest limitations, plus a concise morning walkthrough. Keep optional paid Jev integration inert. No automatic merge, publish, or deployment. Stop implementation when acceptance criteria are verified or an exact authorization/access blocker remains; do not manufacture provider support or test success.

## Named implementation refinements

The runtime factory is `createHarness({ cwd })`; approval persistence is `approval-store.mjs`; run storage is `run-store.mjs`. These names refine the original seam without changing product scope. The Approach capture is intentionally delayed until the Node 24 SQLite store repair enables the supported `writeCycleRecord` API. Its database `created_at` is the actual execution time, not a backdated planning or approval timestamp. No runtime approval is fabricated for this engineering cycle.
