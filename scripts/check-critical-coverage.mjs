#!/usr/bin/env node
import fs from "node:fs";

const LCOV_PATH = "coverage/lcov.info";
const THRESHOLD = Number.parseFloat(process.env.CRITICAL_COVERAGE_THRESHOLD ?? "35");

const CRITICAL_FILES = [
  "src/lib/api.ts",
  "worker/src/lib/api-utils.ts",
  "worker/src/cron/sync-stablecoins.ts",
  "worker/src/cron/sync-yield-data.ts",
  "worker/src/api/peg-summary.ts",
  "worker/src/api/report-cards.ts",
  "worker/src/api/dex-liquidity.ts",
  "worker/src/api/stress-signals.ts",
  "worker/src/api/mint-burn-flows.ts",
];

function parseLcov(content) {
  const blocks = content.split("end_of_record\n");
  const map = new Map();

  for (const block of blocks) {
    const lines = block.trim().split("\n").filter(Boolean);
    if (lines.length === 0) continue;

    const sf = lines.find((l) => l.startsWith("SF:"));
    if (!sf) continue;
    const file = sf.slice(3);

    let lf = 0;
    let lh = 0;
    for (const line of lines) {
      if (line.startsWith("LF:")) lf = Number.parseInt(line.slice(3), 10);
      if (line.startsWith("LH:")) lh = Number.parseInt(line.slice(3), 10);
    }

    if (Number.isFinite(lf) && lf > 0) {
      map.set(file, { lf, lh, pct: (lh / lf) * 100 });
    }
  }

  return map;
}

function findCoverageFor(file, map) {
  for (const [key, value] of map.entries()) {
    if (key.endsWith(file)) return { key, ...value };
  }
  return null;
}

if (!fs.existsSync(LCOV_PATH)) {
  console.error(`[coverage] Missing ${LCOV_PATH}. Run vitest with --coverage first.`);
  process.exit(1);
}

const lcov = fs.readFileSync(LCOV_PATH, "utf8");
const parsed = parseLcov(lcov);

let failed = false;
console.log(`[coverage] Critical file line coverage threshold: ${THRESHOLD.toFixed(1)}%`);

for (const file of CRITICAL_FILES) {
  const cov = findCoverageFor(file, parsed);
  if (!cov) {
    failed = true;
    console.error(`[coverage] MISSING: ${file} (not found in lcov)`);
    continue;
  }

  const line = `${cov.pct.toFixed(1)}% (${cov.lh}/${cov.lf})`;
  if (cov.pct < THRESHOLD) {
    failed = true;
    console.error(`[coverage] FAIL ${file}: ${line}`);
  } else {
    console.log(`[coverage] PASS ${file}: ${line}`);
  }
}

if (failed) process.exit(1);
console.log("[coverage] Critical coverage gate passed.");
