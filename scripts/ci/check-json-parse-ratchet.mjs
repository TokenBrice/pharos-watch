#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { relative } from "node:path";
import { runCountRatchet } from "../lib/count-ratchet.mjs";
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
  return runCountRatchet({
    collectCounts: () => collectWorkerJsonParseUsage(roots, cwd),
    baselinePath,
    cwd,
    updateBaseline,
    stdout,
    stderr,
    labels: {
      baselineUpdated: "Worker raw JSON.parse baseline updated",
      failedToReadBaseline: "[json-parse-ratchet] Failed to read baseline",
      missingBaseline: "[json-parse-ratchet] Missing baseline",
      increased: "Worker raw JSON.parse usage increased",
      ok: "Worker JSON.parse usage",
      countNoun: "raw calls",
    },
    remediation: `Use ${SANCTIONED_HELPER_PATH} helpers instead of adding raw JSON.parse calls.`,
  });
}

runAsCli(import.meta.url, () => checkJsonParseRatchet({ updateBaseline: process.argv.includes("--update-baseline") }));
