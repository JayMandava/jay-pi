# Morning walkthrough

## 1. Start with the proof, not the pitch

```sh
node --version                    # Node 24+
npm ci --ignore-scripts
npm run check
npm test
npm run demo
```

The demo creates a fresh temporary project, starts local fixture subprocesses through the **same engine used by pi**, records a plan, applies explicitly labeled synthetic fixture approval, and runs Developer, Tester and Lead. Then it demonstrates missing evidence, wrong-stage evidence, provider failure, cancellation and an interrupted controller recovered as orphaned. It makes no model calls and uses no account credentials.

Keep the workspace path printed by the demo:

```sh
node bin/jay-pi.mjs list --cwd /path/printed/by/demo
node bin/jay-pi.mjs plan --cwd /path/printed/by/demo
node bin/jay-pi.mjs status RUN_ID --cwd /path/printed/by/demo
node bin/jay-pi.mjs result RUN_ID --cwd /path/printed/by/demo
node bin/jay-pi.mjs events RUN_ID --cwd /path/printed/by/demo --json
```

The demo's approval is **not human consent** and is confined to its temporary workspace. Normal `approve` requires an interactive terminal, shows the complete plan, and asks for an exact confirmation.

## 2. What changed

- The original process/evidence idea is now a shared core, not duplicated provider-specific loops.
- Approval confirms an actual plan and binds exact content, fixing the old UI-presence-only check.
- Cancellation, signal exits, run IDs, snapshots and crash recovery have explicit tested semantics.
- Provider commands and stream formats have isolated adapters and honest capability boundaries.
- A CLI, offline demo, tests and CI make the engine approachable outside the pi UI.
- Core SQLite no longer needs a separate `sqlite3` executable.

## 3. Before trying a real provider

```sh
node bin/jay-pi.mjs doctor
```

This only checks local prerequisites. It does not log in, invoke a model, or prove an account works. Review the README provider matrix and security notes, install the relevant official CLI yourself, and configure your own authentication. MCP runners also need the existing bridge dependencies:

```sh
npm ci --ignore-scripts --prefix extensions/mcp/record-cycle-server
```

Live calls may incur costs. They were deliberately not exercised during this build. Default permission restrictions may be too narrow for an implementation task; inspect and explicitly choose workspace-write authority rather than disabling safeguards.

## 4. What to review before merging

Review the exact branch diff, test report and provider limitations. Main is intentionally untouched. This is a local trusted-user process engine—not a security sandbox or a Kylon-like hosted company operating system. The next useful milestone is a supervised real-provider smoke cycle, not more infrastructure.
