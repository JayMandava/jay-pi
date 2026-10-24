# Offline functional testing — HARNESS-STUB-R1

The suite tests **our process adapters without invoking vendor CLIs or models**. It is intended to catch wiring regressions before a supervised live run, not certify real provider compatibility.

## Run it

Use Node 24 or later from the repository root:

```sh
npm ci --ignore-scripts
npm ci --ignore-scripts --prefix extensions/mcp/record-cycle-server
npm run check
npm test
npm run demo
```

Run only the provider-boundary tests:

```sh
node --test tests/provider-process.test.mjs tests/provider-boundary-independent.test.mjs
```

## What is real and what is stubbed

| Boundary | Exercised implementation |
|---|---|
| Engine | Production `createHarness`, durable state, permissions/profile selection, approval checks, cancellation and proof verification |
| OS process | Actual child executables named `pi`, `claude` and `codex` on an isolated test PATH; actual arguments, stdin, stdout, stderr, exit and signals |
| Vendor agent | Repository-owned deterministic fake executable, not installed pi/Claude/Codex; no model or account calls |
| Claude/Codex record tool | Fake reads the generated MCP configuration and starts the real repository record-cycle MCP server over stdio; real SQLite receipt |
| pi record tool | Fake invokes the supported record store and emits representative pi events; it does not load the real pi extension host |
| Provider output | Representative JSON event fixtures, not recorded live model sessions |
| Human approval | Explicit trusted-host test calls for exact plan approval; not a simulated human UI or identity guarantee |

The old `mock` adapter remains useful for small deterministic engine tests and the nine-scenario demo. The additional fake executables deliberately take the **real provider adapter paths**, so command construction, prompt transport and MCP configuration participate in the integration test rather than being bypassed.

## Assertions covered

- Four lifecycle roles per provider, actual correlated rows, explicit plan approval and context-only continuation.
- Model/role prompt delivery, pi argv versus Claude/Codex stdin, literal shell-like task text, allowlisted environment, isolated HOME, read-only/edit profiles and temporary-config cleanup.
- Fragmented UTF-8 events and a final event without newline, known/unknown usage values, absent/wrong/rejected evidence, malformed stream, process exits/signals, and provider-declared errors even after a valid receipt.
- Pre-dispatch rejection of stale approvals, wrong-cycle plans, unsupported resume/isolation/profile requests and invalid provider identifiers.
- Cancellation/timeout and durable-state checks, with independent tests separate from the fixture implementation.

An independent review found that inherited object keys such as `constructor` were accepted as provider IDs and could silently route to Codex. The runtime, invocation builder and normalizer now require an own, string-valued registry key. Omitted runner still defaults to pi; invalid explicit values are rejected rather than silently substituted.

## Remaining live checks

The user should still supervise a small disposable-workspace cycle on each installed provider: extension/MCP discovery, authentication, actual event shapes, permission/managed-setting behavior, model availability and target-machine sandbox semantics. Confirm the persisted stage receipt and exact plan approval before allowing a Developer edit. Do not treat green stubs as permission to enable unattended writes or dangerous bypass flags.

Fixtures cannot prove that a future vendor CLI accepts today's flags, that authentication succeeds, or that the provider actually enforces the requested restrictions. Windows process-tree behavior is not certified by the Linux CI suite.
