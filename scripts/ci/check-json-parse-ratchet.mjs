#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { collectSourceFilesUnderRoot, runAsCli } from "../lib/source-files.mjs";

export const DEFAULT_JSON_PARSE_ROOTS = ["worker/src"];
const BASELINE_PATH = "scripts/lib/json-parse-ratchet-baseline.json";
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".mjs"]);
// Test code frequently inspects serialized fixtures and response bodies, so __tests__ may parse freely.
const EXCLUDED_DIRS = new Set(["__tests__"]);
const JSON_PARSE_PATTERN = /\bJSON\.parse\s*\(/g;
const SANCTIONED_HELPER_PATH = "worker/src/lib/json-parse.ts";

function lineTextAt(source, offset) {
  const lineStart = source.lastIndexOf("\n", offset) + 1;
  const lineEnd = source.indexOf("\n", offset);
  return source.slice(lineStart, lineEnd === -1 ? source.length : lineEnd).trim();
}

function collectJsonParseCalls(source) {
  const calls = [];
  for (const match of source.matchAll(JSON_PARSE_PATTERN)) {
    const offset = match.index ?? 0;
    const text = lineTextAt(source, offset);
    if (text.startsWith("//") || text.startsWith("*") || text.startsWith("/*")) {
      continue;
    }
    calls.push({ text });
  }
  return calls;
}

export function collectWorkerJsonParseUsage(roots = DEFAULT_JSON_PARSE_ROOTS, cwd = process.cwd()) {
  const counts = {};

  for (const root of roots) {
    for (const file of collectSourceFilesUnderRoot(root, cwd, {
      extensions: SOURCE_EXTENSIONS,
      excludedDirs: EXCLUDED_DIRS,
    })) {
      const rel = relative(cwd, file).replaceAll("\\", "/");
      if (rel === SANCTIONED_HELPER_PATH) {
        continue;
      }
      const source = readFileSync(file, "utf8");
      const count = collectJsonParseCalls(source).length;
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

/**
 * @param {{
 *   roots?: string[], baselinePath?: string, cwd?: string, updateBaseline?: boolean,
 *   stdout?: { write(chunk: string): unknown }, stderr?: { write(chunk: string): unknown },
 * }} [options]
 */
export function checkJsonParseRatchet({
  roots = DEFAULT_JSON_PARSE_ROOTS,
  baselinePath = BASELINE_PATH,
  cwd = process.cwd(),
  updateBaseline = false,
  stdout = process.stdout,
  stderr = process.stderr,
} = {}) {
  const current = collectWorkerJsonParseUsage(roots, cwd);

  if (updateBaseline) {
    writeBaseline(baselinePath, current, cwd);
    stdout.write(`Worker raw JSON.parse baseline updated (${Object.keys(current).length} file entries).\n`);
    return 0;
  }

  let baseline;
  try {
    baseline = readBaseline(baselinePath, cwd);
  } catch (error) {
    stderr.write(
      `[json-parse-ratchet] Failed to read baseline: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return 1;
  }

  if (!baseline) {
    stderr.write(`[json-parse-ratchet] Missing baseline at ${baselinePath}. Run with --update-baseline.\n`);
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
    stderr.write("Worker raw JSON.parse usage increased:\n\n");
    for (const violation of violations) {
      stderr.write(`  ${violation.file}: ${violation.count} > baseline ${violation.baselineCount}\n`);
    }
    stderr.write(`\nUse ${SANCTIONED_HELPER_PATH} helpers instead of adding raw JSON.parse calls.\n`);
    return 1;
  }

  const currentTotal = Object.values(current).reduce((sum, count) => sum + count, 0);
  const baselineTotal = Object.values(baseline).reduce((sum, count) => sum + Number(count), 0);
  stdout.write(`Worker JSON.parse usage: OK (${currentTotal}/${baselineTotal} raw calls at or below baseline)\n`);
  return 0;
}

runAsCli(import.meta.url, () => checkJsonParseRatchet({ updateBaseline: process.argv.includes("--update-baseline") }));
