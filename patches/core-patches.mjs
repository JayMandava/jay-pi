// Canonical, content-anchored patch operations for the installed
// @earendil-works/pi-coding-agent package.
//
// pi 0.84.3 switched the CLI's actual entry point from `dist/cli.js` (modular
// source files, one per module, stable paths) to `dist/bundle/cli.js` (a
// single pre-built, minified bundle split across content-hash-named chunk
// files, e.g. `chunk-E5KXRMZK.js`). Chunk filenames are not stable across
// builds — the same code can land in a different chunk next release — so a
// unified diff keyed to a specific dist file no longer has anything reliable
// to anchor on.
//
// Each operation here instead anchors on an exact source-code substring.
// apply-patches.mjs searches every `dist/**/*.js` file (covering both the
// modular and bundled shapes, so this keeps working if upstream ever
// reshuffles again) for `anchor`, and only applies `replacement` when the
// anchor is found in exactly one place across the whole package — ambiguous
// or missing anchors are reported, never guessed at.
//
// When a pi update breaks an operation (anchor no longer found, or newly
// ambiguous), fix it by finding the new surrounding text and editing that
// operation's `anchor`/`replacement` in place here — there is no separate
// per-version patch file to regenerate. See self-heal.sh.

export const patches = [
  {
    id: "markdown-soft-linebreak-fix",
    description:
      "Markdown inline text incorrectly joins internal single-newline segments with a literal newline instead of a space, so any text containing soft line breaks " +
      "(CommonMark: a lone \\n inside a paragraph should collapse to whitespace, not a hard break) renders one fragment per line regardless of terminal width. " +
      "Reproduced live: assistant \"thinking\" content from some models/providers streams reasoning text with embedded single newlines between short phrases — " +
      "with this bug, each phrase renders on its own line instead of flowing into wrapped paragraphs.",
    anchor: "applyTextWithNewlines=text=>text.split(`\n`).map(segment2=>applyText(segment2)).join(`\n`)",
    replacement: 'applyTextWithNewlines=text=>text.split(`\n`).map(segment2=>applyText(segment2)).join(" ")',
  },
];
