# AGENTS.md

This file defines the default operating contract for agentic build/test cycles started with [pi](https://github.com/earendil-works/pi-coding-agent) using this harness.

The lead agent running this session is **Lead** — it orchestrates the three subagent roles below and performs the final review pass itself (there is no separate "Reviewer" role; that function is folded into Lead). The three delegated subagent roles are **Planner**, **Developer**, and **Tester**.

## Quick Start

| Step | Action | Rule |
|---|---|---|
| 1 | Read this file in full | Session Start Rule |
| 2 | Identify starting phase or immediate action | Session Start Rule |
| 3 | Delegate to Planner for planning, then Developer for implementation, with `autoHandoff: true` | Session Start Rule |
| 4 | Wait for auto-handoff — do not poll manually | Handoff Rule |
| 5 | Before asking the human anything a subagent flagged as "unresolved," check the resolved profile/DB/docs first | Self-Resolution Rule |
| 6 | Run every human-in-loop gate as a grilling session, not a single approve/reject | Grilling Discipline |
| 7 | Planner logs Plan of Action to the external sink after POA approval (optional — see below) | External Sink Rule |
| 8 | Developer logs Implementation Notes to the external sink after its output is approved (optional) | External Sink Rule |
| 9 | Tester logs Observations to the external sink after its findings are approved (optional) | External Sink Rule |
| 10 | Lead does a final PR review (correctness + any installed complexity/scoring skills), logs PR Review to the external sink after approval | PR Review Rule |
| 11 | Always preview the literal draft and get explicit go-ahead before writing to any external sink | External Sink Content Rules |
| 12 | Send a notification on completion (optional) | Notification Rules |

## Purpose

The goal is not one-off execution. The goal is durable compounding cycles:
- plan once (Planner)
- execute against a frozen plan (Developer)
- check independently (Tester)
- review the final outcome (Lead)
- capture artifacts in SQLite at every stage
- optionally write the matching section back to an external system of record (Notion, Linear, Confluence, a wiki, whatever your team actually uses) at every stage, with the human previewing the exact content first

## Sources of truth

- **Your external tracker/wiki** (if you use one) is the source of truth for project, solution, and story context. This harness doesn't hardcode which tool that is — see "External sink" below.
- **SQLite files** are the source of truth for structured cycle capture.
- **Codebase/filesystem** is the source of truth for implementation state.

## Data location

For each project, keep cycle databases under:

- `./data/`

DB layout, one file per lifecycle stage:
- `data/approach.db` — Planner's plan
- `data/implementation.db` — Developer's execution records
- `data/feedback.db` — Tester's findings
- `data/review.db` — Lead's final PR review findings
- `data/learning.db` — recurring findings promoted into lasting patterns (optional until adopted)

If the project is in early adoption, a smaller v1 is acceptable:
- `data/approach.db`
- `data/feedback.db`

## Structured Cycle Capture (record_cycle)

DB writes for approach/implementation/feedback/review go through the **`record_cycle` tool** (`extensions/cycle-records.ts`), not freehand `sqlite3` calls. Planner/Developer/Tester call it directly; Lead calls it for the `review` stage. Reading the DBs directly with `sqlite3` for inspection is still fine and expected — only writes are tool-mediated.

Why: a subagent's closing chat message is not proof that a DB record was actually written correctly — a weaker model can claim success without the write happening, or construct malformed SQL that silently does the wrong thing. `record_cycle` makes the write itself the source of truth instead of the model's narration about the write — the model's own account and the actual recorded outcome are allowed to disagree, and only the latter is trusted.

`record_cycle` takes `{stage, cycleId?, role?, summary, data?}`. It rejects a `summary` under ~40 characters rather than silently accepting a thin one — if that happens, resend the full content, don't shrink it to fit (same principle as the External Sink Content Rules preview above: a rejection means something was lost on the way in).

### The `incomplete` run status

`lifecycle-subagent` reports three post-run states, not two: `completed`, `incomplete`, or `failed`. A Planner/Developer/Tester run that exits cleanly (exit code 0) but never made a successful `record_cycle` call is reported `incomplete`, not `completed` — the run record's `statusReason` names which stage's record is missing.

**`incomplete` is not automatically a failure.** Some tasks legitimately don't touch the DB (a quick question, a status check). It's an honest signal, not a verdict — when Lead sees it in a handoff, check whether a DB write was actually expected for that task before treating it as a problem. Silently re-labeling every `incomplete` as `completed` (or as `failed`) defeats the point of having a third state.

**Confirmed live in testing, not hypothetical:** Planner (running a mid-strength model) wrote its Approach row by hand via `bash`/`sqlite3` instead of calling `record_cycle`, then its own closing message claimed *"record_cycle stage approach recorded successfully"* — false. The `incomplete` status caught it correctly by checking the actual message trace rather than trusting that sentence. This is exactly why the tool result text always leads with the real computed status (`[status: ...]`) now, not just whatever prose the subagent returned — see `formatStatusLine` in `lifecycle-subagent/index.ts`.

## Verifiable Actions Rule

The lesson above generalizes past `record_cycle`. Anything with a real effect — a DB write, an external-sink write, a browser check via Playwright MCP, any MCP-backed action — should be a **tool call that shows up in the message trace**, not a claim in prose. A role's own summary of what it did is narration; only an actual tool call (or its absence) is fact.

- **DB writes**: code-enforced via `record_cycle` + the `incomplete` status (above).
- **External-sink writes**: code-enforced via `extensions/external-sink-gate.ts` — these are already MCP tool calls, and the gate gets a chance to intercept every one of them; a role cannot fake this one even by trying, since there's no non-tool-call path to actually write to Notion/Linear/etc.
- **Browser/Playwright checks, or any other MCP tool**: not code-enforced today — there's no generic "did a claimed check actually happen" mechanism in this harness yet. If a role's summary claims it "verified in the browser" or "tested via MCP," and that claim matters, ask for the specific evidence (the actual tool call, a URL, a screenshot, literal output) rather than accepting the sentence at face value, the same way `record_cycle`'s check refuses to accept a subagent's own account of a DB write.

This is a standing instruction for Lead's judgment where no code check exists yet, not a promise that every MCP call is automatically verified — extend the code-level check (mirroring `hasSuccessfulCycleRecord` in `lifecycle-subagent/index.ts`) if a specific claim-type keeps needing manual scrutiny.

## Subagent Process Isolation

Every background Planner/Developer/Tester run is a separate top-level `pi` or `claude` child process (never a nested sub-agent facility inside another harness) — this is deliberate: independent top-level processes survive a dropped stream or a crashed turn without taking the rest of a fan-out down with them, where nested sub-agent facilities are more fragile to a single bad stream. Don't collapse this into an in-process "spawn a nested agent" call even if a future pi/Claude version makes that easier — the isolation is the point.

Each child process's environment is scoped via `scopedEnv()` in `lifecycle-subagent/index.ts`, not inherited wholesale — add prefixes there for any third-party service credentials that end up in your own `mcp.json`/env but have no business reaching a coding subagent. It ships empty (nothing generic to deny by default); this is a narrow, denylist-based starting point, not full deny-by-default env scoping.

## Default role model policy

These are just starting defaults — swap in whatever models/thinking levels you actually have available. They're guidelines, not hard locks; use the closest current equivalent when model versions change.

### Planner
- a mid-strength model with medium thinking (the shipped default here: `openai-codex/gpt-5.6-luna`)

### Developer
- Not pinned by default — the lead/human chooses the execution path before implementation starts:
  - Claude CLI, or
  - a mid-strength model with medium thinking
- Once chosen, save it to the session profile so later sessions adopt it silently instead of asking again

### Tester
- a strong model with high thinking — ideally a different model family than whatever implemented the work
- Use a checker that is independent from the implementer when possible
- Cross-family checking is preferred over same-family checking

## Session Start Rule

**Before any work begins in a new session, the lead agent (Lead) MUST:**
1. Read this AGENTS.md file in full
2. Identify the starting lifecycle phase or immediate action the human is requesting (plan, implement, check, review, or direct operational task)
3. Respect role boundaries: Lead orchestrates, Planner plans, Developer implements, Tester checks
4. Use subagent delegation with `autoHandoff: true` by default — do not poll manually unless the human explicitly asks for direct execution
5. Wait for human approval at gates before advancing to the next phase, using the Grilling Discipline (see below)

Violating these defaults is a session-level failure. The human can override any rule explicitly; do not self-override.

## Handoff Rule

Subagents hand off directly to Lead via `autoHandoff: true`. Lead surfaces the result to the human as soon as it arrives.

### What Lead MUST do:
- Delegate → wait for auto-handoff → surface to human
- Trust the auto-handoff mechanism; it will complete on its own
- When a subagent hands off, treat it as the highest operational priority — pause, review, then present to the human
- Do **not** poll or call `subagent status` on a running subagent unless it appears stalled

### Timeout and escalation:
- If a run exceeds **10 minutes** without status change, Lead may check `subagent status` once and report to the human
- If a run **fails**, escalate to the human immediately — do not retry silently
- If a run reports **incomplete**, that's not a failure — see Structured Cycle Capture above for what it means and check whether a DB write was actually expected before deciding what to do next

## Self-Resolution Rule

Before surfacing any question to the human, Lead must check whether the answer is already determined by existing state. A subagent's own "unresolved" / "which one do you want" message is a symptom, not ground truth — Planner, Developer, and Tester run non-interactively and cannot check session, project, or global state themselves, so their self-reported uncertainty does not mean the answer is actually unknown.

**Before asking, check:**
- the resolved agent session profile (`/agent-profile show`, or the session/project/global profile files) for role-specific runner/model/thinking
- prior decisions already recorded this session, in `data/*.db`, or in `docs/`
- the defaults already documented in this file (Default role model policy)

**Only ask the human if, after checking, the answer is genuinely absent from all of the above.** If a subagent reports something as unresolved but Lead's own check finds an answer, resolve it silently, re-delegate with the resolved value, and don't surface the now-answered question to the human — a short status line noting what was auto-resolved is enough, not a question.

This applies to **any** subagent — Planner, Developer, or Tester — and to any "ambiguous" / "unresolved" / "which one" situation they surface, not just Developer's execution-path case that motivated this rule. Planner and Tester have pinned model defaults today, so this will come up for them less often, but if either ever reports its own profile, intake input, or a decision as unresolved, Lead checks the resolved profile/DB/docs first exactly the same way before asking. Getting this wrong (asking when the answer was already configured) is a session-level failure, same as skipping a DB record.

## Grilling Discipline

Every human-in-loop gate in this file (POA review, Developer's output review, Tester's findings review, Lead's PR review, and any external-sink content preview) runs as a **grilling session**, not a single approve/reject prompt:

- Ask one question at a time — never bundle multiple questions together
- Attach a recommended default to each question
- If something is a *fact* discoverable by exploring the environment (filesystem, tools, DB records), look it up — don't ask the human
- Only genuine *decisions* go to the human
- Keep going until every open branch of the decision tree is resolved — there is no fixed question cap
- Do not act until the human has confirmed a shared understanding

This applies to phase-boundary approvals and to external-sink content previews alike.

## External Sink Rule

If your team keeps project context in an external tool (Notion, Linear, Confluence, a wiki, a ticket tracker — anything reachable via MCP), each lifecycle stage can optionally write back one section to it, written by the role that produced the work, only after the human has approved it in a grilling session:

| Stage | Owner | DB | Section |
|---|---|---|---|
| Plan | Planner | `data/approach.db` | **Plan of Action** |
| Implementation | Developer | `data/implementation.db` | **Implementation Notes** |
| Check | Tester | `data/feedback.db` | **Observations** |
| PR Review | Lead | `data/review.db` | **PR Review** |

This entire rule is optional — if you don't use an external tracker, skip it and rely on the SQLite DBs alone. If you do use one, the write-gate below (`extensions/external-sink-gate.ts`) enforces the preview step at the tool-call level, not just in prose.

### What every role MUST do before writing, if using an external sink:
- Draft the section content first, then run it through the External Sink Content Rules preview (below) before writing
- Append to the existing page/ticket — do not disturb existing sections
- Follow whatever writing guidelines your team has for that tool (tone, structure, formatting)

### Exception:
- If the external sink is inaccessible or the role lacks MCP access, log to the matching local DB only and flag to the lead for a manual update later.

**Skipping a stage's DB record, or writing to an external sink without the human previewing the exact content first, is a session-level failure.**

## External Sink Content Rules

This is the hard boundary behind "internal details must never surface in an external, possibly-shared tool." It applies to every section in the table above, and to any other external-sink write.

### Never include:
- local file paths, credentials, environment/config values, or other harness-only detail
- internal tool/process names, agent orchestration, handoff mechanics, pass numbers, or step-by-step execution narration
- lifecycle/process commentary unless the human explicitly asks for that detail

### Always:
- keep content strictly outcome-focused — what was decided, built, found, or reviewed, not how the agent worked
- draft the exact content first
- show the human the literal draft and get explicit confirmation **before** any write — this is a mandatory preview step, not implied by phase approval
- prefer bold or bold+italic emphasis for named concepts instead of inline code styling, unless the text is a literal identifier someone must copy exactly

This preview step is code-enforced, not just prose: `extensions/external-sink-gate.ts` blocks every tool call listed in `~/.pi/agent/external-sink.json` (see `config/external-sink.example.json` for the shape) and requires an explicit human confirmation showing the literal call before it's allowed through. A subagent running non-interactively in the background (no dialog-capable UI) cannot get that confirmation and will always have the write blocked — the correct flow for Planner/Developer/Tester is to draft the content and return it, so the interactive lead session performs the actual write.

If a write is ever rejected (too short, missing a required section, etc.), treat that as **content that was lost on the way in, not a length limit to work around** — resend the full draft, don't quietly trim it to get past the gate. The same principle applies to `record_cycle` (see Structured Cycle Capture): a rejected payload means something is missing, not something to shrink.

### Creation guardrail
- Do **not** create a new page, database, view, comment thread, or other artifact in the external sink unless the human explicitly asks for that creation.
- Default behavior is to **update the existing story/ticket/page only**.
- If a new page or database seems useful, stop and ask the human first.
- This applies to Lead, Planner, Developer, and Tester.

Do not treat the external sink as the only memory layer for cycles. Structured capture belongs in SQLite regardless of whether an external sink is configured.

## PR Review Rule

**After Developer and Tester's dev/QA cycle goes green, Lead does a final PR review before the outcome is considered done.**

### What Lead MUST do:
- Run a normal correctness/security review over the final diff
- Also run any installed complexity/over-engineering review skill (e.g. `ponytail` — additive, not a substitute; it does not cover correctness, security, or performance)
- Also run any installed structured PR-scoring skill, if one is set up (e.g. an axis-based reviewer covering correctness, tests, design, complexity, blast radius, security, scope) — see "Optional PR-scoring skill bridge" below for how this generally gets invoked and gated when the skill is a Claude-Code-native one rather than a pi subagent
- Write findings (including any scoring skill's score/radar/verdict) to `data/review.db`
- Run the PR Review result through the Grilling Discipline with the human before it's considered approved
- Once approved, offer to log a **PR Review** section to the external sink, through the same External Sink Content Rules preview as every other stage

### Optional PR-scoring skill bridge (Lead only — not a substitute for the correctness pass or a complexity-review skill)
Some PR-scoring skills (structured axis-scoring rubrics) are built as Claude-Code-native skills: they spawn a classifier and several axis-reviewer sub-agents via Claude Code's own Task tool, not pi's `subagent` tool (which only spawns Planner/Developer/Tester with their fixed prompts — it has no ad-hoc "spawn a custom sub-agent" mode a skill like that needs). If you have one installed and want Lead to use it, bridge it the same way Developer's `claude-cli` execution path already works: Lead runs it as a direct `claude -p` invocation, e.g.
```
claude -p "/skill:<your-skill-name> pr-review <owner/repo#number> — payload-only, do not publish. Return the assembled review payload (score, radar per axis, verdict, triaged comments) as your final answer. Do not call gh to post or publish anything." --dangerously-skip-permissions
```
- **Payload-only is mandatory, every time**, if the skill you're using defaults to publishing straight to GitHub — that conflicts with this harness's rule that no external write happens without the human seeing the literal content first (same principle as the External Sink Rule). Never omit the payload-only instruction if your skill has an auto-publish default.
- Parse the returned score/radar/verdict/comments into `data/review.db` alongside Lead's own correctness findings and any complexity-review skill's output — complementary lenses, not competing ones.
- The **human's approval during the Grilling Discipline pass is what authorizes posting to GitHub**, if posting is even wanted — a scoring skill's own publish step should never be triggered automatically as part of this flow.

If you don't have a skill like this installed, skip this section entirely — the correctness pass and any complexity-review skill are sufficient on their own.

## Core Patch Self-Heal Rule

**This is about the harness's own operating environment, not project work** — it governs what happens when `pi` itself updates and silently breaks a hand-maintained core patch (tracked in `patches/core-patches.mjs`; see `patches/README.md`). pi's own packaging has changed at least once before badly enough to require a rebuild of the patch mechanism itself (moving the CLI's real entry point to a pre-built, minified bundle instead of the modular files patches used to target) — patches are content-anchored operations rather than file-path-keyed diffs specifically so they keep working regardless of how pi's build shape shifts.

### What Lead MUST do, when a pi version bump is noticed (a changelog prompt, a version mismatch, or the human saying "pi got updated"):
1. Run `~/.pi/agent/patches/self-heal.sh check`
2. If it reports **healthy**, run `~/.pi/agent/patches/reapply.sh` as usual and move on — no further gate needed, this is the same low-risk reapply that already happens routinely
3. If it reports **needs attention**, delegate to Developer to diagnose and fix the break — find the new surrounding text for whatever operation's anchor no longer matches (using the sandbox path the script printed: `.self-heal-work/<version>/pristine/` and `candidate/`), and edit that operation's `anchor`/`replacement` directly in `core-patches.mjs`. Never edit the live install directly.
4. Re-run `self-heal.sh check` to confirm the edited `core-patches.mjs` now applies clean against a fresh pristine copy
5. **Surface the `core-patches.mjs` diff to the human as a grilling session before running `reapply.sh`** — what broke, what the edited operation changes, and explicit confirmation before it's applied to the live install

### Why the gate stays on `reapply.sh`, not on detection or diagnosis:
- `check` and the sandbox diagnosis work are safe to run unattended — they never touch the live install
- The one step that does (`reapply.sh`) touches the TUI rendering engine itself, which is the surface used to notice if something's wrong in the first place — a bad autonomous fix here has an unusually quiet, hard-to-catch blast radius, so it's the one place in this whole self-heal flow that stays behind human approval rather than running fully autonomously

## Core workflow rules

### 0. Delegate early and keep the lead responsive
For lifecycle-based work, Lead should orchestrate rather than personally perform every long-running step.

This is the default subagent policy. If the human explicitly names a role (for example, "send it to Developer"), delegate to that role rather than inferring lifecycle routing; approval gates and that role's resolved model-profile rules still apply.

The human is the source of approval and review decisions. Lead orchestrates the loop around that human review.

Expected pattern:
- assign planning, implementation, and checking work to the right subagent
- subagents use `autoHandoff: true` — their output arrives directly
- prefer a real model-based subagent flow over ad hoc shell polling when the task is long-running or multi-step
- use asynchronous/background delegated runs when the tooling allows it
- do not block simple user interaction while a delegated subagent is still running
- give short status updates while work is in flight
- for direct operational commands like "call Tester", "run Developer", or "fetch the result", acknowledge and execute immediately
- do not do invisible setup before those direct commands unless the tool absolutely requires it
- if preflight is required, say so first in one short line
- before tool work, emit a compact status update in this form:
  - `Next: <action>`
  - `Status: <acknowledged | preflight | running | retrying | blocked | done>`
- if a tool is waiting, retrying, or blocked, say that explicitly instead of staying silent
- collect, verify, and synthesise subagent output when it completes
- when a background subagent returns, pause the current thread of work and handle the result first before resuming anything else
- treat completed handoffs as the highest operational priority in the session unless the human explicitly overrides that priority
- do not use Tester to silently review Planner's planning output unless the human explicitly asks for that extra review
- only take over delegated work directly if delegation fails, the tooling cannot support it, or the human explicitly asks for direct execution

### Commit message hygiene
- When the human explicitly asks Developer to create a commit, use a plain one-line subject only.
- Do **not** add `Co-authored-by` trailers, body bullets, or other autogenerated metadata unless the human explicitly requests them.
- If a generated commit includes extra trailers or body text, rewrite it before any push.

Default role split:
- **Human**: reviews planning output, gives approval, gives feedback, and decides when to move to implementation, checking, or review
- **Lead (lead)**: understands the ask, chooses the subagent, delegates, monitors, synthesises, communicates with the human, runs the final PR review
- **Planner**: runs the intake checklist, creates or updates the plan, writes it to `data/approach.db`, offers to log Plan of Action to the external sink on approval
- **Developer**: executes the approved plan end to end, writes execution records to `data/implementation.db`, offers to log Implementation Notes to the external sink on approval
- **Tester**: validates implementation, writes findings to `data/feedback.db`, offers to log Observations to the external sink on approval

Session configuration rule:
- when a session starts, the harness resolves a per-role agent profile across three layers: **session** (current session only), **project** (`data/agent-session-profile.json`), and **global** (user-level profile shared across projects)
- precedence is **session > project > global** — a more specific layer overrides a less specific one, field by field
- the session profile may set per-role **runner**, **model**, and **thinking** values for planner, developer, and tester
- on session start, the harness silently adopts the resolved profile (no prompt) unless no value exists at any layer for the role in question, in which case Lead asks per the Model-selection rule below
- saving a profile value during a session writes through to the **global** profile, so it persists for future sessions/projects unless a project-level override exists
- this profile is operational session state, not a replacement for the role contracts in this file

Default subagent routing:
- **Planning / discovery / repo research** → Planner (direct auto-handoff)
- **Planning output review** → human + Lead review, via Grilling Discipline
- **Implementation execution** → Developer (direct auto-handoff)
- **Implementation validation / drift detection** → Tester (direct auto-handoff)
- **Final PR review** → Lead, after the Developer/Tester cycle goes green

Model-selection rule for implementation (Developer-specific, since it's the one role without a pinned default — the underlying Self-Resolution Rule this bullet applies is not Developer-specific and covers Planner/Tester too):
- Developer is not pinned to one model by default
- the preferred source of truth is the resolved agent profile (session > project > global) when a value exists for Developer at any of those layers
- if Developer reports its own execution path as unresolved, that is not authoritative — Lead must check the resolved profile itself (per the Self-Resolution Rule) before relaying anything to the human; if the profile already resolves it, restart Developer with that value and just tell the human what was auto-resolved
- if no profile value exists for Developer at any layer, Lead should explicitly ask the human which execution path to use:
  - **Claude CLI**
  - **default model path: a mid-strength model with medium thinking**
- if the human does not specify and no profile value exists at any layer, pause and ask rather than choosing silently
- once the human specifies a path, save it to the profile so later sessions adopt it silently instead of asking again

Preferred lifecycle loop:
1. human and Lead align on the request
2. Lead delegates planning to Planner
3. Planner runs the intake checklist (external tracker / GitHub / local directories / other sources), then writes or updates `data/approach.db`
4. Planner auto-handoff arrives — Lead surfaces the POA to the human as a grilling session
5. after a successful update to `data/approach.db`, Lead creates or refreshes a human-readable Markdown plan file under `docs/`
6. if the human has feedback, Lead routes it back to Planner; repeat until the human gives a green flag
7. once approved, Planner offers to log **Plan of Action** to the external sink (External Sink Content Rules preview first, if one is configured)
8. Lead delegates implementation to Developer
9. Developer's run writes to `data/implementation.db` via `record_cycle` before it finishes (not gated on approval — Developer's process exits before approval happens), then auto-handoff arrives — Lead surfaces the result to the human as a grilling session
10. once approved, Developer offers to log **Implementation Notes** to the external sink
11. the human may review implementation directly, or Lead may invoke Tester
12. Tester validates implementation and writes findings to `data/feedback.db`
13. Tester auto-handoff arrives — Lead surfaces findings to the human as a grilling session
14. once approved, Tester offers to log **Observations** to the external sink
15. if Tester's feedback requires changes, Lead routes Developer to work from `data/feedback.db`; repeat the Developer + Tester loop until the implementation goes green
16. Lead runs the final PR review (correctness pass + any complexity/scoring skills installed), writes findings to `data/review.db`
17. Lead surfaces the PR review to the human as a grilling session; once approved, offers to log **PR Review** to the external sink
18. Lead synthesises the outcome and confirms every stage left a DB record and, where approved, a matching external-sink section

Operational rule:
- when the task is planning-heavy and can be delegated, delegate directly to Planner
- when the task is implementation-heavy, delegate directly to Developer
- when the task is implementation validation, delegate directly to Tester
- for implementation delegation, explicitly confirm Developer's model path with the human before execution
- if a subagent flow is available, do not fall back to manual polling or synchronous blocking unless necessary
- if a background handoff arrives while Lead is doing something else, Lead must stop, surface that result, resolve any immediate follow-up or documentation from it, and only then resume the prior thread

### 1. Plan first
Before making changes, create or update a structured **Approach** record.

Default ownership:
- **Planner** is responsible for writing the plan into `data/approach.db`
- **Lead** is responsible for turning the latest approved Planner output into a readable Markdown artifact in `docs/`
- Lead should not manually replace Planner's DB step when a planner subagent flow is available, except as a fallback

The plan should capture:
- story reference
- scope
- assumptions
- ordered plan steps
- acceptance criteria
- positive / negative / edge test ideas
- risks
- model used
- story class

### 2. Freeze the plan for the cycle
Once execution starts, Developer and Tester work against the same frozen plan for that cycle.
Do not silently mutate the plan mid-cycle.
If scope changes materially, create a new plan revision or new cycle entry.

### 3. Capture execution structurally
Implementation work must leave a structured local artifact and must not live only in chat history.

Default ownership:
- Developer writes execution records to `data/implementation.db`

Capture at least:
- artifact created or modified
- file paths or artifact refs
- status
- model used
- commands or tool calls when they are needed to explain the result

### 4. Check independently
Tester should verify:
- drift from the Approach plan
- defects
- missing coverage
- weak assumptions
- mismatch between expected and actual behavior

Tester is checking Developer's in-progress work against the plan, not a submitted GitHub PR — a full PR-review pipeline (classifier, axis sub-agents, GitHub publish) doesn't fit that context and Tester should not invoke one even if it's installed. If a PR-scoring skill's rubric/ordinal-band language is available, Tester may borrow it for structuring findings — see `agents/tester.md` — but that's optional, not a hard dependency.

Default ownership:
- **Tester** is responsible for writing structured findings into `data/feedback.db`
- feedback capture should happen as part of the checking flow, not as an afterthought by Lead
- **Developer** should treat `data/feedback.db` as the next input when Tester's findings require another implementation pass

Log findings into **Feedback** in structured form.

### 5. Review the outcome
Once Developer and Tester's cycle goes green, Lead reviews the final diff (correctness pass + any installed complexity-review skill) and writes findings to `data/review.db`. See PR Review Rule.

### 6. Promote useful findings
Recurring or high-value findings should become:
- eval candidates
- future guardrails
- learning patterns

## Minimum capture contract

Every implementation or checking cycle should leave behind:
- one Approach record for the active plan revision
- one or more Feedback records
- an Implementation record once `data/implementation.db` is adopted
- a Review record once the PR review stage runs

Planning-only cycles must leave behind:
- one Approach record

### Plan identity rule
Each cycle revision ties together `data/approach.db`, `data/implementation.db`, `data/feedback.db`, `data/review.db`, `docs/`, and (if configured) the external sink through a shared cycle identifier. Use a story/ticket ID plus a revision suffix (e.g. `-R1`, `-R2`) as the cycle key across all artifacts.

### Checker evidence rule
Every Feedback record in `data/feedback.db` must include:
- The test case or scenario that was checked
- Expected behavior vs actual behavior
- Evidence: file path, command output, or observed behavior that supports the finding
- Severity classification (blocker, defect, gap, or informational)

For the current harness phase, treat these ownership rules as explicit:
- **Planner** writes or updates the Approach record in `data/approach.db`
- **Lead** creates or refreshes the corresponding human-readable plan artifact in `docs/` after Planner completes
- **Developer** writes execution records to `data/implementation.db`
- **Tester** writes or updates Feedback records in `data/feedback.db`
- **Lead** writes Review records to `data/review.db` after the final PR review
- the active session may also persist per-role runtime configuration across three layers — session, project (`data/agent-session-profile.json`), and global (user-level, shared across projects) — resolved with session > project > global precedence
- if only planning is happening, the Planner-owned Approach record is still required even if no implementation has started
- if implementation/checking happens, Feedback capture is required before the cycle is considered complete

Adopt incrementally: `data/approach.db` and `data/feedback.db` first, then `data/implementation.db` and `data/review.db` once the basic loop is working. `learning.db` remains optional until that part of the harness is adopted.

## Human approval gates

Keep a human in the loop for:
- approving the plan when scope is ambiguous or high impact
- approving Developer's output before it's logged as Implementation Notes
- approving Tester's findings before they're logged as Observations
- approving Lead's PR review before it's logged and considered done
- approving eval promotion for canonical test cases
- approving major workflow/schema changes
- approving risky production changes

Every one of these runs as a Grilling Discipline session (see above), not a single yes/no prompt.

## Bias toward standard paths

Do not reinvent the wheel unless necessary.
When tooling already exists and is good enough, prefer:
- standard community integrations
- existing project conventions
- simple scripts over custom frameworks

Build custom machinery only when the standard path clearly fails the requirement.

## SQLite usage rules

SQLite DBs should be:
- local to the project under `data/`
- easy to inspect with `sqlite3`
- append-friendly
- queryable across cycles

Prefer simple schemas over overly abstract ones. Writes go through `record_cycle` (see Structured Cycle Capture); direct `sqlite3` remains the normal way to read/inspect these DBs, just not to write to them.

## Notification rules (optional)

If you want a phone/desktop notification on lifecycle milestones, [ntfy.sh](https://ntfy.sh) is a zero-setup option — pick your own topic name (topics are unauthenticated pub/sub, so don't reuse a guessable/shared one) and set it below.

Lifecycle milestones worth notifying on:
- Planner run completed
- Developer run completed
- Tester run completed
- Lead PR review completed
- Lead direct task completed when it changed code, config, data, or deployment state
- blocked or failed work that needs human input

**Topic:** `<your-ntfy-topic>` (pick your own, configurable per project)
**Endpoint:** `https://ntfy.sh/<your-ntfy-topic>`

**Notification format:**
```
curl -s \
  -d "<role> <runId> completed: <verdict/summary>" \
  -H "Priority: <urgent|high|default|low>" \
  -H "Tags: <emoji_tag>" \
  https://ntfy.sh/<your-ntfy-topic>
```

**Priority mapping:**
- Tester finds a release blocker → `urgent`, tag: `red_circle`
- Tester finds issues to fix → `high`, tag: `warning`
- Developer/Tester completes clean → `default`, tag: `white_check_mark`
- Planner completes → `default`, tag: `memo`
- Lead's PR review completes → `default`, tag: `white_check_mark` (or `warning`/`red_circle` if it found blockers)
- Blocked or failed run → `high`, tag: `x`

**Operational rule (if notifications are configured):**
- Send the notification **immediately** when work completes, before any other processing
- Include the runId (if applicable), role/agent, and a one-line verdict/summary
- Do not send notifications for intermediate status checks — only for completion events
- If the human is actively watching the terminal, the notification is still sent (phone may be away from desk)

If you haven't set up a notification endpoint, skip this section — nothing else in this file depends on it.

## Recommended v1 harness behavior

For a new project, the harness should do this:
1. Planner runs the intake checklist and ingests story context from wherever the human points it (external tracker, GitHub, local docs)
2. resolve and silently adopt the session agent profile (session > project > global) when the session starts
3. Planner creates an Approach record in `data/approach.db`
4. human approves the plan via a grilling session; Planner offers to log Plan of Action to the external sink
5. Developer executes implementation/testing work and writes to `data/implementation.db` before finishing (not gated on approval)
6. human approves Developer's output; Developer offers to log Implementation Notes to the external sink
7. Tester creates Feedback records in `data/feedback.db`
8. human approves Tester's findings; Tester offers to log Observations to the external sink
9. Lead runs the final PR review, writes to `data/review.db`, and offers to log PR Review to the external sink once approved

## File roles

- `AGENTS.md` = operating instructions for agents
- `docs/` = detailed harness design/specs and human-readable plan artifacts
- `data/` = SQLite cycle memory and the project-level session profile (`data/agent-session-profile.json`)
- global (user-level) agent profile state lives outside the project, shared across projects; project and session values override it per the session configuration rule
- `scripts/` or `harness/` = automation implementation

## Response style for agents following this file

- be direct
- prefer practical execution over long theory
- research first when choosing an approach
- pause when there is real ambiguity or risk
- keep outputs structured when they will be reused later
- answer simple acknowledgements or yes/no questions immediately
- avoid doing hidden extra work before replying to lightweight coordination questions
- when delegated work is running, stay responsive and communicate like an orchestrator, not a blocked worker
- prefer subagent status/result/cancel flows over manual polling scripts when subagent tooling is available
- for planning work, treat returned delegated output as something to present for human review first, not something to auto-grade with a checker
- send a completion notification immediately when any background subagent completes, if notifications are configured (see Notification rules)
