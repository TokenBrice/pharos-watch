#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { formatBytes } from "../lib/format-bytes.mjs";
import { isDirectRun } from "../lib/smoke-runtime.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const BASELINE_PATH = path.join(root, "scripts/lib/build-attribution-baseline.json");
const EXPLAIN_SCRIPT = path.join(root, "scripts/maintenance/explain-build-chunks.mjs");

const KNOWN_CHUNK_GROWTH_LIMIT_BYTES = 50 * 1024;
const NEW_CLASSIFIED_GROUP_LIMIT_BYTES = 200 * 1024;
const UNCLASSIFIED_CHUNK_LIMIT_BYTES = 200 * 1024;

function runClassifier() {
  const result = spawnSync(process.execPath, [EXPLAIN_SCRIPT, "--json"], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) {
    console.error(result.stderr || result.stdout);
    throw new Error(`explain-build-chunks.mjs exited with status ${result.status}`);
  }
  return JSON.parse(result.stdout);
}

function loadBaseline() {
  if (!existsSync(BASELINE_PATH)) {
    throw new Error(
      `Missing baseline at ${BASELINE_PATH}. Run: npm run check:build-attribution:update-baseline`,
    );
  }
  return JSON.parse(readFileSync(BASELINE_PATH, "utf8"));
}

export function classificationKey(classifications) {
  return classifications.length > 0 ? classifications.slice().sort().join("+") : "(unclassified)";
}

export function aggregateByClassification(report) {
  const groups = new Map();
  for (const entry of report.entries) {
    const key = classificationKey(entry.classifications);
    const group = groups.get(key) ?? { key, totalBytes: 0, chunkCount: 0 };
    group.totalBytes += entry.size;
    group.chunkCount += 1;
    groups.set(key, group);
  }
  return groups;
}

export function findBuildAttributionFailures({ baseline, report }) {
  const baselineByKey = new Map(baseline.groups.map((group) => [group.key, group]));
  const current = aggregateByClassification(report);
  const failures = [];

  for (const [key, group] of current) {
    if (key === "(unclassified)") continue;
    const base = baselineByKey.get(key);
    if (!base) {
      if (group.totalBytes > NEW_CLASSIFIED_GROUP_LIMIT_BYTES) {
        failures.push(
          `${key} is a new classified group at ${formatBytes(group.totalBytes)}, above the ${formatBytes(
            NEW_CLASSIFIED_GROUP_LIMIT_BYTES,
          )} absolute limit; review the classification before refreshing the baseline`,
        );
      } else {
        failures.push(
          `${key} is a new classified group at ${formatBytes(group.totalBytes)}; review it before refreshing the baseline`,
        );
      }
      continue;
    }
    const growth = group.totalBytes - base.totalBytes;
    if (growth > KNOWN_CHUNK_GROWTH_LIMIT_BYTES) {
      failures.push(
        `${key} grew by ${formatBytes(growth)} (baseline ${formatBytes(base.totalBytes)} -> current ${formatBytes(
          group.totalBytes,
        )}; limit ${formatBytes(KNOWN_CHUNK_GROWTH_LIMIT_BYTES)})`,
      );
    }
  }

  for (const entry of report.entries) {
    if (entry.classifications.length > 0) continue;
    if (entry.size > UNCLASSIFIED_CHUNK_LIMIT_BYTES) {
      failures.push(
        `unclassified chunk ${entry.chunk} is ${formatBytes(entry.size)} (limit ${formatBytes(UNCLASSIFIED_CHUNK_LIMIT_BYTES)}); add a signature to scripts/lib/build-attribution-signatures.json`,
      );
    }
  }

  return failures;
}

export function main() {
  const baseline = loadBaseline();
  const report = runClassifier();
  const failures = findBuildAttributionFailures({ baseline, report });

  if (failures.length === 0) {
    console.log("Build attribution check passed.");
    process.exit(0);
  }

  console.error("Build attribution regressions detected:");
  for (const failure of failures) {
    console.error(`  ${failure}`);
  }
  console.error("");
  console.error("If these changes are intentional, refresh the baseline:");
  console.error("  npm run check:build-attribution:update-baseline");
  process.exit(1);
}

if (isDirectRun(import.meta.url, process.argv[1])) {
  main();
}
