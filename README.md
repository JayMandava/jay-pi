# pi-harness

A role-based subagent harness for [pi](https://github.com/earendil-works/pi-coding-agent):
a lead agent (**Albus**) that delegates planning, implementation, and checking
to three fixed subagent roles (**Hermione**, **Harry**, **Snape**), with
structured SQLite capture at every stage, a human-in-the-loop review pattern
("Grilling Discipline") instead of single yes/no gates, and an optional,
gated write-back to whatever external tracker you use.

This isn't a pi fork or plugin — it's an `AGENTS.md` operating contract plus a
handful of pi extensions and agent-role prompt files that you install into
your own `~/.pi/agent/` directory.

## What's in here

- **`AGENTS.md`** — the operating contract. Defines the four roles, the
  plan → implement → check → review lifecycle, SQLite capture layout, and the
  human approval gates ("Grilling Discipline": one question at a time, a
  recommended default attached to each, no bundling).
- **`agents/`** — the three subagent role prompts (Hermione/Harry/Snape),
  loaded by pi's `subagent` tool.
- **`extensions/`**
  - `lifecycle-subagent/` — registers the `subagent` tool: runs a role
    (in the background by default) either as another pi process or, via
    `runner: "claude-cli"`, as a `claude -p` invocation — useful for bridging
    to Claude-Code-native skills that pi's own subagent tool can't spawn.
  - `subagent-status.ts` — a live status ticker (2–3 lines, fixed height)
    shown above the editor while a background subagent runs, so the lead
    session isn't a black box while something else works.
  - `agent-session-profile/` — lets you pin a runner/model/thinking-level
    per role, resolved across session → project → global scope, so you
    aren't re-answering "which model for Harry?" every session.
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
and wants Hermione/Harry/Snape/Albus to be able to write status updates back
there — but only after a human has seen the literal draft — copy
`config/external-sink.example.json` to `~/.pi/agent/external-sink.json` and
edit it to list the write-tool names for whatever MCP server you're using.
Nothing is gated until this file exists.

## Why the names

The lead/subagent roles are named Albus, Hermione, Harry, and Snape — lead,
planner, implementer, checker. It's just a mnemonic for who does what; there's
no other theming in this repo.

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
