# Provider contracts and validation evidence

Reviewed 23 October 2026. These are process adapters, not direct model API clients. No paid/model request or account login was exercised during development.

| Runner | Contract evidence | Verified here | Still needs supervised validation |
|---|---|---|---|
| pi | Existing repository JSON-message protocol; public extension types from pinned `@earendil-works/pi-coding-agent` 1.4.0 | Typecheck, wrapper registration/gates, normalized fixture messages, subprocess lifecycle | Installed pi loading the extensions, real authentication and tool events |
| Claude CLI | Official CLI reference: print/stream JSON, permission mode, tool lists, settings sources and strict MCP configuration | Invocation/parser fixtures; actual independent record-cycle MCP transport | Real Claude process, managed settings interaction, allowed-tool semantics and emitted receipts |
| Codex CLI | Official noninteractive JSONL and CLI configuration contracts; installed `codex-cli 0.163.0` help | Local help flags only; invocation/parser fixtures; actual independent record-cycle MCP transport | Real model run, sandbox behavior on target OS, MCP event shape/authentication |
| mock | Repository-owned deterministic finite fixture worker | End-to-end runtime, SQLite proof, failure/cancel/recovery demonstration | Not an AI integration; nothing to authenticate |

Claude uses explicit tool allowances and does not request a permission bypass. Settings-source filtering and strict MCP selection reduce inherited integrations; they do not replace an operating-system sandbox. Its edit profile deliberately excludes shell execution. See [Claude's official CLI reference](https://code.claude.com/docs/en/cli-reference).

Codex uses noninteractive JSONL, explicit sandbox selection, no approval escalation, ephemeral sessions, and ignored user configuration/rules. Unknown flags should fail rather than weaken policy. Host MCP remains outside model-command sandboxing. See [the official CLI reference](https://developers.openai.com/codex/cli/reference/) and [noninteractive mode](https://developers.openai.com/codex/noninteractive/).

The permission profile is recorded with each run. All adapters advertise native resume as unsupported by this harness; `previousRunId` supplies prior result context only. Provider command flags evolve, so fixture validation must not be described as live interoperability certification.

## Why this product boundary

Kylon's [bring-your-own-agent](https://kylon.io/bring-your-own-agent) and [access](https://kylon.io/product/access) framing informed the separation of provider identity, observable work and human authority. Jay Pi intentionally does not reproduce a hosted workspace or company operating system. Its differentiator remains the original evidence-backed plan/implement/check/review process, made reusable and testable.
