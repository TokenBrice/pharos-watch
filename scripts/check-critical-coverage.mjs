#!/usr/bin/env node
import fs from "node:fs";
import { execSync } from "node:child_process";

const LCOV_PATH = "coverage/lcov.info";
const THRESHOLD = Number.parseFloat(process.env.CRITICAL_COVERAGE_THRESHOLD ?? "40");
const RATCHET_TOLERANCE = Number.parseFloat(process.env.CRITICAL_COVERAGE_RATCHET_TOLERANCE ?? "0");
const BASELINE_PATH = process.env.CRITICAL_COVERAGE_BASELINE_FILE ?? ".ci/critical-coverage-baseline.json";
const COMPARE_REF = (process.env.CRITICAL_COVERAGE_COMPARE_REF ?? "").trim();
const RATCHET_ALL = process.env.CRITICAL_COVERAGE_RATCHET_ALL === "1";

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

function normalizePath(p) {
  return p.replaceAll("\\", "/");
}

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

function parseChangedFilesFromEnv() {
  const raw = process.env.CRITICAL_COVERAGE_CHANGED_FILES;
  if (!raw) return [];
  return raw
    .split(/\r?\n|,/g)
    .map((line) => normalizePath(line.trim()))
    .filter(Boolean);
}

function isAllZeroSha(ref) {
  return /^0+$/.test(ref);
}

function getChangedFilesFromGit(ref) {
  if (!ref || isAllZeroSha(ref)) return [];
  try {
    const raw = execSync(`git diff --name-only ${ref}..HEAD`, { encoding: "utf8" });
    return raw
      .split(/\r?\n/g)
      .map((line) => normalizePath(line.trim()))
      .filter(Boolean);
  } catch (err) {
    console.warn(`[coverage] Could not diff against ref "${ref}", skipping ratchet compare: ${String(err).slice(0, 200)}`);
    return [];
  }
}

function loadCoverageBaseline(path) {
  if (!fs.existsSync(path)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(path, "utf8"));
    if (parsed && typeof parsed === "object" && parsed.files && typeof parsed.files === "object") {
      return parsed.files;
    }
    return parsed;
  } catch (err) {
    console.error(`[coverage] Failed to parse baseline file ${path}: ${String(err).slice(0, 200)}`);
    process.exit(1);
  }
}

if (!fs.existsSync(LCOV_PATH)) {
  console.error(`[coverage] Missing ${LCOV_PATH}. Run vitest with --coverage first.`);
  process.exit(1);
}

const lcov = fs.readFileSync(LCOV_PATH, "utf8");
const parsed = parseLcov(lcov);
const baseline = loadCoverageBaseline(BASELINE_PATH);
const changedFromEnv = parseChangedFilesFromEnv();
const changedFromRef = changedFromEnv.length > 0 ? [] : getChangedFilesFromGit(COMPARE_REF);
const changedFiles = changedFromEnv.length > 0 ? changedFromEnv : changedFromRef;
const touchedCritical = CRITICAL_FILES.filter((file) => changedFiles.includes(file));

let failed = false;
console.log(`[coverage] Critical file line coverage threshold: ${THRESHOLD.toFixed(1)}%`);
if (baseline) {
  if (touchedCritical.length > 0) {
    console.log(`[coverage] Ratchet targets (touched critical files): ${touchedCritical.join(", ")}`);
  } else if (RATCHET_ALL) {
    console.log("[coverage] Ratchet targets: all critical files (CRITICAL_COVERAGE_RATCHET_ALL=1)");
  } else {
    console.log("[coverage] No touched critical files detected; ratchet checks skipped.");
  }
} else {
  console.log(`[coverage] Baseline file not found at ${BASELINE_PATH}; ratchet checks skipped.`);
}

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

if (baseline) {
  const ratchetTargets = touchedCritical.length > 0 ? touchedCritical : (RATCHET_ALL ? CRITICAL_FILES : []);
  for (const file of ratchetTargets) {
    const baselinePctRaw = baseline[file];
    const baselinePct = Number.parseFloat(String(baselinePctRaw));
    if (!Number.isFinite(baselinePct)) {
      failed = true;
      console.error(`[coverage] MISSING BASELINE: ${file} in ${BASELINE_PATH}`);
      continue;
    }
    const cov = findCoverageFor(file, parsed);
    if (!cov) continue; // already failed above

    const currentPct = Number.parseFloat(cov.pct.toFixed(1));
    const floor = baselinePct - RATCHET_TOLERANCE;
    if (currentPct + 1e-9 < floor) {
      failed = true;
      console.error(
        `[coverage] REGRESSION ${file}: ${currentPct.toFixed(1)}% < baseline ${baselinePct.toFixed(1)}% (tolerance ${RATCHET_TOLERANCE.toFixed(1)}%)`,
      );
    } else {
      console.log(
        `[coverage] RATCHET PASS ${file}: ${currentPct.toFixed(1)}% vs baseline ${baselinePct.toFixed(1)}%`,
      );
    }
  }
}

if (failed) process.exit(1);
console.log("[coverage] Critical coverage gate passed.");
