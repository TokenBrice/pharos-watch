#!/usr/bin/env node
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import {
  CRITICAL_COVERAGE_WAIVERS,
  CRITICAL_FILES,
  collectCriticalCoverageWaiverReviewQueue,
  collectCriticalCoverageCandidates,
  findCriticalCoverageCandidatesMissingEnrollment,
  findCoverageFor,
  findStaleCriticalCoverageWaivers,
  normalizePath,
  parseLcov,
  validateCriticalCoverageWaiverMetadata,
} from "../lib/critical-coverage.mjs";
import { isDirectRun } from "../lib/smoke-runtime.mjs";

const LCOV_PATH = "coverage/lcov.info";

// Explicit per-file minimums for critical reliability paths.
function getCriticalThresholds(env = process.env) {
  return {
    "worker/src/lib/stablecoins-cache.ts": Number.parseFloat(env.CRITICAL_COVERAGE_THRESHOLD_STABLECOINS_CACHE ?? "50"),
    "worker/src/lib/auth.ts": Number.parseFloat(env.CRITICAL_COVERAGE_THRESHOLD_AUTH ?? "70"),
    "worker/src/lib/evm-rpc.ts": Number.parseFloat(env.CRITICAL_COVERAGE_THRESHOLD_EVM_RPC ?? "70"),
    "worker/src/lib/safety-scores.ts": Number.parseFloat(env.CRITICAL_COVERAGE_THRESHOLD_SAFETY_SCORES ?? "40"),
    "worker/src/handlers/scheduled.ts": Number.parseFloat(env.CRITICAL_COVERAGE_THRESHOLD_SCHEDULED ?? "40"),
    "worker/src/cron/daily-digest.ts": Number.parseFloat(env.CRITICAL_COVERAGE_THRESHOLD_DAILY_DIGEST ?? "40"),
    "worker/src/api/stablecoin-detail.ts": Number.parseFloat(env.CRITICAL_COVERAGE_THRESHOLD_STABLECOIN_DETAIL ?? "30"),
    "worker/src/api/health.ts": Number.parseFloat(env.CRITICAL_COVERAGE_THRESHOLD_HEALTH ?? "60"),
    "worker/src/api/status.ts": Number.parseFloat(env.CRITICAL_COVERAGE_THRESHOLD_STATUS ?? "40"),
    "worker/src/cron/dex-liquidity/orchestrator.ts": Number.parseFloat(env.CRITICAL_COVERAGE_THRESHOLD_DEX_ORCHESTRATOR ?? "55"),
    "worker/src/lib/api-pagination.ts": Number.parseFloat(env.CRITICAL_COVERAGE_THRESHOLD_API_PAGINATION ?? "70"),
  };
}

export function parseChangedFilesFromEnv(env = process.env) {
  const raw = env.CRITICAL_COVERAGE_CHANGED_FILES;
  if (!raw) return [];
  return raw
    .split(/\r?\n|,/g)
    .map((line) => normalizePath(line.trim()))
    .filter(Boolean);
}

export function isAllZeroSha(ref) {
  return /^0+$/.test(ref);
}

export function getChangedFilesFromGit(ref, { execFile = execFileSync, consoleImpl = console } = {}) {
  if (!ref || isAllZeroSha(ref)) return [];
  try {
    const raw = execFile("git", ["diff", "--name-only", `${ref}...HEAD`], { encoding: "utf8" });
    return raw
      .split(/\r?\n/g)
      .map((line) => normalizePath(line.trim()))
      .filter(Boolean);
  } catch (err) {
    const message = `[coverage] Could not diff against explicit ref "${ref}": ${String(err).slice(0, 200)}`;
    consoleImpl.error(message);
    throw new Error(message, { cause: err });
  }
}

function loadCoverageBaseline(path, { fsImpl = fs, consoleImpl = console, exit = process.exit } = {}) {
  if (!fsImpl.existsSync(path)) return null;
  try {
    const parsed = JSON.parse(fsImpl.readFileSync(path, "utf8"));
    if (parsed && typeof parsed === "object" && parsed.files && typeof parsed.files === "object") {
      return parsed.files;
    }
    return parsed;
  } catch (err) {
    consoleImpl.error(`[coverage] Failed to parse baseline file ${path}: ${String(err).slice(0, 200)}`);
    exit(1);
    return null;
  }
}

export function runCriticalCoverageCompletenessGuard({
  candidateFiles = collectCriticalCoverageCandidates(),
  criticalFiles = CRITICAL_FILES,
  waivers = CRITICAL_COVERAGE_WAIVERS,
  reviewToday = new Date(),
  consoleImpl = console,
  exit = process.exit,
} = {}) {
  const waiverErrors = validateCriticalCoverageWaiverMetadata(waivers, {
    candidateFiles,
    criticalFiles,
  });
  const staleWaivers = findStaleCriticalCoverageWaivers(candidateFiles, waivers);
  const missingEnrollment = findCriticalCoverageCandidatesMissingEnrollment(candidateFiles, {
    criticalFiles,
    waivers,
  });
  const waiverReviewQueue = collectCriticalCoverageWaiverReviewQueue(waivers, {
    candidateFiles,
    today: reviewToday,
  });

  if (
    waiverErrors.length === 0 &&
    staleWaivers.length === 0 &&
    missingEnrollment.length === 0 &&
    waiverReviewQueue.due.length === 0
  ) {
    if (waiverReviewQueue.upcoming.length > 0) {
      consoleImpl.log("[coverage] Critical coverage waiver reviews due soon:");
      for (const waiver of waiverReviewQueue.upcoming) {
        consoleImpl.log(`  ${waiver.file} reviewAfter=${waiver.reviewAfter}`);
      }
    }
    return true;
  }

  consoleImpl.error("[coverage] Critical coverage candidate completeness failed.");
  if (waiverErrors.length > 0) {
    consoleImpl.error("[coverage] Invalid critical-coverage waivers:");
    for (const error of waiverErrors) {
      consoleImpl.error(`  ${error}`);
    }
  }
  if (staleWaivers.length > 0) {
    consoleImpl.error("[coverage] Stale critical-coverage waivers:");
    for (const file of staleWaivers) {
      consoleImpl.error(`  ${file}`);
    }
  }
  if (missingEnrollment.length > 0) {
    consoleImpl.error("[coverage] High-stakes candidates missing critical coverage enrollment or waiver:");
    for (const file of missingEnrollment) {
      consoleImpl.error(`  ${file}`);
    }
  }
  if (waiverReviewQueue.due.length > 0) {
    consoleImpl.error("[coverage] Critical coverage waiver reviews are due or overdue:");
    for (const waiver of waiverReviewQueue.due) {
      consoleImpl.error(`  ${waiver.file} reviewAfter=${waiver.reviewAfter}`);
    }
  }
  consoleImpl.error(
    "[coverage] Add the source file to CRITICAL_FILES with a baseline, or add a reviewed waiver in scripts/lib/critical-coverage.mjs.",
  );
  exit(1);
  return false;
}

export function runCriticalCoverageCheck({
  env = process.env,
  fsImpl = fs,
  execFile = execFileSync,
  consoleImpl = console,
  exit = process.exit,
} = {}) {
  const threshold = Number.parseFloat(env.CRITICAL_COVERAGE_THRESHOLD ?? "40");
  const ratchetTolerance = Number.parseFloat(env.CRITICAL_COVERAGE_RATCHET_TOLERANCE ?? "0");
  const baselinePath = env.CRITICAL_COVERAGE_BASELINE_FILE ?? ".ci/critical-coverage-baseline.json";
  const compareRef = (env.CRITICAL_COVERAGE_COMPARE_REF ?? "").trim();
  const ratchetAll = env.CRITICAL_COVERAGE_RATCHET_ALL === "1";
  const criticalThresholds = getCriticalThresholds(env);

  if (!runCriticalCoverageCompletenessGuard({ consoleImpl, exit })) {
    return;
  }

  if (!fsImpl.existsSync(LCOV_PATH)) {
    consoleImpl.error(`[coverage] Missing ${LCOV_PATH}. Run vitest with --coverage first.`);
    exit(1);
    return;
  }

  const lcov = fsImpl.readFileSync(LCOV_PATH, "utf8");
  const parsed = parseLcov(lcov);
  const baseline = loadCoverageBaseline(baselinePath, { fsImpl, consoleImpl, exit });
  const changedFromEnv = parseChangedFilesFromEnv(env);
  let changedFromRef = [];
  if (changedFromEnv.length === 0) {
    try {
      changedFromRef = getChangedFilesFromGit(compareRef, { execFile, consoleImpl });
    } catch {
      exit(1);
      return;
    }
  }
  const changedFiles = changedFromEnv.length > 0 ? changedFromEnv : changedFromRef;
  const touchedCritical = CRITICAL_FILES.filter((file) => changedFiles.includes(file));

  let failed = false;
  consoleImpl.log(`[coverage] Critical file line coverage threshold: ${threshold.toFixed(1)}%`);
  if (baseline) {
    if (ratchetAll) {
      consoleImpl.log("[coverage] Ratchet targets: all critical files (CRITICAL_COVERAGE_RATCHET_ALL=1)");
    } else if (touchedCritical.length > 0) {
      consoleImpl.log(`[coverage] Ratchet targets (touched critical files): ${touchedCritical.join(", ")}`);
    } else {
      consoleImpl.log("[coverage] No touched critical files detected; ratchet checks skipped.");
    }
  } else {
    consoleImpl.log(`[coverage] Baseline file not found at ${baselinePath}; ratchet checks skipped.`);
  }

  function thresholdForFile(file) {
    const override = criticalThresholds[file];
    return Number.isFinite(override) ? override : threshold;
  }

  for (const file of CRITICAL_FILES) {
    const cov = findCoverageFor(file, parsed);
    if (!cov) {
      failed = true;
      consoleImpl.error(`[coverage] MISSING: ${file} (not found in lcov)`);
      continue;
    }

    const fileThreshold = thresholdForFile(file);
    const line = `${cov.pct.toFixed(1)}% (${cov.lh}/${cov.lf})`;
    if (cov.pct < fileThreshold) {
      failed = true;
      consoleImpl.error(`[coverage] FAIL ${file}: ${line} < ${fileThreshold.toFixed(1)}%`);
    } else {
      consoleImpl.log(`[coverage] PASS ${file}: ${line} (threshold ${fileThreshold.toFixed(1)}%)`);
    }
  }

  if (baseline) {
    const ratchetTargets = ratchetAll ? CRITICAL_FILES : touchedCritical;
    for (const file of ratchetTargets) {
      const baselinePctRaw = baseline[file];
      const baselinePct = Number.parseFloat(String(baselinePctRaw));
      if (!Number.isFinite(baselinePct)) {
        failed = true;
        consoleImpl.error(`[coverage] MISSING BASELINE: ${file} in ${baselinePath}`);
        continue;
      }
      const cov = findCoverageFor(file, parsed);
      if (!cov) continue; // already failed above

      const currentPct = Number.parseFloat(cov.pct.toFixed(1));
      const floor = baselinePct - ratchetTolerance;
      if (currentPct + 1e-9 < floor) {
        failed = true;
        consoleImpl.error(
          `[coverage] REGRESSION ${file}: ${currentPct.toFixed(1)}% < baseline ${baselinePct.toFixed(1)}% (tolerance ${ratchetTolerance.toFixed(1)}%)`,
        );
      } else {
        consoleImpl.log(
          `[coverage] RATCHET PASS ${file}: ${currentPct.toFixed(1)}% vs baseline ${baselinePct.toFixed(1)}%`,
        );
      }
    }
  }

  if (failed) {
    exit(1);
    return;
  }
  consoleImpl.log("[coverage] Critical coverage gate passed.");
}

if (isDirectRun(import.meta.url, process.argv[1])) {
  runCriticalCoverageCheck();
}
