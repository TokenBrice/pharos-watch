#!/usr/bin/env node
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, extname } from "node:path";

const WORKER_SRC = "worker/src";
const INTERPOLATION_PATTERN = /`[^`]*(?:FROM|INTO|UPDATE|DELETE\s+FROM|JOIN)\s+\$\{/;
const SAFETY_PATTERN = /(?:\/\/\s*SAFETY:|\.has\(|throw\s+new\s+Error)/;

function collectTsFiles(dir, files = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      if (entry === "__tests__" || entry === "__mocks__" || entry === "node_modules") continue;
      collectTsFiles(full, files);
    } else if (stat.isFile() && (extname(full) === ".ts" || extname(full) === ".tsx")) {
      files.push(full);
    }
  }
  return files;
}

const files = collectTsFiles(WORKER_SRC);
const violations = [];

for (const file of files) {
  const content = readFileSync(file, "utf8");
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (INTERPOLATION_PATTERN.test(lines[i])) {
      const context = lines.slice(Math.max(0, i - 5), i + 1).join("\n");
      if (!SAFETY_PATTERN.test(context)) {
        violations.push({ file, line: i + 1, text: lines[i].trim() });
      }
    }
  }
}

if (violations.length > 0) {
  process.stderr.write("SQL interpolation sites missing allowlist validation or SAFETY comment:\n\n");
  for (const v of violations) {
    process.stderr.write(`  ${v.file}:${v.line}: ${v.text}\n`);
  }
  process.stderr.write(`\n${violations.length} violation(s) found.\n`);
  process.stderr.write("Fix: add allowlist Set + .has() validation, or a // SAFETY: comment.\n");
  process.exit(1);
}
process.stdout.write("SQL interpolation safety: OK\n");
