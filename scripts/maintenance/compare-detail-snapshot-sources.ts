#!/usr/bin/env node

import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseCliInteger, parseStrictCliArgs, runDirectCli, writeCliHelpIfRequested } from "../lib/cli-args.mjs";
import { generateSnapshots, writeSnapshots } from "../build-data/build-stablecoin-detail-snapshots";

interface ComparisonOptions {
  keepDir?: string;
  diffLimit?: number;
}

interface JsonDifference {
  path: string;
  kind: "value" | "missing-per-coin" | "missing-bulk" | "key-order" | "serialization";
  perCoin?: unknown;
  bulk?: unknown;
}

export function diffJsonFields(perCoin: unknown, bulk: unknown, path = "$"): JsonDifference[] {
  if (Object.is(perCoin, bulk)) return [];
  if (perCoin === null || bulk === null || typeof perCoin !== "object" || typeof bulk !== "object" ||
      Array.isArray(perCoin) !== Array.isArray(bulk)) {
    return [{ path, kind: "value", perCoin, bulk }];
  }
  const left = perCoin as Record<string, unknown>;
  const right = bulk as Record<string, unknown>;
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  const differences: JsonDifference[] = [];
  if (leftKeys.length === rightKeys.length && leftKeys.every((key) => Object.hasOwn(right, key)) &&
      leftKeys.some((key, index) => key !== rightKeys[index])) {
    differences.push({ path, kind: "key-order", perCoin: leftKeys, bulk: rightKeys });
  }
  for (const key of new Set([...leftKeys, ...rightKeys])) {
    const fieldPath = Array.isArray(perCoin) ? `${path}[${key}]` : `${path}[${JSON.stringify(key)}]`;
    if (!Object.hasOwn(left, key)) differences.push({ path: fieldPath, kind: "missing-per-coin", bulk: right[key] });
    else if (!Object.hasOwn(right, key)) differences.push({ path: fieldPath, kind: "missing-bulk", perCoin: left[key] });
    else differences.push(...diffJsonFields(left[key], right[key], fieldPath));
  }
  return differences;
}

/** Production is GET-only; retained trees never overwrite checkout artifacts. */
export async function compareDetailSnapshotSources(generatedAt = Date.now(), options: ComparisonOptions = {}): Promise<boolean> {
  if (!Number.isFinite(generatedAt) || generatedAt < 0) throw new Error("generatedAt must be a nonnegative millisecond clock");
  const diffLimit = options.diffLimit ?? 10;
  if (!Number.isInteger(diffLimit) || diffLimit < 0) throw new Error("diffLimit must be a nonnegative integer");
  const parent = options.keepDir === undefined ? tmpdir() : resolve(options.keepDir);
  if (options.keepDir !== undefined) mkdirSync(parent, { recursive: true });
  const temporaryRoot = mkdtempSync(join(parent, "pharos-detail-source-equivalence-"));
  const realNow = Date.now;
  try {
    // Freeze both envelope generation and the no-Date source-clock fallback. Actual
    // HTTP source clocks remain untouched; a moving publication must fail comparison.
    Date.now = () => generatedAt;
    const perCoinDir = join(temporaryRoot, "per-coin");
    const bulkDir = join(temporaryRoot, "bulk");
    // Acquire the fast bulk pass first to shorten the gap before per-coin reads.
    const wallTimeMs: Record<string, number> = {};
    for (const [source, directory] of [["bulk", bulkDir], ["per-coin", perCoinDir]] as const) {
      const started = performance.now();
      writeSnapshots(await generateSnapshots(false, { source, generatedAt }), directory);
      wallTimeMs[source] = Math.round(performance.now() - started);
    }
    const files = new Set([...readdirSync(perCoinDir), ...readdirSync(bulkDir)]);
    const perCoinFiles = new Set(readdirSync(perCoinDir));
    const bulkFiles = new Set(readdirSync(bulkDir));
    const differences: string[] = [];
    const fieldDifferences: { file: string; fields: JsonDifference[] }[] = [];
    for (const file of [...files].sort()) {
      const perCoin = perCoinFiles.has(file) ? readFileSync(join(perCoinDir, file)) : undefined;
      const bulk = bulkFiles.has(file) ? readFileSync(join(bulkDir, file)) : undefined;
      if (!perCoin || !bulk || !perCoin.equals(bulk)) {
        differences.push(file);
        if (fieldDifferences.length < diffLimit) {
          const fields = !perCoin || !bulk
            ? [{ path: "$", kind: !perCoin ? "missing-per-coin" as const : "missing-bulk" as const }]
            : diffJsonFields(JSON.parse(perCoin.toString()), JSON.parse(bulk.toString()));
          fieldDifferences.push({ file, fields: fields.length ? fields : [{ path: "$", kind: "serialization" }] });
        }
      }
    }
    console.log(JSON.stringify({
      generatedAt, filesCompared: files.size, differences, equivalent: differences.length === 0,
      wallTimeMs, fieldDifferences, ...(options.keepDir === undefined ? {} : { keptDir: temporaryRoot }),
    }, null, 2));
    return differences.length === 0;
  } finally {
    Date.now = realNow;
    if (options.keepDir === undefined) rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

async function runCli(): Promise<void> {
  const { values } = parseStrictCliArgs(process.argv.slice(2), {
    options: { "generated-at": { type: "string" }, "keep-dir": { type: "string" }, "diff-limit": { type: "string" } },
  });
  if (writeCliHelpIfRequested(values,
    "Usage: node --import tsx scripts/maintenance/compare-detail-snapshot-sources.ts [--generated-at=<milliseconds>] [--keep-dir=<parent>] [--diff-limit=<files>]")) return;
  const generatedAt = values["generated-at"] === undefined
    ? Date.now()
    : parseCliInteger(values["generated-at"], { name: "generated-at", min: 0 });
  const diffLimit = values["diff-limit"] === undefined
    ? 10
    : parseCliInteger(values["diff-limit"], { name: "diff-limit", min: 0 });
  const keepDir = typeof values["keep-dir"] === "string" ? values["keep-dir"] : undefined;
  if (!await compareDetailSnapshotSources(generatedAt, { keepDir, diffLimit })) process.exitCode = 1;
}

runDirectCli(import.meta.url, runCli, { label: "detail-source-equivalence" });
