# Migration from the original pi extensions

Review before replacing an existing installation. No global files were changed by this development task.

## Requirements and compatibility changes

- **Node 24+ is now required.** Core SQLite and the standalone engine use built-in Node APIs. Optional Jev still shells out to `sqlite3` when enabled.
- Existing `data/{approach,implementation,feedback,review}.db` records remain readable. The store adds a nullable `run_id` column; historical rows are not relabeled as evidence for a new run.
- **Old row-ID-only plan approvals no longer authorize Developer.** Reopen the latest plan and confirm it through `approve_plan` or interactive `jay-pi approve`. New approval binds the exact latest row and content digest.
- `subagent` retains catalog/run/status/result/cancel/cleanup, background auto-handoff and previous-run context. `skipApprovalGuard:true` now refuses rather than bypassing. `confirmProjectAgents:false` does not waive human trust confirmation for project-local role files.
- **Read-only tool profile is the default.** In pi, `allowEdits:true` requires a human dialog; the CLI's explicit `--allow-edits` requests workspace-write. Claude's edit profile has Read/Glob/Grep/Edit/Write plus the record tool, not Bash. Pi tool selection is not an OS sandbox.
- Child environment forwarding is allowlisted. HOME remains available for provider login/configuration, but unrelated API keys are no longer automatically inherited. The embedding API accepts `envAllowlist`; pi asks the human before forwarding additional names. The standalone CLI deliberately has no arbitrary environment-forwarding option.
- Profile resolution now actually merges global → project → session fields. A session `null` clears inherited overrides. Invalid configurations and unknown runners fail rather than silently falling back to pi.
- Malformed configured external-sink policy blocks tools until repaired; an absent default policy remains optional. An empty top-level array `[]` is an explicit opt-out, not a parse failure.
- New run snapshots are private, atomic and versioned. Canonical legacy run IDs remain readable. Corrupt state is diagnosed instead of disappearing silently. Persisted arbitrary artifact paths are not trusted for cleanup.

## Install deliberately

Back up your current configuration and databases first. Review `install.sh`, then use the existing installation path if desired. The installer preserves existing settings/model/MCP/AGENTS files but replaces the extension/role source files. It honors `PI_HARNESS_SKIP_PI_INSTALL=1` even if pi is missing; patching pi itself is now opt-in via `PI_HARNESS_APPLY_PATCHES=1`.

Do not assume `~/AGENTS.md` was updated: the installer intentionally does not overwrite it. Compare the repository contract and merge the relevant technical/security changes yourself.

## Recovery is inspection, not replay

Use `jay-pi recover --cwd PROJECT` or start an interactive pi session. An orphaned run can have partial filesystem effects or a still-running child. Recovery does not signal an unverified stored PID and never retries automatically. Inspect the trace, stage records and actual files before starting another attempt. A live or uncertain Developer lease is kept conservatively to avoid overlapping mutations.

`previousRunId` transfers context from a terminal run. It does not resume a provider session, repeat an external action, or inherit a blanket authorization.

## Validation boundary

The automated suite runs local fixtures and the actual record-cycle MCP transport. The Codex CLI help interface was inspected locally at version 0.163.0; no live model request occurred. Claude and pi integrations have command/parser fixture coverage, not logged-in end-to-end certification. Tests ran on Linux; Windows process-tree cancellation is not independently validated.
