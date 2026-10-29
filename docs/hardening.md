# Hardening notes

Fixes ported from the `feat/provider-agnostic-harness` branch into the existing pi extensions, found by reviewing that branch and by supervised live runs. Claude subagents still run with their existing permissions and environment; that behavior is intentionally unchanged. The plan gate is still one human review (the grill session) plus the Tester, with no extra confirmation step.

## What changed

| Area | Before | Now |
|---|---|---|
| Plan approval | `approve_plan` recorded a row id only | Approval is bound to the plan row's content digest; a revised or edited plan is not covered; nonexistent rows are rejected |
| "Recorded its stage" | Any tool call with a matching name and stage argument | A persisted receipt: same run, same stage, same role, confirmed in the database. Prose, hand-written rows, wrong stage and other runs' receipts stay `incomplete` |
| Process exit | `code ?? 0` | A signal or null exit is `failed`, never success |
| Cancel | Wrote `canceled` on a loaded copy (the close handler could overwrite it); signalled any stored PID | Marks the live record in place; only signals children this session started; terminal runs are left alone |
| Run ids and cleanup | Ids went into file paths; cleanup trusted the stored `artifactPath` | Ids are validated, paths are derived from the id, active runs are never cleaned up |
| Run state files | Plain overwrite; unreadable files looked like "unknown run" | Atomic temp-file rename; corrupt records are reported as corrupt |
| Provider output | Unbounded | Stderr, raw stdout and an unterminated line are capped, with a truncation marker |
| Project-local agents | Confirmation skipped when headless or when the model passed `confirmProjectAgents:false` | Always confirmed; headless sessions refuse |
| Record store | `sqlite3` binary with string-built SQL | Node 24 built-in SQLite with bound parameters; symlinked storage is refused |
| record_cycle MCP server | Path resolved to a directory that does not exist in the repo layout | Resolved package-relative with a fallback; receipt returned as JSON |
| Profiles | First existing layer won wholesale; malformed files silently ignored | Session > project > global merged field by field; malformed files raise a clear error; unknown runners rejected |
| Model scope | Called a pi API with a type that no longer matches pi 1.4 | Pattern matching against the public registry |
| Sink gate | Malformed configuration silently disabled gating | Invalid configured policy blocks tool calls until repaired |
| Grill | Option labels could be altered or ambiguous | Literal selected option, ambiguity rejected, one prompt at a time |

## Not changed, deliberately

- Claude subagents keep their current permission mode and inherit the environment.
- No Codex adapter, standalone CLI or shared runtime: those live on `feat/provider-agnostic-harness`.
- Local controls are workflow safeguards for trusted local use, not isolation from a hostile agent.

## Tests

`npm test` (offline, no network or credentials) and `npm run check` (syntax plus `tsc` against pinned pi). Lifecycle tests run the real `subagent` tool against a stub `claude` executable in a temporary HOME.
