# Provider contracts and validation evidence

Reviewed 24 October 2026. These are process adapters, not direct model API clients. No paid/model request or account login was exercised during development.

| Runner | Contract evidence | Verified here | Still needs supervised validation |
|---|---|---|---|
| pi | Existing repository JSON-message protocol; public extension types from pinned `@earendil-works/pi-coding-agent` 1.4.0 | Typecheck, wrapper registration/gates, fake pi executable through actual adapter, subprocess lifecycle and SQLite receipts | Installed pi loading the extensions, real authentication and tool events |
| Claude CLI | Official CLI reference: print/stream JSON, permission mode, tool lists, settings sources and strict MCP configuration | Fake Claude executable through actual adapter; generated MCP config launches real record-cycle server and verifies receipts | Real Claude process, managed settings interaction, allowed-tool semantics and emitted receipts |
| Codex CLI | Official noninteractive JSONL and CLI configuration contracts; installed `codex-cli 0.163.0` help | Local help flags; fake Codex executable through actual adapter; generated MCP overrides launch real record-cycle server and verify receipts | Real model run, sandbox behavior on target OS, MCP event shape/authentication |
| mock | Repository-owned deterministic finite fixture worker | End-to-end runtime, SQLite proof, failure/cancel/recovery demonstration | Not an AI integration; nothing to authenticate |

Claude uses explicit tool allowances and does not request a permission bypass. Settings-source filtering and strict MCP selection reduce inherited integrations; they do not replace an operating-system sandbox. Its edit profile deliberately excludes shell execution. See [Claude's official CLI reference](https://code.claude.com/docs/en/cli-reference).

Codex uses noninteractive JSONL, explicit sandbox selection, no approval escalation, ephemeral sessions, and ignored user configuration/rules. Unknown flags should fail rather than weaken policy. Host MCP remains outside model-command sandboxing. See [the official CLI reference](https://developers.openai.com/codex/cli/reference/) and [noninteractive mode](https://developers.openai.com/codex/noninteractive/).

The permission profile is recorded with each run. All adapters advertise native resume as unsupported by this harness; `previousRunId` supplies prior result context only. Provider command flags evolve, so fixture validation must not be described as live interoperability certification.

## Why this product boundary

Kylon's [bring-your-own-agent](https://kylon.io/bring-your-own-agent) and [access](https://kylon.io/product/access) framing informed the separation of provider identity, observable work and human authority. Jay Pi intentionally does not reproduce a hosted workspace or company operating system. Its differentiator remains the original evidence-backed plan/implement/check/review process, made reusable and testable.

See [offline functional testing](functional-testing.md) for the exact real/stubbed boundary and runnable commands. Fake executables validate our wiring against representative contracts; they do not establish vendor CLI parity.
