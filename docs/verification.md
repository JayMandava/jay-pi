# Verification report — HARNESS-PRODUCT-R1

24 October 2026, Linux cloud workspace, Node v24.19.0. Baseline: `238d235`.

## Passed

- **115 automated tests**, zero failures/skips, using `npm test`.
- JavaScript/TypeScript syntax checks and full extension TypeScript compilation against pinned pi 1.4.0 dependencies: `npm run check`.
- Actual record-cycle MCP stdio initialization, tool catalog and successful/invalid calls against the official SDK/server; persisted run/cycle receipt verified.
- Actual offline CLI demonstration: Planner, Developer, Tester and Lead complete with real SQLite records; missing/wrong-stage proof remains incomplete; failure, cancellation and interrupted-controller recovery have truthful terminal outcomes.
- Installer fixture under temporary HOME preserves existing config, honors skip flags and does not install/update global pi or apply patches.
- `git diff --check`.

## Provider process-boundary follow-up — HARNESS-STUB-R1

48 additional tests exercise real adapter dispatch against isolated fake pi/Claude/Codex executables and independently verify host boundaries. Each provider completes a four-role cycle; Claude/Codex read the actual generated MCP configuration and launch the real record-cycle server. Negative cases include missing/wrong/rejected evidence, malformed streams, nonzero exits after valid receipts, provider errors, signals, cancellation/timeouts, stale approvals, unsupported capabilities and a separate-controller crash recovered without replay. Exact argv/stdin/environment/profile/temporary-file and persisted-proof assertions are included. See [functional testing](functional-testing.md).

Independent QA found and regression-tested a real dispatch defect: JavaScript inherited property names could bypass provider validation and fall through to Codex. All three entry points now require an own string registry key; explicit invalid values no longer silently default. The final run passed all 115 tests without skips, 44-file syntax checks, full TypeScript checking and the nine-scenario offline demonstration. No live provider was contacted.

## Independent regression work

A separate Tester reproduced and drove fixes for cancel/cleanup races, corrupt-state host crashes, dead startup leases, surviving orphan-child ownership, already-aborted pi launches, and escaped credential-value redaction. The final suite includes these regressions. Additional coverage tests exact plan digest/revision checks, concurrent DB migration/appends, path/symlink boundaries, stale/foreign proof, malformed/fragmented Unicode events, signal exits, bounded output, cross-process cancellation requests, unsupported providers, layered profiles, invalid sink policy, and model-scope matching.

## Technical review

The shared runtime replaces duplicated provider lifecycle logic rather than creating a parallel engine. Stage proof remains separate from the model's narrative; the local frontend owns human approval. The branch deliberately does not introduce a hosted service, new account integration, deployment or automatic external writes. Documentation distinguishes trusted-local workflow controls from hostile-code isolation.

Local cycle capture: follow-up Approach row 2 (HARNESS-STUB-R1), implementation/independent feedback/review through the supported store; original Approach row 1 (capture delayed until the SQLite dependency repair, transparently recorded); implementation records from storage/runtime; independent Feedback row 1; Lead Review recorded through the supported store. These local data files are ignored, not committed as artificial product fixtures.

## Not verified / limits

- No live pi, Claude or Codex model execution; no credentials, paid API calls or login flows.
- Codex 0.163.0 `--help` flags inspected locally, not an authenticated run.
- All three command/event paths are fake-executable process-tested; managed settings, target-machine sandbox behavior and real provider receipts still need a supervised smoke cycle.
- No Windows process-tree cancellation certification, remote workers, multi-tenant identity, native session resume, tamper-proof logging or hostile-agent isolation.
- Approval is a trusted-host API contract. Same-user filesystem access can defeat local state; TTY/UI checks do not constitute a remote identity system.
- CI status is tracked separately against the eventual remote commit; local checks are not a claim that GitHub CI has run.
