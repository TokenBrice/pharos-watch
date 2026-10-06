#!/usr/bin/env node

import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseCliInteger, parseStrictCliArgs, runDirectCli, writeCliHelpIfRequested } from "../lib/cli-args.mjs";
import { generateSnapshots, writeSnapshots } from "../build-data/build-stablecoin-detail-snapshots";

/** Production is GET-only; both output trees are temporary and always removed. */
export async function compareDetailSnapshotSources(generatedAt = Date.now()): Promise<boolean> {
  if (!Number.isFinite(generatedAt) || generatedAt < 0) throw new Error("generatedAt must be a nonnegative millisecond clock");
  const temporaryRoot = mkdtempSync(join(tmpdir(), "pharos-detail-source-equivalence-"));
  const realNow = Date.now;
  try {
    // Freeze both envelope generation and the no-Date source-clock fallback. Actual
    // HTTP source clocks remain untouched; a moving publication must fail comparison.
    Date.now = () => generatedAt;
    const perCoinDir = join(temporaryRoot, "per-coin");
    const bulkDir = join(temporaryRoot, "bulk");
    writeSnapshots(await generateSnapshots(false, { source: "per-coin", generatedAt }), perCoinDir);
    writeSnapshots(await generateSnapshots(false, { source: "bulk", generatedAt }), bulkDir);
    const files = new Set([...readdirSync(perCoinDir), ...readdirSync(bulkDir)]);
    const perCoinFiles = new Set(readdirSync(perCoinDir));
    const bulkFiles = new Set(readdirSync(bulkDir));
    const differences: string[] = [];
    for (const file of [...files].sort()) {
      if (!perCoinFiles.has(file) || !bulkFiles.has(file) ||
          !readFileSync(join(perCoinDir, file)).equals(readFileSync(join(bulkDir, file)))) {
        differences.push(file);
      }
    }
    console.log(JSON.stringify({ generatedAt, filesCompared: files.size, differences, equivalent: differences.length === 0 }, null, 2));
    return differences.length === 0;
  } finally {
    Date.now = realNow;
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

async function runCli(): Promise<void> {
  const { values } = parseStrictCliArgs(process.argv.slice(2), {
    options: { "generated-at": { type: "string" } },
  });
  if (writeCliHelpIfRequested(values,
    "Usage: node --import tsx scripts/maintenance/compare-detail-snapshot-sources.ts [--generated-at=<milliseconds>]")) return;
  const generatedAt = values["generated-at"] === undefined
    ? Date.now()
    : parseCliInteger(values["generated-at"], { name: "generated-at", min: 0 });
  if (!await compareDetailSnapshotSources(generatedAt)) process.exitCode = 1;
}

runDirectCli(import.meta.url, runCli, { label: "detail-source-equivalence" });
