#!/usr/bin/env node

import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const BASELINE_PATH = path.join(root, "scripts/lib/build-attribution-baseline.json");
const EXPLAIN_SCRIPT = path.join(root, "scripts/maintenance/explain-build-chunks.mjs");

function classificationKey(classifications) {
  return classifications.length > 0 ? classifications.slice().sort().join("+") : "(unclassified)";
}

function aggregate(report) {
  const groups = new Map();
  for (const entry of report.entries) {
    const key = classificationKey(entry.classifications);
    const group = groups.get(key) ?? { key, totalBytes: 0, chunkCount: 0 };
    group.totalBytes += entry.size;
    group.chunkCount += 1;
    groups.set(key, group);
  }
  return [...groups.values()].sort((a, b) => b.totalBytes - a.totalBytes || a.key.localeCompare(b.key));
}

const result = spawnSync(process.execPath, [EXPLAIN_SCRIPT, "--json"], {
  cwd: root,
  encoding: "utf8",
  maxBuffer: 64 * 1024 * 1024,
});
if (result.status !== 0) {
  console.error(result.stderr || result.stdout);
  process.exit(result.status ?? 1);
}

const report = JSON.parse(result.stdout);
const groups = aggregate(report);

const baseline = {
  description: "Aggregate chunk attribution sizes. Refreshed via npm run check:build-attribution:update-baseline.",
  groups,
};

writeFileSync(BASELINE_PATH, `${JSON.stringify(baseline, null, 2)}\n`);
console.log(`Updated build attribution baseline at ${path.relative(root, BASELINE_PATH)}.`);
