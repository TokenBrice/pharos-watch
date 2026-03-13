#!/usr/bin/env node
import fs from "node:fs";

const LCOV_PATH = "coverage/lcov.info";
const BASELINE_PATH = process.env.CRITICAL_COVERAGE_BASELINE_FILE ?? ".ci/critical-coverage-baseline.json";

const CRITICAL_FILES = [
  "src/lib/api.ts",
  "worker/src/lib/api-utils.ts",
  "worker/src/lib/auth.ts",
  "worker/src/lib/evm-rpc.ts",
  "worker/src/api/discovery.ts",
  "worker/src/api/health.ts",
  "worker/src/cron/sync-stablecoins.ts",
  "worker/src/cron/sync-yield-data.ts",
  "worker/src/api/peg-summary.ts",
  "worker/src/api/report-cards.ts",
  "worker/src/api/dex-liquidity.ts",
  "worker/src/api/stress-signals.ts",
  "worker/src/api/mint-burn-flows.ts",
  "worker/src/lib/alerts.ts",
  "worker/src/api/stablecoin-detail.ts",
  "worker/src/cron/dex-liquidity/orchestrator.ts",
];

function parseLcov(content) {
  const blocks = content.split("end_of_record\n");
  const map = new Map();

  for (const block of blocks) {
    const lines = block.trim().split("\n").filter(Boolean);
    if (lines.length === 0) continue;

    const sf = lines.find((l) => l.startsWith("SF:"));
    if (!sf) continue;
    const file = sf.slice(3).replaceAll("\\", "/");

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
    if (key.endsWith(file)) return value;
  }
  return null;
}

if (!fs.existsSync(LCOV_PATH)) {
  console.error(`[coverage] Missing ${LCOV_PATH}. Run npm run coverage:critical first.`);
  process.exit(1);
}

const lcov = fs.readFileSync(LCOV_PATH, "utf8");
const parsed = parseLcov(lcov);
const files = {};

for (const file of CRITICAL_FILES) {
  const cov = findCoverageFor(file, parsed);
  if (!cov) {
    console.error(`[coverage] Missing in lcov: ${file}`);
    process.exit(1);
  }
  files[file] = Number.parseFloat(cov.pct.toFixed(1));
}

const out = {
  version: 1,
  generatedAt: new Date().toISOString().slice(0, 10),
  files,
};

fs.mkdirSync(BASELINE_PATH.split("/").slice(0, -1).join("/"), { recursive: true });
fs.writeFileSync(BASELINE_PATH, `${JSON.stringify(out, null, 2)}\n`);

console.log(`[coverage] Wrote baseline: ${BASELINE_PATH}`);
