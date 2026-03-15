#!/usr/bin/env node
/**
 * Detects duplicate `export` names within any single .ts/.tsx file
 * in shared/lib and src/lib. Catches post-merge conflicts from
 * parallel worktree development.
 */
import { readFileSync, readdirSync, statSync } from "fs";
import { join, relative } from "path";

const DIRS = ["shared/lib", "src/lib", "worker/src/lib"];
const EXT_RE = /\.(ts|tsx)$/;
const EXPORT_RE = /^export\s+(?:const|let|function|class|type|interface|enum)\s+(\w+)/gm;

let errors = 0;

function scanDir(dir) {
  let entries;
  try { entries = readdirSync(dir); } catch { return; }
  for (const entry of entries) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) { scanDir(full); continue; }
    if (!EXT_RE.test(entry)) continue;

    const content = readFileSync(full, "utf-8");
    const seen = new Map();
    let match;
    EXPORT_RE.lastIndex = 0;
    while ((match = EXPORT_RE.exec(content)) !== null) {
      const name = match[1];
      const line = content.slice(0, match.index).split("\n").length;
      if (seen.has(name)) {
        console.error(`DUPLICATE: ${relative(".", full)} exports "${name}" at lines ${seen.get(name)} and ${line}`);
        errors++;
      } else {
        seen.set(name, line);
      }
    }
  }
}

for (const dir of DIRS) scanDir(dir);

if (errors > 0) {
  console.error(`\n${errors} duplicate export(s) found.`);
  process.exit(1);
} else {
  console.log("No duplicate exports found.");
}
