#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = process.cwd();

function readDoc(path) {
  return readFileSync(resolve(root, path), "utf8");
}

function normalizeDoc(text) {
  return text
    .replace("kept in sync with `CLAUDE.md`", "kept in sync with `AGENTS.md`")
    .replace(/CLAUDE\.md/g, "AGENTS.md");
}

const agents = normalizeDoc(readDoc("AGENTS.md"));
const claude = normalizeDoc(readDoc("CLAUDE.md"));

if (agents !== claude) {
  console.error("AGENTS.md and CLAUDE.md are out of sync. Mirror rule/gotcha/repo-map changes in both files.");
  process.exit(1);
}

console.log("Agent docs sync: OK");
