#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { relative } from "node:path";
import { runCountRatchet } from "../lib/count-ratchet.mts";
import { collectSourceFilesUnderRoot, runAsCli } from "../lib/source-files.mts";

/**
 * Duplicated-code ratchet.
 *
 * Consolidation waves remove copy-pasted scaffolding; without a gate the same
 * duplication regrows the next time a suite or endpoint is cloned. This counts
 * exactly-duplicated lines per file and fails when any file's count increases,
 * exactly like the raw-console ratchet.
 *
 * Detection is deliberately conservative: comment-stripped, whitespace-normalised
 * windows of WINDOW_LINES consecutive significant lines, hashed, and reported only
 * when the same window appears in two or more distinct files. Near-clones (same
 * shape, different constants) are invisible to it, so the count is a floor.
 */

export const DEFAULT_CLONE_ROOTS = ["src", "shared", "worker/src", "functions", "scripts"];

const BASELINE_PATH = "scripts/lib/clone-ratchet-baseline.json";
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx"]);
const EXCLUDED_DIRS = new Set(["node_modules", "__snapshots__"]);

/** Consecutive significant lines that must match before a region counts as duplicated. */
const WINDOW_LINES = 12;

/** Files below this size cannot contain a window and are skipped outright. */
const MIN_SIGNIFICANT_LINES = WINDOW_LINES;

function isScannableFile(rel: string): boolean {
  if (rel.endsWith(".d.ts")) return false;
  // Generated artifacts carry generator-owned formatting and repeat by design.
  if (rel.includes(".generated.")) return false;
  return true;
}

/**
 * Strips comments and blank lines and collapses interior whitespace so that
 * re-indentation or a reflowed comment cannot hide or invent a clone.
 */
export function significantLines(source: string): string[] {
  const out: string[] = [];
  let inBlockComment = false;

  for (const raw of source.split(/\r?\n/g)) {
    let line = raw.trim();

    if (inBlockComment) {
      const close = line.indexOf("*/");
      if (close === -1) continue;
      inBlockComment = false;
      line = line.slice(close + 2).trim();
    }

    while (line.startsWith("/*")) {
      const close = line.indexOf("*/", 2);
      if (close === -1) {
        inBlockComment = true;
        line = "";
        break;
      }
      line = (line.slice(0, 0) + line.slice(close + 2)).trim();
    }

    if (line.length === 0) continue;
    if (line.startsWith("//")) continue;

    out.push(line.replace(/\s+/g, " "));
  }

  return out;
}

function windowHash(lines: readonly string[], start: number): string {
  const hash = createHash("sha1");
  for (let index = start; index < start + WINDOW_LINES; index += 1) {
    hash.update(lines[index]);
    hash.update("\n");
  }
  return hash.digest("base64");
}

function mergedLength(intervals: readonly [number, number][]): number {
  if (intervals.length === 0) return 0;
  const sorted = [...intervals].sort((left, right) => left[0] - right[0]);
  let total = 0;
  let [spanStart, spanEnd] = sorted[0];

  for (let index = 1; index < sorted.length; index += 1) {
    const [start, end] = sorted[index];
    if (start <= spanEnd) {
      spanEnd = Math.max(spanEnd, end);
      continue;
    }
    total += spanEnd - spanStart;
    [spanStart, spanEnd] = [start, end];
  }

  return total + (spanEnd - spanStart);
}

export function collectDuplicatedLineCounts(
  roots: readonly string[] = DEFAULT_CLONE_ROOTS,
  cwd = process.cwd(),
): Record<string, number> {
  const normalised = new Map<string, string[]>();

  for (const root of roots) {
    for (const absolute of collectSourceFilesUnderRoot(root, cwd, {
      extensions: SOURCE_EXTENSIONS,
      excludedDirs: EXCLUDED_DIRS,
    })) {
      const rel = relative(cwd, absolute).split("\\").join("/");
      if (!isScannableFile(rel) || normalised.has(rel)) continue;
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- path comes from the explicit scan roots
      const lines = significantLines(readFileSync(absolute, "utf8"));
      if (lines.length < MIN_SIGNIFICANT_LINES) continue;
      normalised.set(rel, lines);
    }
  }

  const occurrences = new Map<string, { rel: string; start: number }[]>();
  for (const [rel, lines] of normalised) {
    for (let start = 0; start + WINDOW_LINES <= lines.length; start += 1) {
      const key = windowHash(lines, start);
      const bucket = occurrences.get(key);
      if (bucket) bucket.push({ rel, start });
      else occurrences.set(key, [{ rel, start }]);
    }
  }

  const spans = new Map<string, [number, number][]>();
  for (const bucket of occurrences.values()) {
    if (bucket.length < 2) continue;
    let distinct = false;
    for (let index = 1; index < bucket.length; index += 1) {
      if (bucket[index].rel !== bucket[0].rel) {
        distinct = true;
        break;
      }
    }
    if (!distinct) continue;

    for (const { rel, start } of bucket) {
      const bySpan = spans.get(rel);
      const span: [number, number] = [start, start + WINDOW_LINES];
      if (bySpan) bySpan.push(span);
      else spans.set(rel, [span]);
    }
  }

  const counts: Record<string, number> = {};
  for (const rel of [...spans.keys()].sort()) {
    counts[rel] = mergedLength(spans.get(rel) ?? []);
  }
  return counts;
}

export function checkCloneRatchet({
  roots = DEFAULT_CLONE_ROOTS,
  baselinePath = BASELINE_PATH,
  cwd = process.cwd(),
  updateBaseline = false,
  stdout = process.stdout,
  stderr = process.stderr,
}: {
  roots?: readonly string[];
  baselinePath?: string;
  cwd?: string;
  updateBaseline?: boolean;
  stdout?: { write(chunk: string): unknown };
  stderr?: { write(chunk: string): unknown };
} = {}): number {
  return runCountRatchet({
    collectCounts: () => collectDuplicatedLineCounts(roots, cwd),
    baselinePath,
    cwd,
    updateBaseline,
    stdout,
    stderr,
    labels: {
      baselineUpdated: "Duplicated-line baseline updated",
      failedToReadBaseline: "[clone-ratchet] Failed to read baseline",
      missingBaseline: "[clone-ratchet] Missing baseline",
      increased: "Duplicated lines increased",
      ok: "Duplicated lines",
      countNoun: "duplicated lines",
    },
    remediation:
      "Extract the shared scaffolding instead of copying it: put test fixtures in a sibling *.test-support.ts and shared logic in shared/lib. See agents/2026-08-23-recon/PLAN.md.",
  });
}

runAsCli(import.meta.url, () => checkCloneRatchet({ updateBaseline: process.argv.includes("--update-baseline") }));
