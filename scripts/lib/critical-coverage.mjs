import { relative } from "node:path";

import { isValidDateOnly } from "./date-helpers.mts";
import {
  CRITICAL_OWNERSHIP_WAIVERS,
  deriveCriticalOwnership,
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
  "worker/src/cron/compute-dews.ts",
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
// Waived high-stakes candidates mapped to their advisory review deadline. The
// completeness guard reports due reviews; it fails only for invalid, stale, or
// missing waiver metadata/enrollment.
/** @type {Record<string, string>} */
export const CRITICAL_COVERAGE_WAIVERS = {
  // These scheduled-path facades and extracted compatibility surfaces are
  // intentionally excluded from the generated enrollment set; their owning
  // implementation modules remain covered by direct import contracts.
  "worker/src/cron/compute-dews.ts": "2026-09-05",
  "worker/src/lib/safety-score-v9/transfer-materiality-observer.ts": "2026-09-05",
  "worker/src/lib/safety-score-v9/transfer-materiality.ts": "2026-09-05",
  "worker/src/cron/sync-live-reserves-config.ts": "2026-09-05",
  "worker/src/cron/sync-stablecoins/cache-publication.ts": "2026-09-05",
  "worker/src/cron/sync-stablecoins/enrich-prices-cmc-pass.ts": "2026-09-05",
  "worker/src/cron/sync-stablecoins/enrich-prices-coingecko-low-volume-pass.ts": "2026-09-05",
  "worker/src/cron/sync-stablecoins/enrich-prices-defillama-pass.ts": "2026-09-05",
  "worker/src/cron/sync-stablecoins/enrich-prices-dexscreener-pass.ts": "2026-09-05",
  "worker/src/cron/sync-stablecoins/enrich-prices-fallback.ts": "2026-09-05",
  "worker/src/cron/sync-stablecoins/enrich-prices-jupiter-pass.ts": "2026-09-05",
  "worker/src/cron/sync-stablecoins/enrich-prices-pass-common.ts": "2026-09-05",
  "worker/src/cron/sync-stablecoins/enrich-prices-passes.ts": "2026-09-05",
  "worker/src/cron/sync-stablecoins/enrich-prices-primary-consensus.ts": "2026-09-05",
  "worker/src/cron/sync-stablecoins/enrich-prices-primary-hardening.ts": "2026-09-05",
  "worker/src/cron/sync-stablecoins/enrich-prices-primary-provider-collection.ts": "2026-09-05",
  "worker/src/cron/sync-stablecoins/enrich-prices-primary-shared.ts": "2026-09-05",
  "worker/src/cron/sync-stablecoins/enrich-prices-primary.ts": "2026-09-05",
  "worker/src/cron/sync-stablecoins/enrich-prices-progress.ts": "2026-09-05",
  "worker/src/cron/sync-stablecoins/enrich-prices-shared.ts": "2026-09-05",
  "worker/src/cron/sync-stablecoins/fallback-enrichment.ts": "2026-09-05",
  "worker/src/cron/sync-stablecoins/fallback-intake.ts": "2026-09-05",
  "worker/src/cron/sync-stablecoins/fallback.ts": "2026-09-05",
  "worker/src/cron/sync-stablecoins/intake.ts": "2026-09-05",
  "worker/src/cron/sync-stablecoins/metadata.ts": "2026-09-05",
  "worker/src/cron/sync-stablecoins/phase-helpers.ts": "2026-09-05",
  "worker/src/cron/sync-stablecoins/post-enrichment.ts": "2026-09-05",
  "worker/src/cron/sync-stablecoins/publication.ts": "2026-09-05",
  "worker/src/cron/sync-stablecoins/runtime.ts": "2026-09-05",
  "worker/src/cron/sync-stablecoins/shared.ts": "2026-09-05",
  "worker/src/cron/sync-stablecoins/stages.ts": "2026-09-05",
  "worker/src/cron/sync-stablecoins/supplemental-assets.ts": "2026-09-05",
  "worker/src/cron/sync-stablecoins/supplemental-assets/fiat-cg.ts": "2026-09-05",
  "worker/src/cron/sync-stablecoins/supplemental-assets/gold.ts": "2026-09-05",
  "worker/src/cron/sync-stablecoins/supplemental-assets/onchain-supply.ts": "2026-09-05",
  "worker/src/cron/sync-stablecoins/supplemental-assets/shared.ts": "2026-09-05",
  "worker/src/cron/sync-stablecoins/supplemental-assets/silver.ts": "2026-09-05",
  "worker/src/cron/sync-stablecoins/supply-gap-reconciliation.ts": "2026-09-05",
  "worker/src/cron/sync-stablecoins/telegram-tracked-additions.ts": "2026-09-05",
  "worker/src/cron/sync-stablecoins/tracked-asset-overrides.ts": "2026-09-05",
  "worker/src/cron/sync-stablecoins/zephyr-zsd.ts": "2026-09-05",
  "worker/src/api/safety-score-history.ts": "2026-09-05",
  "worker/src/lib/address-price-providers/coingecko-onchain.ts": "2026-09-05",
  "worker/src/lib/authoritative-price-sources.ts": "2026-09-05",
  "worker/src/lib/coingecko-simple-price.ts": "2026-09-05",
  "worker/src/lib/dex-api-token-pricing.ts": "2026-09-05",
  "worker/src/lib/live-reserves/store.ts": "2026-09-05",
  "worker/src/lib/native-peg-implied-prices.ts": "2026-09-05",
  "worker/src/lib/pricing-provider-diagnostics.ts": "2026-09-05",
  "worker/src/lib/pricing-provider-lifecycle.ts": "2026-09-05",
  "worker/src/lib/psi-history-universe.ts": "2026-09-05",
  "worker/src/lib/psi-recompute.ts": "2026-09-05",
  "worker/src/lib/psi-replay.ts": "2026-09-05",
  // Extracted from the already-waived shared/lib/redemption-backstop-scoring.ts
  // and carries the same review deadline; the extraction did not change what is
  // covered on either side of it.
  "shared/lib/exit-route-scoring.ts": "2026-09-05",
  "shared/lib/psi-contribution.ts": "2026-09-05",
  "shared/lib/psi-eligible-client.ts": "2026-09-05",
  "shared/lib/psi-view-model.ts": "2026-09-05",
  "shared/lib/redemption-backstop-scoring.ts": "2026-09-05",
};
const generatedCriticalOwnership = deriveCriticalOwnership();
export const CRITICAL_FILES = collectCriticalCoverageCandidates()
  .filter((file) => (generatedCriticalOwnership.get(file)?.length ?? 0) > 0 && !Object.hasOwn(CRITICAL_COVERAGE_WAIVERS, file));

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

export function findStaleCriticalCoverageWaivers(candidateFiles, waivers = CRITICAL_COVERAGE_WAIVERS) {
  const candidateSet = new Set(candidateFiles);
  return Object.keys(waivers).filter((file) => !candidateSet.has(file));
}

/**
 * @param {Record<string, string>} waivers
 * @param {{ candidateFiles?: string[], criticalFiles?: string[] }} [options]
 */
export function validateCriticalCoverageWaiverMetadata(
  waivers,
  {
    candidateFiles,
    criticalFiles = CRITICAL_FILES,
  } = {},
) {
  const errors = [];
  const candidateSet = candidateFiles ? new Set(candidateFiles) : null;
  const criticalSet = new Set(criticalFiles);

  for (const [file, reviewAfter] of Object.entries(waivers)) {
    if (candidateSet && !candidateSet.has(file)) continue;
    if (criticalSet.has(file)) {
      errors.push(`${file}: already enrolled in critical coverage; remove waiver`);
    }
    if (!isValidDateOnly(reviewAfter)) {
      errors.push(`${file}: missing or invalid waiver reviewAfter`);
    }
  }

  return errors;
}

/**
 * @param {Record<string, string>} waivers
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

  for (const [file, reviewAfter] of Object.entries(waivers)) {
    if (candidateSet && !candidateSet.has(file)) continue;
    if (!isValidDateOnly(reviewAfter)) continue;
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
