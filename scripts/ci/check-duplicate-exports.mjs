#!/usr/bin/env node
/**
 * Detects duplicate `export` names within any single .ts/.tsx file
 * in shared/lib and src/lib. Catches post-merge conflicts from
 * parallel worktree development.
 */
import { readFileSync } from "node:fs";
import { relative } from "node:path";
import { collectSourceFiles } from "../lib/source-files.mjs";

const DIRS = ["shared/lib", "src/lib", "worker/src/lib"];
const EXPORT_RE = /^export\s+(?:const|let|function|class|type|interface|enum)\s+(\w+)/gm;

let errors = 0;

for (const dir of DIRS) {
  for (const full of collectSourceFiles(dir, { extensions: new Set([".ts", ".tsx"]) })) {
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

if (errors > 0) {
  console.error(`\n${errors} duplicate export(s) found.`);
  process.exit(1);
} else {
  console.log("No duplicate exports found.");
}
