# pi-harness

A role-based subagent harness for [pi](https://github.com/earendil-works/pi-coding-agent):
a **Lead** agent that orchestrates planning, implementation, and checking
across three subagent roles (**Planner**, **Developer**, **Tester**) and
performs the final review itself, with structured SQLite capture at every
stage (written through a tool call, not freehand SQL — see below), a
human-in-the-loop review pattern ("Grilling Discipline") instead of single
yes/no gates, and an optional, gated write-back to whatever external tracker
you use.

This isn't a pi fork or plugin — it's an `AGENTS.md` operating contract plus a
handful of pi extensions and agent-role prompt files that you install into
your own `~/.pi/agent/` directory.

## What's in here

- **`AGENTS.md`** — the operating contract. Defines the four roles, the
  plan → implement → check → review lifecycle, SQLite capture layout, and the
  human approval gates ("Grilling Discipline": one question at a time, a
  recommended default attached to each, no bundling).
- **`agents/`** — the three subagent role prompts (Planner/Developer/Tester),
  loaded by pi's `subagent` tool.
- **`extensions/`**
  - `lifecycle-subagent/` — registers the `subagent` tool: runs a role
    (in the background by default) either as another pi process or, via
    `runner: "claude-cli"`, as a `claude -p` invocation — useful for bridging
    to Claude-Code-native skills that pi's own subagent tool can't spawn.
    Reports a run's outcome as `completed`, `incomplete`, or `failed` (see
    `cycle-records.ts` below for what `incomplete` means), and supports
    scoping each child process's environment — see "Security posture" below,
    since this ships as a full clone by default, not scoped out of the box.
  - `cycle-records.ts` — registers the `record_cycle` tool: the actual,
    machine-verified way Planner/Developer/Tester write their DB records,
    replacing freehand `sqlite3` calls the model used to construct itself.
    `lifecycle-subagent` checks whether this tool was actually called (and
    for the right stage — a Developer can't attribute a row to Tester by
    passing the wrong stage) before reporting a run `completed`; a
    subagent's own closing message is never trusted as proof the DB record
    exists.
  - `mcp/record-cycle-server/` — a standalone MCP server exposing that same
    `record_cycle` capability to Claude-CLI-routed subagents, which run as a
    bare `claude -p` subprocess with no path back into any pi-registered
    tool. `lifecycle-subagent` wires it in automatically via `--mcp-config`
    (confined with `--strict-mcp-config` so a subagent run never inherits
    your own configured MCP servers) whenever a role's runner is
    `claude-cli` — no setup needed beyond `npm install` in that directory
    (done for you by `install.sh`).
  - `subagent-status.ts` — a live status ticker (2–3 lines, fixed height)
    shown above the editor while a background subagent runs, so the lead
    session isn't a black box while something else works.
  - `agent-session-profile/` — lets you pin a runner/model/thinking-level
    per role, resolved across session → project → global scope, so you
    aren't re-answering "which model for Developer?" every session.
  - `external-sink-gate.ts` — a generic version of "never write to an
    external system without a human seeing the literal payload first."
    Nothing is gated until you configure it — see `config/external-sink.example.json`.
  - `agents-md-freshness.ts` — warns if a resumed/forked session's context
    predates the current `AGENTS.md`, so a stale operating contract doesn't
    silently keep running.
  - `lead-idle-timeout.ts` — aborts a run that's made no forward progress
    for a configurable window, instead of burning tokens stuck in a loop.
  - `tokens-per-second.ts` — a small footer stat.
- **`patches/`** — a self-healing patch system for hand-fixing bugs in the
  installed `pi-coding-agent` npm package that would otherwise get wiped by
  every pi upgrade. Content-anchored (not line-diff-based), so it survives pi
  changing its own build layout. Ships one real fix today: a CommonMark
  soft-line-break bug in `pi-tui`'s Markdown renderer.
- **`config/`** — `*.example.json` templates for `settings.json`,
  `models.json`, `mcp.json`, and `external-sink.json`.
- **`docs/model-provider-setup.md`** — a walkthrough for wiring a self-hosted
  OpenAI-compatible reasoning model (e.g. a vLLM-served Qwen3 deployment)
  into pi, including a real gotcha around where the "enable thinking" flag
  actually needs to live in the request body.

## Why the structured DB writes and the third run status

If you're running smaller/self-hosted models alongside stronger hosted ones,
prose-only procedural instructions ("write your record to the DB when
you're done") are a real drift surface — a weaker model can exit cleanly
while claiming success without the write ever happening correctly, and
nothing catches it. Two things here exist specifically to close that gap:

- **`record_cycle`** makes the DB write itself the source of truth, not the
  model's account of the write. A subagent's closing chat message and its
  actual recorded output are allowed to disagree; only the latter matters.
- **The `incomplete` status** is what `lifecycle-subagent` reports when a
  run exits clean but never made a successful `record_cycle` call — an
  honest "this may not have actually happened" signal instead of a silent
  false `completed`. It isn't automatically a failure (some tasks legitimately
  don't touch the DB) — it's a prompt for Lead to check before trusting the run.

## Install

```sh
git clone <this-repo> pi-harness
cd pi-harness
./install.sh
```

This copies `extensions/`, `agents/`, and `patches/` into `~/.pi/agent/`
(always fresh — that's this repo's actual content), and writes
`settings.json` / `models.json` / `mcp.json` / `~/AGENTS.md` **only if they
don't already exist** — it will never overwrite your own config.

Then:
1. Edit `~/.pi/agent/models.json` for the models you actually have (see
   `docs/model-provider-setup.md` if you're wiring up a self-hosted model).
2. Run `~/.pi/agent/patches/self-heal.sh check`, then
   `~/.pi/agent/patches/reapply.sh`.
3. Restart pi, or run `/reload`.

Prefer to do it by hand instead of running the script? Everything it does is
just a copy — read `install.sh`, it's short.

### Optional: gating writes to an external tracker

If your team keeps project context in Notion (or Linear, Confluence, etc.)
and wants Planner/Developer/Tester/Lead to be able to write status updates
back there — but only after a human has seen the literal draft — copy
`config/external-sink.example.json` to `~/.pi/agent/external-sink.json` and
edit it to list the write-tool names for whatever MCP server you're using.
Nothing is gated until this file exists.

### Optional: scoping subagent environments

`ENV_DENYLIST_PREFIXES` in `extensions/lifecycle-subagent/index.ts` ships
empty. If you have third-party service credentials sitting in your own
`mcp.json`/environment that a coding subagent has no reason to see, add
their env-var prefixes there so background Planner/Developer/Tester
processes don't inherit them.

## Security posture — read before you install

This ships permissive by default, on purpose (it's built for a personal or
small-team setup where the human is already trusted), but that means two
things are worth knowing rather than discovering later:

- **Every background Planner/Developer/Tester process inherits your full
  environment** unless you fill in `ENV_DENYLIST_PREFIXES` above. That
  includes any API keys, tokens, or credentials sitting in your shell
  environment or `mcp.json` — a coding subagent doesn't need most of them.
- **The Claude CLI runner path** (`runner: "claude-cli"` in a role's
  frontmatter, used when Developer's execution path is set to Claude)
  invokes `claude -p --dangerously-skip-permissions` — it does not prompt
  for individual tool approvals. That's what makes unattended background
  runs possible at all, but it means a Claude-routed subagent can run any
  tool without a per-call confirmation.

Neither of these is hidden — they're both plainly visible in
`extensions/lifecycle-subagent/index.ts` — but they're easy to miss if you
only read the feature list above. If you're running this somewhere
credentials or blast radius actually matter, fill in the env denylist (or
build it out into a real allowlist) before you rely on background runs.

## Credits

- Built on [pi](https://github.com/earendil-works/pi-coding-agent) by
  [@earendil-works](https://github.com/earendil-works).
- The `PR Review Rule` in `AGENTS.md` references
  [ponytail](https://github.com/DietrichGebert/ponytail) by
  [@DietrichGebert](https://github.com/DietrichGebert) for an
  over-engineering/complexity review pass — install it as a pi package if you
  want that step.

## License

MIT — see `LICENSE`.
