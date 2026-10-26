# One process engine, two entry points

Jay Pi keeps its original process: Planner → exact-plan approval → Developer → independent Tester → Lead review. A model's final message is not evidence of a completed stage.

```text
pi subagent tool ──┐
                  ├── shared runtime ── adapter ── separate CLI process
jay-pi CLI ────────┘       │                           │
                          │                      record_cycle tool
                    atomic run snapshots              │
                    lifecycle events             stage SQLite DB
                          └──── verified receipt ──────┘
```

The host owns lifecycle decisions; adapters translate commands and event formats. An adapter never declares a run completed by itself. Clean process termination, absence of provider errors, and a matching persisted stage receipt are separate checks. Missing proof produces `incomplete`, not invented success or automatic failure.

## Package boundaries

- `extensions/harness/runtime.mjs`: reusable controller; starts, observes, cancels and recovers runs.
- `extensions/harness/adapters.mjs`: runner capabilities, argv construction and event normalization. No shell interpolation.
- `extensions/harness/run-store.mjs`: canonical run IDs, versioned snapshots, atomic writes and recovery inspection.
- `extensions/cycle-store.mjs`: authoritative structured records. Existing `approach.db`, `implementation.db`, `feedback.db`, `review.db` and `cycles` columns retained; nullable run correlation added.
- `extensions/harness/approval-store.mjs`: exact latest-plan content binding. This is a **trusted host API**, not an authorization service for untrusted callers.
- `extensions/lifecycle-subagent/index.ts`: pi-specific discovery, UI confirmation and auto-handoff. No independent process engine.
- `bin/jay-pi.mjs`: foreground CLI over the same controller. Machine-readable `--json` output for inspection and integration; no HTTP daemon.

Node 24 is the supported baseline. SQLite uses Node's built-in driver; no runtime npm dependencies are required for the core CLI/mock demonstration. The pi extension host and MCP bridge have their own dependencies.

## State and recovery

Runs retain the original outcome vocabulary: `running`, `completed`, `incomplete`, `failed`, `canceled`, `orphaned`. Terminal outcomes are not rewritten because a late child event arrives. A request to cancel is not a license to signal an arbitrary PID found in a JSON file. Recovery identifies abandoned controller work and preserves evidence; it never blindly retries potentially side-effecting work.

`previousRunId` is explicit context linkage, **not provider session resume**. New work has a new run identity and fresh approval/evidence checks. Native provider session resume and remote durable workers are out of scope.

Stage records remain authoritative. Snapshot/event history is local operational evidence, not tamper-proof security logging. A corrupt or unsupported snapshot should be diagnosed, not treated as a successful run.

## Approval and execution authority

The trusted frontend shows the recorded plan and asks the human to confirm. Approval is tied to the latest row and digest; changing the row or adding a revision invalidates authorization. A background provider cannot call the host's approval UI. CLI approval refuses piped input and has no `--yes` shortcut. This prevents accidental self-approval through supported interfaces, **not** a malicious process with access to the host's files or terminal.

Permission profiles and plan approval solve different problems. A plan approval does not authorize unlimited filesystem, network or external-account effects. The read-only profile is conservative; explicit workspace-write permission is a separate choice. Providers differ in enforcement, and MCP servers run as host processes. See README's support matrix rather than assuming identical sandboxing.

## Extension contract

New providers should declare capabilities before launch, build argv without a shell, normalize tool calls/results and errors, and provide fixture coverage for fragmented events, provider failure, cancellation and proof correlation. Unsupported resume or sandbox requirements must reject explicitly. Do not implement a provider by silently treating its output as pi JSON.

The mock provider is a deterministic test fixture. It runs in a separate local subprocess, writes real SQLite stage records and emits protocol events. It is not a model and does not demonstrate live authentication, permissions or model quality.

## Deliberately not built

No hosted service, multi-tenant authorization, remote worker scheduler, automatic external tracker writes, paid model integration test, automatic retries of uncertain side effects, deployment, or public release. These need separate threat models and operating contracts—not extra flags on a local subprocess wrapper.
