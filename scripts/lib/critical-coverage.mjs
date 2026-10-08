import { relative } from "node:path";

import { isValidIsoDateOnly } from "../../shared/types/date-primitives.ts";
import {
  CRITICAL_OWNERSHIP_WAIVERS,
  deriveCriticalOwnership,
  deriveBaseCriticalOwnership,
} from "./critical-ownership.mts";
import { collectSourceFilesUnderRoot } from "./source-files.mts";

const HIGH_STAKES_COVERAGE_SCAN_ROOTS = [
  "worker/src/cron",
  "worker/src/lib",
  "shared/lib",
  "worker/src/api",
  "functions/lib",
];
const HIGH_STAKES_COVERAGE_SCAN_EXTENSIONS = new Set([".ts"]);
const HIGH_STAKES_COVERAGE_SCAN_EXCLUDED_DIRS = new Set();
const HIGH_STAKES_COVERAGE_CANDIDATE_PREFIXES = [
  "worker/src/cron/sync-stablecoins/",
  "worker/src/cron/depeg-detection/",
  "worker/src/cron/depeg-resolver/",
  "worker/src/cron/dews/",
  "worker/src/lib/address-price-providers/",
  "worker/src/lib/authoritative-price-sources/",
  "worker/src/lib/depeg-resolver-",
];
const HIGH_STAKES_COVERAGE_CANDIDATE_FILES = new Set([
  "worker/src/cron/sync-stablecoins.ts",
  "worker/src/cron/detect-depegs.ts",
  "worker/src/cron/confirm-pending-depegs.ts",
  "worker/src/cron/pending-depeg-confirmation.ts",
  "worker/src/cron/pending-depeg-confirmation-decision.ts",
  "worker/src/cron/pending-depeg-confirmation-evidence.ts",
  "worker/src/cron/compute-depeg-resolver.ts",
  "worker/src/cron/compute-depeg-resolver-review.ts",
  "worker/src/cron/reserve-adapters/cap-vault.ts",
  "worker/src/cron/sync-live-reserves.ts",
  "worker/src/lib/stress-signals-current-rows.ts",
]);
const HIGH_STAKES_COVERAGE_CANDIDATE_PATTERNS = [
  /^worker\/src\/cron\/sync-live-reserves-[a-z0-9-]+\.ts$/,
  /^worker\/src\/lib\/[^/]*(price|pricing)[^/]*\.ts$/,
  /^worker\/src\/lib\/live-reserves\/[^/]+\.ts$/,
  /^worker\/src\/lib\/(?:auth|evm-rpc)\.ts$/,
  /^worker\/src\/lib\/(?!(?:[^/]*-(?:version|colors))\.ts$)[^/]*(score|scoring|freshness|publication|psi)[^/]*\.ts$/,
  /^worker\/src\/lib\/safety-score-v9\/[^/]+\.ts$/,
  /^worker\/src\/api\/[^/]*(score|scoring|freshness|publication|psi)[^/]*\.ts$/,
  /^shared\/lib\/(?!(?:[^/]*-(?:version|colors))\.ts$)[^/]*(score|scoring|freshness|publication|psi)[^/]*\.ts$/,
  /^functions\/lib\/[^/]*proxy[^/]*\.ts$/,
];
// Reviewed denominator exclusions, not a backlog of substantive untested logic.
// Every facade names an enrolled implementation and its executable importing
// contract. Runtime decisions belong in coverage even when extracted from a
// previously excluded path. Review dates are not automatically renewed.
/** @type {Record<string, { reviewAfter: string, reason: string, owner: string, ownerTest: string }>} */
export const CRITICAL_COVERAGE_WAIVERS = {
  "worker/src/cron/sync-stablecoins/tracked-asset-overrides.ts": {
    reviewAfter: "2026-12-15",
    reason: "Static reviewed address overrides only; phase-helpers applies them to admitted assets and its contract checks the m-m0 consumer override.",
    owner: "worker/src/cron/sync-stablecoins/phase-helpers.ts",
    ownerTest: "worker/src/cron/__tests__/sync-stablecoins-stages.test.ts",
  },
  "worker/src/lib/authoritative-price-sources.ts": {
    reviewAfter: "2026-12-15",
    reason: "One-line export facade with no local runtime decisions; historical provider replay directly exercises the defining index implementation.",
    owner: "worker/src/lib/authoritative-price-sources/index.ts",
    ownerTest: "worker/src/lib/__tests__/authoritative-price-sources-replay.test.ts",
  },
  "worker/src/lib/live-reserves/store.ts": {
    reviewAfter: "2026-12-15",
    reason: "Export-only reserve-store facade; overview and freshness admission are exercised through direct defining-module imports, with separate read/write/history contracts.",
    owner: "worker/src/lib/live-reserves/store-overview.ts",
    ownerTest: "worker/src/lib/__tests__/live-reserves-store.test.ts",
  },
  "shared/lib/psi-eligible-client.ts": {
    reviewAfter: "2026-12-15",
    reason: "Slim client metadata projection only, with no PSI scoring decisions; the eligibility contract checks exact parity with the server monitoring universe.",
    owner: "shared/lib/psi-eligible.ts",
    ownerTest: "shared/lib/__tests__/psi-eligible.test.ts",
  },
};
export const CRITICAL_OWNERSHIP = deriveCriticalOwnership();
export const CRITICAL_FILES = collectCriticalCoverageCandidates()
  .filter((file) => (CRITICAL_OWNERSHIP.get(file)?.length ?? 0) > 0 && !Object.hasOwn(CRITICAL_COVERAGE_WAIVERS, file));

/**
 * @param {readonly string[]} changedFiles
 * @param {ReadonlyMap<string, readonly string[]>} [baseOwnership]
 * @param {ReadonlyMap<string, readonly string[]>} [ownership]
 */
export function selectChangedCriticalSources(changedFiles, baseOwnership = new Map(), ownership = CRITICAL_OWNERSHIP) {
  const changed = new Set(changedFiles);
  const candidates = collectCriticalCoverageCandidates().filter((file) => !Object.hasOwn(CRITICAL_COVERAGE_WAIVERS, file));
  return candidates.filter((file) => (CRITICAL_FILES.includes(file) && changed.has(file))
    || (ownership.get(file) ?? []).some((test) => changed.has(test))
    || (baseOwnership.get(file) ?? []).some((test) => changed.has(test)));
}

export function criticalCoverageFilesForChanges(changedFiles, baseRef) {
  if (!changedFiles) return CRITICAL_FILES;
  const baseOwnership = baseRef ? deriveBaseCriticalOwnership(baseRef, changedFiles) : new Map();
  const affected = selectChangedCriticalSources(changedFiles, baseOwnership);
  return [...new Set([...CRITICAL_FILES, ...affected])];
}

export function normalizePath(value) {
  return value.replaceAll("\\", "/");
}

export function parseLcov(content) {
  const blocks = content.split("end_of_record\n");
  const map = new Map();

  for (const block of blocks) {
    const lines = block.trim().split("\n").filter(Boolean);
    if (lines.length === 0) continue;

    const sf = lines.find((line) => line.startsWith("SF:"));
    if (!sf) continue;
    const file = normalizePath(sf.slice(3));

    let lf = 0;
    let lh = 0;
    let brf = null;
    let brh = null;
    for (const line of lines) {
      if (line.startsWith("LF:")) lf = Number.parseInt(line.slice(3), 10);
      if (line.startsWith("LH:")) lh = Number.parseInt(line.slice(3), 10);
      if (line.startsWith("BRF:")) brf = Number.parseInt(line.slice(4), 10);
      if (line.startsWith("BRH:")) brh = Number.parseInt(line.slice(4), 10);
    }

    if (Number.isFinite(lf) && lf > 0) {
      map.set(file, {
        lf,
        lh,
        pct: (lh / lf) * 100,
        brf,
        brh,
        branchPct: Number.isFinite(brf) && brf > 0 && Number.isFinite(brh) ? (brh / brf) * 100 : null,
      });
    }
  }

  return map;
}

export function findCoverageFor(file, map) {
  for (const [key, value] of map.entries()) {
    if (key.endsWith(file)) return { key, ...value };
  }
  return null;
}

/**
 * @param {Record<string, unknown>} baseline
 * @param {readonly string[]} criticalFiles
 * @param {(file: string) => number} thresholdForFile
 */
export function validateCriticalCoverageBaseline(baseline, criticalFiles, thresholdForFile) {
  const errors = [];
  for (const file of criticalFiles) {
    const value = baseline[file];
    const threshold = thresholdForFile(file);
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 100) {
      errors.push(`${file}: baseline must be a finite number between 0 and 100`);
    } else if (value < threshold) {
      errors.push(`${file}: baseline ${value.toFixed(1)}% is below enforced floor ${threshold.toFixed(1)}%`);
    }
  }
  return errors;
}

export function collectCriticalCoverageCandidates({
  cwd = process.cwd(),
  sourceFiles = collectCriticalCoverageSourceFiles(cwd),
} = {}) {
  return sourceFiles
    .map(normalizePath)
    .filter((file) => !shouldSkipCriticalCoverageScanFile(file))
    .filter(isHighStakesCoverageCandidate)
    .sort();
}

export function findCriticalCoverageCandidatesMissingEnrollment(
  candidateFiles,
  {
    criticalFiles = CRITICAL_FILES,
    waivers = CRITICAL_COVERAGE_WAIVERS,
    ownershipWaivers = CRITICAL_OWNERSHIP_WAIVERS,
  } = {},
) {
  const criticalSet = new Set(criticalFiles);
  const waiverSet = new Set([...Object.keys(waivers), ...Object.keys(ownershipWaivers)]);
  return candidateFiles.filter((file) => !criticalSet.has(file) && !waiverSet.has(file));
}

/** @param {string[]} candidateFiles @param {Record<string, unknown>} [waivers] */
export function findStaleCriticalCoverageWaivers(candidateFiles, waivers = CRITICAL_COVERAGE_WAIVERS) {
  const candidateSet = new Set(candidateFiles);
  return Object.keys(waivers).filter((file) => !candidateSet.has(file));
}

/**
 * @param {Record<string, { reviewAfter?: unknown, reason?: unknown, owner?: unknown, ownerTest?: unknown }>} waivers
 * @param {{ candidateFiles?: string[], criticalFiles?: string[], ownership?: ReadonlyMap<string, readonly string[]> }} [options]
 */
export function validateCriticalCoverageWaiverMetadata(
  waivers,
  {
    candidateFiles,
    criticalFiles = CRITICAL_FILES,
    ownership = CRITICAL_OWNERSHIP,
  } = {},
) {
  const errors = [];
  const candidateSet = candidateFiles ? new Set(candidateFiles) : null;
  const criticalSet = new Set(criticalFiles);

  for (const [file, waiver] of Object.entries(waivers)) {
    if (candidateSet && !candidateSet.has(file)) continue;
    if (criticalSet.has(file)) {
      errors.push(`${file}: already enrolled in critical coverage; remove waiver`);
    }
    if (!waiver || typeof waiver !== "object" || !isValidIsoDateOnly(waiver.reviewAfter)) {
      errors.push(`${file}: missing or invalid waiver reviewAfter`);
    }
    if (!waiver || typeof waiver !== "object" || typeof waiver.reason !== "string" || waiver.reason.trim() === "") {
      errors.push(`${file}: missing coverage waiver reason`);
    }
    if (!waiver || typeof waiver !== "object" || typeof waiver.owner !== "string" || !criticalSet.has(waiver.owner)) {
      errors.push(`${file}: coverage waiver owner is not an enrolled implementation`);
    } else if (typeof waiver.ownerTest !== "string" || !(ownership.get(waiver.owner) ?? []).includes(waiver.ownerTest)) {
      errors.push(`${file}: coverage waiver ownerTest does not import its implementation owner`);
    }
  }

  return errors;
}

/**
 * @param {Record<string, { reviewAfter?: unknown, reason?: unknown }>} waivers
 * @param {{ candidateFiles?: string[], criticalFiles?: string[] }} [options]
 */
export function validateCriticalOwnershipWaiverMetadata(
  waivers,
  {
    candidateFiles,
    criticalFiles = CRITICAL_FILES,
  } = {},
) {
  const errors = [];
  const candidateSet = candidateFiles ? new Set(candidateFiles) : null;
  const criticalSet = new Set(criticalFiles);

  for (const [file, waiver] of Object.entries(waivers)) {
    if (candidateSet && !candidateSet.has(file)) continue;
    if (criticalSet.has(file)) {
      errors.push(`${file}: already enrolled in critical coverage; remove ownership waiver`);
    }
    if (!waiver || typeof waiver !== "object" || !isValidIsoDateOnly(waiver.reviewAfter)) {
      errors.push(`${file}: missing or invalid ownership waiver reviewAfter`);
    }
    if (!waiver || typeof waiver !== "object" || typeof waiver.reason !== "string" || waiver.reason.trim() === "") {
      errors.push(`${file}: missing ownership waiver reason`);
    }
  }

  return errors;
}

/**
 * @param {Record<string, { reviewAfter?: unknown }>} waivers
 * @param {{ today?: Date, lookaheadDays?: number, candidateFiles?: string[] }} [options]
 */
export function collectCriticalCoverageWaiverReviewQueue(
  waivers,
  {
    today = new Date(),
    lookaheadDays = 14,
    candidateFiles,
  } = {},
) {
  const candidateSet = candidateFiles ? new Set(candidateFiles) : null;
  const todayString = toUtcDateOnly(today);
  const lookahead = new Date(`${todayString}T00:00:00.000Z`);
  lookahead.setUTCDate(lookahead.getUTCDate() + lookaheadDays);
  const lookaheadString = toUtcDateOnly(lookahead);
  const due = [];
  const upcoming = [];

  for (const [file, waiver] of Object.entries(waivers)) {
    if (candidateSet && !candidateSet.has(file)) continue;
    const reviewAfter = waiver?.reviewAfter;
    if (!isValidIsoDateOnly(reviewAfter)) continue;
    const row = { file, reviewAfter };
    if (reviewAfter <= todayString) {
      due.push(row);
    } else if (reviewAfter <= lookaheadString) {
      upcoming.push(row);
    }
  }

  const sortByReviewDate = (left, right) =>
    left.reviewAfter.localeCompare(right.reviewAfter) || left.file.localeCompare(right.file);

  return {
    due: due.sort(sortByReviewDate),
    upcoming: upcoming.sort(sortByReviewDate),
  };
}

function collectCriticalCoverageSourceFiles(cwd) {
  return HIGH_STAKES_COVERAGE_SCAN_ROOTS.flatMap((root) =>
    collectSourceFilesUnderRoot(root, cwd, {
      extensions: HIGH_STAKES_COVERAGE_SCAN_EXTENSIONS,
      excludedDirs: HIGH_STAKES_COVERAGE_SCAN_EXCLUDED_DIRS,
      skipDotEntries: true,
    }),
  )
    .map((absPath) => normalizePath(relative(cwd, absPath)))
    .filter((relPath) => !shouldSkipCriticalCoverageScanFile(relPath))
    .sort();
}

function shouldSkipCriticalCoverageScanFile(relPath) {
  return (
    relPath.endsWith(".d.ts") ||
    relPath.includes("/__tests__/") ||
    /\.(test|spec)\.[cm]?[jt]sx?$/.test(relPath) ||
    relPath.endsWith("/types.ts") ||
    relPath.endsWith("-types.ts")
  );
}

function isHighStakesCoverageCandidate(file) {
  return (
    HIGH_STAKES_COVERAGE_CANDIDATE_FILES.has(file) ||
    HIGH_STAKES_COVERAGE_CANDIDATE_PREFIXES.some((prefix) => file.startsWith(prefix)) ||
    HIGH_STAKES_COVERAGE_CANDIDATE_PATTERNS.some((pattern) => pattern.test(file))
  );
}

function toUtcDateOnly(date) {
  return date.toISOString().slice(0, 10);
}
