#!/usr/bin/env node
// Applies core-patches.mjs's content-anchored operations against a
// pi-coding-agent package root. Searches every dist/**/*.js file (not a
// hardcoded path) so this works whether pi ships modular dist/*.js files
// or a pre-built dist/bundle/chunks/*.js bundle, and keeps working if the
// bundle's chunk splitting shuffles again later.
//
// Usage: node apply-patches.mjs <pkgRoot>
// Prints a JSON report to stdout: { applied: [...], failed: [...], touchedFiles: [...] }
// Exit code 0 if every operation applied; 1 if any anchor was missing or ambiguous.

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const patchesPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "core-patches.mjs");
const { patches } = await import(patchesPath);

const pkgRoot = process.argv[2];
if (!pkgRoot) {
  console.error("Usage: apply-patches.mjs <pkgRoot>");
  process.exit(2);
}

function findJsFiles(dir) {
  let out = [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out = out.concat(findJsFiles(full));
    } else if (entry.isFile() && entry.name.endsWith(".js") && !entry.name.endsWith(".min.js.map")) {
      out.push(full);
    }
  }
  return out;
}

const distDir = path.join(pkgRoot, "dist");
const files = findJsFiles(distDir);
const contents = new Map(files.map((f) => [f, fs.readFileSync(f, "utf8")]));

const applied = [];
const alreadyApplied = [];
const failed = [];
const touchedFiles = new Set();

for (const op of patches) {
  // Check this BEFORE looking at the anchor at all. Several operations'
  // replacements contain the anchor as a substring (e.g. inserting a new
  // class right before an existing declaration keeps that declaration's
  // text intact) — if that anchor were searched for first, a second run
  // would find it again and duplicate the insertion (a duplicate `class`
  // declaration is a hard SyntaxError, not just redundant bloat). So an
  // already-applied operation must short-circuit here, unconditionally.
  const alreadyPresent = [...contents.values()].some((content) => content.includes(op.replacement));
  if (alreadyPresent) {
    alreadyApplied.push({ id: op.id, description: op.description });
    continue;
  }

  const matches = [];
  for (const [file, content] of contents) {
    const count = content.split(op.anchor).length - 1;
    if (count > 0) matches.push({ file, count });
  }
  const totalCount = matches.reduce((sum, m) => sum + m.count, 0);

  if (totalCount === 0) {
    failed.push({ id: op.id, description: op.description, reason: "anchor-not-found" });
    continue;
  }
  if (totalCount > 1) {
    failed.push({
      id: op.id,
      description: op.description,
      reason: "ambiguous",
      files: matches.map((m) => ({ file: path.relative(pkgRoot, m.file), count: m.count })),
    });
    continue;
  }

  const { file } = matches[0];
  const content = contents.get(file);
  contents.set(file, content.replace(op.anchor, op.replacement));
  touchedFiles.add(file);
  applied.push({ id: op.id, description: op.description, file: path.relative(pkgRoot, file) });
}

for (const file of touchedFiles) {
  fs.writeFileSync(file, contents.get(file));
}

console.log(JSON.stringify({ applied, alreadyApplied, failed, touchedFiles: Array.from(touchedFiles).map((f) => path.relative(pkgRoot, f)) }, null, 2));
process.exit(failed.length > 0 ? 1 : 0);
