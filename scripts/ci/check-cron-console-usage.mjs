#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { collectSourceFiles } from "../lib/source-files.mjs";

const DEFAULT_ROOTS = ["worker/src/cron", "worker/src/handlers/scheduled.ts"];
const BASELINE_PATH = "scripts/lib/cron-console-usage-baseline.json";
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".mjs"]);
const EXCLUDED_DIRS = new Set(["__tests__", "__mocks__"]);
const CONSOLE_CALL_PATTERN = /\bconsole\.(?:log|warn|error|info|debug)\s*\(/g;

function collectFiles(root, cwd) {
  const absolute = join(cwd, root);
  if (!existsSync(absolute)) return [];
  const stats = statSync(absolute);
  if (stats.isFile()) return [absolute];
  return collectSourceFiles(absolute, { extensions: SOURCE_EXTENSIONS, excludedDirs: EXCLUDED_DIRS });
}

export function collectCronConsoleUsage(roots = DEFAULT_ROOTS, cwd = process.cwd()) {
  const counts = {};

  for (const root of roots) {
    for (const file of collectFiles(root, cwd)) {
      const rel = relative(cwd, file).replaceAll("\\", "/");
      const source = readFileSync(file, "utf8");
      const count = [...source.matchAll(CONSOLE_CALL_PATTERN)].length;
      if (count > 0) counts[rel] = count;
    }
  }

  return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
}

function readBaseline(path, cwd) {
  const absolute = join(cwd, path);
  if (!existsSync(absolute)) return null;
  const parsed = JSON.parse(readFileSync(absolute, "utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${path} must contain a JSON object`);
  }
  return parsed;
}

function writeBaseline(path, counts, cwd) {
  const absolute = join(cwd, path);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, `${JSON.stringify(counts, null, 2)}\n`);
}

export function checkCronConsoleUsage({
  roots = DEFAULT_ROOTS,
  baselinePath = BASELINE_PATH,
  cwd = process.cwd(),
  updateBaseline = false,
  stdout = process.stdout,
  stderr = process.stderr,
} = {}) {
  const current = collectCronConsoleUsage(roots, cwd);

  if (updateBaseline) {
    writeBaseline(baselinePath, current, cwd);
    stdout.write(`Cron console usage baseline updated (${Object.keys(current).length} file entries).\n`);
    return 0;
  }

  let baseline;
  try {
    baseline = readBaseline(baselinePath, cwd);
  } catch (error) {
    stderr.write(`[cron-console] Failed to read baseline: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }

  if (!baseline) {
    stderr.write(`[cron-console] Missing baseline at ${baselinePath}. Run with --update-baseline.\n`);
    return 1;
  }

  const violations = [];
  for (const [file, count] of Object.entries(current)) {
    const baselineCount = Number(baseline[file] ?? 0);
    if (!Number.isFinite(baselineCount) || count > baselineCount) {
      violations.push({ file, count, baselineCount: Number.isFinite(baselineCount) ? baselineCount : 0 });
    }
  }

  if (violations.length > 0) {
    stderr.write("Cron raw console usage increased:\n\n");
    for (const violation of violations) {
      stderr.write(`  ${violation.file}: ${violation.count} > baseline ${violation.baselineCount}\n`);
    }
    stderr.write("\nUse cron structured logging helpers instead of adding raw console.* calls.\n");
    return 1;
  }

  const currentTotal = Object.values(current).reduce((sum, count) => sum + count, 0);
  const baselineTotal = Object.values(baseline).reduce((sum, count) => sum + Number(count), 0);
  stdout.write(`Cron console usage: OK (${currentTotal}/${baselineTotal} raw calls at or below baseline)\n`);
  return 0;
}

const isDirectRun = process.argv[1]
  ? import.meta.url === pathToFileURL(process.argv[1]).href
  : false;

if (isDirectRun) {
  process.exitCode = checkCronConsoleUsage({ updateBaseline: process.argv.includes("--update-baseline") });
}
