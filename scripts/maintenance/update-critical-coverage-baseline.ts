#!/usr/bin/env node
import fs from "node:fs";
import {
  CRITICAL_FILES,
  findCoverageFor,
  parseLcov,
} from "../lib/critical-coverage.mjs";

const LCOV_PATH = "coverage/lcov.info";
const BASELINE_PATH = process.env.CRITICAL_COVERAGE_BASELINE_FILE ?? ".ci/critical-coverage-baseline.json";

if (!fs.existsSync(LCOV_PATH)) {
  console.error(`[coverage] Missing ${LCOV_PATH}. Run npm run coverage:critical first.`);
  process.exit(1);
}

const lcov = fs.readFileSync(LCOV_PATH, "utf8");
const parsed = parseLcov(lcov);
const files: Record<string, number> = {};

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
