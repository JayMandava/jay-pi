# Core patch pack

Maintains hand-applied fixes to the installed `@earendil-works/pi-coding-agent`
npm package that would otherwise be wiped by every pi upgrade.

## Why content-anchored, not line diffs

Older pi releases shipped modular files (`dist/cli.js` → `dist/modes/...`,
`dist/core/...`, one file per module, stable paths), so a unified diff keyed
to a specific path was a reasonable way to patch them.

**As of pi 0.84.3, the CLI's actual entry point moved to `dist/bundle/cli.js`**
— a single pre-built, minified bundle split across content-hash-named chunk
files (`dist/bundle/chunks/chunk-XXXXXXXX.js`). Chunk filenames aren't stable
across builds — the same code can land in a different chunk next release —
so a diff keyed to a specific file path has nothing reliable left to anchor
on.

`core-patches.mjs` sidesteps that: each operation names an exact source-code
substring to find (`anchor`) and what to replace it with (`replacement`).
`apply-patches.mjs` searches every `dist/**/*.js` file in the package —
covering both the old modular shape and the new bundled one — and only
applies an operation when its anchor is found in exactly one place across the
whole package. Idempotent: re-running against an already-patched install is a
safe no-op (it checks whether `replacement` is already present before ever
looking at `anchor`).

There is **one canonical `core-patches.mjs`**, not a new file per pi version.
When a pi update breaks an operation (its anchor no longer matches, because
upstream changed the code around it), fix it by finding the new surrounding
text and editing that operation's `anchor`/`replacement` in place — see
"Self-healing" below.

Currently ships one operation: a genuine `pi-tui` `Markdown` rendering bug
(soft line breaks inside a paragraph were rendered as hard breaks instead of
collapsing to whitespace, per CommonMark) that shows up as one-word/one-phrase-
per-line "thinking" text from some model providers regardless of terminal
width.

## Reapply after a pi upgrade

```sh
~/.pi/agent/patches/reapply.sh
```

Then restart pi or run `/reload`.

If the script reports any operations as `anchor-not-found` or `ambiguous`, pi
changed upstream near that spot — run `self-heal.sh` (below) to diagnose in a
sandbox rather than editing the live install directly.

Optional override:

```sh
PI_PKG=/path/to/@earendil-works/pi-coding-agent ~/.pi/agent/patches/reapply.sh
```

## Self-healing after a pi upgrade breaks a patch

`self-heal.sh` detects when a pi update broke one or more `core-patches.mjs`
operations and prepares a sandbox to diagnose the break in — without ever
touching the live install.

```sh
~/.pi/agent/patches/self-heal.sh check
```

- If the current pi version already matches the last-healed version
  (`.last-healed-version`), it reports healthy and exits — nothing to do.
- If pi updated, it fetches a fresh pristine copy of that exact version
  (`npm install ...@<version> --no-save`), runs every `core-patches.mjs`
  operation against a `candidate` copy of it, and syntax-checks
  (`node --check`) every file that got touched. If everything applies clean,
  it marks the new version healed — run `reapply.sh` to apply to the live
  install as usual.
- If anything failed, it prints exactly which operation(s) and why
  (`anchor-not-found` — upstream changed the code around that spot;
  `ambiguous` — the anchor text matches more than once now, needs to be more
  specific) and leaves a sandbox at `.self-heal-work/<version>/`: `pristine/`
  (untouched reference) and `candidate/` (every operation that *did* apply is
  already reflected here). **The live install is never touched by `check`.**

Fixing a broken operation:

1. Open `.self-heal-work/<version>/pristine/` and find the new surrounding
   text for whatever changed.
2. Edit that operation's `anchor`/`replacement` directly in
   `core-patches.mjs` — there's no separate draft/regenerate step, this file
   *is* the patch.
3. Re-run `self-heal.sh check` to confirm it now applies clean against a
   fresh pristine copy.
4. Review the `core-patches.mjs` diff, then run `reapply.sh` to apply it to
   the live install.

**Division of labor:** `check` and `reapply.sh` are mechanical and safe to
run unattended for anything that already applies clean — `check` never
writes to the live install regardless of outcome. Fixing a broken operation
needs judgment (reading the pristine sandbox, finding where an upstream
refactor moved the old anchor point) — that's implementer (Harry) work, not
the script's, and the `core-patches.mjs` edit should be reviewed by a human
before `reapply.sh` runs. See the Core Patch Self-Heal Rule in `AGENTS.md`.
