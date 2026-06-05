import { readdirSync } from "node:fs";
import { extname, join, relative, resolve } from "node:path";

export const CRITICAL_FILES = [
  "src/lib/api.ts",
  "worker/src/lib/api-cache-read.ts",
  "worker/src/lib/api-freshness.ts",
  "worker/src/lib/api-history.ts",
  "worker/src/lib/api-pagination.ts",
  "worker/src/lib/api-params.ts",
  "worker/src/lib/api-response.ts",
  "worker/src/lib/api-key-auth.ts",
  "worker/src/lib/api-key-core.ts",
  "worker/src/lib/api-key-rate-limit.ts",
  "worker/src/lib/auth.ts",
  "worker/src/lib/evm-rpc.ts",
  "worker/src/lib/stablecoins-cache.ts",
  "worker/src/lib/safety-scores.ts",
  "worker/src/handlers/scheduled.ts",
  "worker/src/handlers/http/gates.ts",
  "worker/src/api/health.ts",
  "worker/src/cron/sync-stablecoins.ts",
  "worker/src/cron/sync-stablecoins/enrich-prices.ts",
  "worker/src/cron/sync-stablecoins/pricing.ts",
  "worker/src/cron/detect-depegs.ts",
  "worker/src/cron/confirm-pending-depegs.ts",
  "worker/src/cron/pending-depeg-confirmation.ts",
  "worker/src/cron/pending-depeg-confirmation-decision.ts",
  "worker/src/cron/pending-depeg-confirmation-evidence.ts",
  "worker/src/cron/compute-dews.ts",
  "worker/src/cron/compute-depeg-resolver.ts",
  "worker/src/cron/compute-depeg-resolver-review.ts",
  "worker/src/cron/depeg-detection/decision-engine.ts",
  "worker/src/cron/depeg-detection/hydration.ts",
  "worker/src/cron/depeg-detection/persistence.ts",
  "worker/src/cron/depeg-detection/repair.ts",
  "worker/src/cron/depeg-resolver/context.ts",
  "worker/src/cron/depeg-resolver/incident-resolution.ts",
  "worker/src/cron/depeg-resolver/incident-state.ts",
  "worker/src/cron/depeg-resolver/options.ts",
  "worker/src/cron/depeg-resolver/persistence.ts",
  "worker/src/cron/depeg-resolver/public-projection.ts",
  "worker/src/cron/depeg-resolver/publication.ts",
  "worker/src/cron/depeg-resolver/utils.ts",
  "worker/src/cron/dews/persistence.ts",
  "worker/src/cron/dews/scoring.ts",
  "worker/src/cron/dews/source-state.ts",
  "worker/src/cron/dews/source-state/fallback.ts",
  "worker/src/cron/dews/source-state/hydration.ts",
  "worker/src/cron/dews/source-state/legacy-bridge.ts",
  "worker/src/cron/sync-live-reserves.ts",
  "worker/src/cron/sync-live-reserves-core.ts",
  "worker/src/cron/sync-live-reserves-finalize.ts",
  "worker/src/cron/sync-live-reserves-run-state.ts",
  "worker/src/cron/sync-live-reserves-shared.ts",
  "worker/src/cron/reserve-adapters/cap-vault.ts",
  "worker/src/lib/price-consensus.ts",
  "worker/src/lib/price-validation.ts",
  "worker/src/lib/price-publish-policy.ts",
  "worker/src/lib/pricing-circuit-map.ts",
  "worker/src/lib/pricing-source-freshness.ts",
  "worker/src/lib/primary-price-collector.ts",
  "worker/src/lib/dex-price-estimators.ts",
  "worker/src/lib/geckoterminal-price-probe.ts",
  "worker/src/lib/address-price-providers/dexpaprika.ts",
  "worker/src/lib/address-price-providers/dexscreener.ts",
  "worker/src/lib/address-price-providers/index.ts",
  "worker/src/lib/address-price-providers/shared.ts",
  "worker/src/lib/authoritative-price-sources/cap-cusd.ts",
  "worker/src/lib/authoritative-price-sources/erc4626-nav.ts",
  "worker/src/lib/authoritative-price-sources/helpers.ts",
  "worker/src/lib/authoritative-price-sources/idle-cdo-tranche.ts",
  "worker/src/lib/authoritative-price-sources/index.ts",
  "worker/src/lib/authoritative-price-sources/infinifi-iusd.ts",
  "worker/src/lib/authoritative-price-sources/inherited-tracked.ts",
  "worker/src/lib/authoritative-price-sources/preview-redeem.ts",
  "worker/src/lib/authoritative-price-sources/protocol-par.ts",
  "worker/src/lib/live-reserves-store-overview.ts",
  "worker/src/lib/live-reserves-store-read.ts",
  "worker/src/lib/live-reserves-store-row-decoding.ts",
  "worker/src/lib/live-reserves-store-shared.ts",
  "worker/src/lib/live-reserves-store-snapshot-state.ts",
  "worker/src/lib/live-reserves-store-statements.ts",
  "worker/src/lib/live-reserves-store-views.ts",
  "worker/src/lib/live-reserves-store-write.ts",
  "worker/src/cron/daily-digest.ts",
  "worker/src/cron/sync-yield-data.ts",
  "worker/src/api/discovery.ts",
  "worker/src/api/peg-summary.ts",
  "worker/src/api/report-cards.ts",
  "worker/src/api/dex-liquidity.ts",
  "worker/src/api/stress-signals.ts",
  "worker/src/api/mint-burn-flows.ts",
  "worker/src/api/status.ts",
  "worker/src/api/telegram-webhook.ts",
  "worker/src/api/telegram-webhook-callbacks.ts",
  "worker/src/api/telegram-mini-app.ts",
  "worker/src/api/telegram-mini-app-state.ts",
  "worker/src/api/telegram-mini-app-mutations.ts",
  "worker/src/api/telegram-mini-app-schemas.ts",
  "worker/src/lib/telegram-mini-app-auth.ts",
  "worker/src/lib/alerts.ts",
  "worker/src/api/stablecoin-detail.ts",
  "worker/src/cron/dex-liquidity/orchestrator.ts",
  "worker/src/api/blacklist.ts",
  "worker/src/api/blacklist-summary.ts",
  "worker/src/lib/blacklist-contracts.ts",
  "worker/src/cron/sync-blacklist.ts",
  "shared/lib/report-card-blacklist-matchers.ts",
  "shared/lib/blacklist-active-records.ts",
  "functions/api/admin/[[path]].ts",
  "functions/_site-data/[[path]].ts",
];

const HIGH_STAKES_COVERAGE_SCAN_ROOTS = ["worker/src/cron", "worker/src/lib"];
const HIGH_STAKES_COVERAGE_SCAN_EXTENSIONS = new Set([".ts"]);
const HIGH_STAKES_COVERAGE_CANDIDATE_PREFIXES = [
  "worker/src/cron/sync-stablecoins/",
  "worker/src/cron/depeg-detection/",
  "worker/src/cron/depeg-resolver/",
  "worker/src/cron/dews/",
  "worker/src/lib/address-price-providers/",
  "worker/src/lib/authoritative-price-sources/",
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
]);
const HIGH_STAKES_COVERAGE_CANDIDATE_PATTERNS = [
  /^worker\/src\/cron\/sync-live-reserves-[a-z0-9-]+\.ts$/,
  /^worker\/src\/lib\/[^/]*(price|pricing)[^/]*\.ts$/,
  /^worker\/src\/lib\/live-reserves-store.*\.ts$/,
];
const CRITICAL_COVERAGE_WAIVER_CREATED_AT = "2026-06-05";
const CRITICAL_COVERAGE_WAIVER_DISPOSITIONS = new Set([
  "covered-by-enrolled-entrypoint",
  "barrel-or-contract",
  "deferred-ratchet",
]);
const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;

export const CRITICAL_COVERAGE_WAIVED_FILES = [
  "worker/src/cron/depeg-resolver/constants.ts",
  "worker/src/cron/depeg-resolver/storage-adapters.ts",
  "worker/src/cron/dews/contracts.ts",
  "worker/src/cron/dews/progress.ts",
  "worker/src/cron/sync-live-reserves-config.ts",
  "worker/src/cron/sync-stablecoins/cache-publication.ts",
  "worker/src/cron/sync-stablecoins/enrich-prices-cmc-pass.ts",
  "worker/src/cron/sync-stablecoins/enrich-prices-coingecko-low-volume-pass.ts",
  "worker/src/cron/sync-stablecoins/enrich-prices-defillama-pass.ts",
  "worker/src/cron/sync-stablecoins/enrich-prices-dexscreener-pass.ts",
  "worker/src/cron/sync-stablecoins/enrich-prices-fallback.ts",
  "worker/src/cron/sync-stablecoins/enrich-prices-jupiter-pass.ts",
  "worker/src/cron/sync-stablecoins/enrich-prices-pass-common.ts",
  "worker/src/cron/sync-stablecoins/enrich-prices-passes.ts",
  "worker/src/cron/sync-stablecoins/enrich-prices-primary-consensus.ts",
  "worker/src/cron/sync-stablecoins/enrich-prices-primary-gt-probe.ts",
  "worker/src/cron/sync-stablecoins/enrich-prices-primary-hardening.ts",
  "worker/src/cron/sync-stablecoins/enrich-prices-primary-provider-collection.ts",
  "worker/src/cron/sync-stablecoins/enrich-prices-primary-shared.ts",
  "worker/src/cron/sync-stablecoins/enrich-prices-primary.ts",
  "worker/src/cron/sync-stablecoins/enrich-prices-shared.ts",
  "worker/src/cron/sync-stablecoins/fallback-cache.ts",
  "worker/src/cron/sync-stablecoins/fallback-enrichment.ts",
  "worker/src/cron/sync-stablecoins/fallback-fx.ts",
  "worker/src/cron/sync-stablecoins/fallback-intake.ts",
  "worker/src/cron/sync-stablecoins/fallback-publish.ts",
  "worker/src/cron/sync-stablecoins/fallback.ts",
  "worker/src/cron/sync-stablecoins/intake.ts",
  "worker/src/cron/sync-stablecoins/main-publication.ts",
  "worker/src/cron/sync-stablecoins/metadata.ts",
  "worker/src/cron/sync-stablecoins/phase-helpers.ts",
  "worker/src/cron/sync-stablecoins/post-enrichment.ts",
  "worker/src/cron/sync-stablecoins/runtime.ts",
  "worker/src/cron/sync-stablecoins/shared.ts",
  "worker/src/cron/sync-stablecoins/stages.ts",
  "worker/src/cron/sync-stablecoins/supplemental-assets.ts",
  "worker/src/cron/sync-stablecoins/supplemental-assets/fiat-cg.ts",
  "worker/src/cron/sync-stablecoins/supplemental-assets/gold.ts",
  "worker/src/cron/sync-stablecoins/supplemental-assets/onchain-supply.ts",
  "worker/src/cron/sync-stablecoins/supplemental-assets/shared.ts",
  "worker/src/cron/sync-stablecoins/supplemental-assets/silver.ts",
  "worker/src/cron/sync-stablecoins/supply-gap-reconciliation.ts",
  "worker/src/cron/sync-stablecoins/telegram-tracked-additions.ts",
  "worker/src/cron/sync-stablecoins/zephyr-zsd.ts",
  "worker/src/lib/address-price-providers/alchemy.ts",
  "worker/src/lib/address-price-providers/birdeye.ts",
  "worker/src/lib/address-price-providers/coingecko-onchain.ts",
  "worker/src/lib/address-price-providers/moralis.ts",
  "worker/src/lib/authoritative-price-sources.ts",
  "worker/src/lib/coingecko-simple-price.ts",
  "worker/src/lib/dex-api-token-pricing.ts",
  "worker/src/lib/live-reserves-store.ts",
  "worker/src/lib/native-peg-implied-prices.ts",
  "worker/src/lib/pricing-provider-diagnostics.ts",
  "worker/src/lib/pricing-provider-lifecycle.ts",
  "worker/src/lib/pricing-source-policy.ts",
];

export const CRITICAL_COVERAGE_WAIVERS = Object.fromEntries(
  CRITICAL_COVERAGE_WAIVED_FILES.map((file) => [file, buildCriticalCoverageWaiver(file)]),
);

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
  } = {},
) {
  const criticalSet = new Set(criticalFiles);
  const waiverSet = new Set(Object.keys(waivers));
  return candidateFiles.filter((file) => !criticalSet.has(file) && !waiverSet.has(file));
}

export function findStaleCriticalCoverageWaivers(candidateFiles, waivers = CRITICAL_COVERAGE_WAIVERS) {
  const candidateSet = new Set(candidateFiles);
  return Object.keys(waivers).filter((file) => !candidateSet.has(file));
}

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

  for (const [file, waiver] of Object.entries(waivers)) {
    if (candidateSet && !candidateSet.has(file)) continue;
    if (criticalSet.has(file)) {
      errors.push(`${file}: already enrolled in critical coverage; remove waiver`);
    }
    if (!waiver || typeof waiver !== "object") {
      errors.push(`${file}: missing waiver metadata`);
      continue;
    }
    if (!CRITICAL_COVERAGE_WAIVER_DISPOSITIONS.has(waiver.disposition)) {
      errors.push(`${file}: invalid waiver disposition "${waiver.disposition ?? "missing"}"`);
    }
    if (typeof waiver.reason !== "string" || waiver.reason.trim().length === 0) {
      errors.push(`${file}: missing waiver reason`);
    }
    if (typeof waiver.owner !== "string" || waiver.owner.trim().length === 0) {
      errors.push(`${file}: missing waiver owner`);
    }
    if (!isValidDateOnly(waiver.createdAt)) {
      errors.push(`${file}: missing or invalid waiver createdAt`);
    }
  }

  return errors;
}

function collectCriticalCoverageSourceFiles(cwd) {
  const relPaths = [];

  function walk(absDirPath) {
    for (const entry of readdirSync(absDirPath, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue;
      const absPath = join(absDirPath, entry.name);
      if (entry.isDirectory()) {
        walk(absPath);
        continue;
      }
      if (!HIGH_STAKES_COVERAGE_SCAN_EXTENSIONS.has(extname(entry.name))) continue;
      const relPath = normalizePath(relative(cwd, absPath));
      if (shouldSkipCriticalCoverageScanFile(relPath)) continue;
      relPaths.push(relPath);
    }
  }

  for (const root of HIGH_STAKES_COVERAGE_SCAN_ROOTS) {
    walk(resolve(cwd, root));
  }

  return relPaths.sort();
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

function buildCriticalCoverageWaiver(file) {
  const isContractOnly =
    file.endsWith("/constants.ts") ||
    file.endsWith("/contracts.ts") ||
    file.endsWith("-config.ts") ||
    file.endsWith("authoritative-price-sources.ts") ||
    file.endsWith("live-reserves-store.ts");
  const isDeferred =
    file.endsWith("storage-adapters.ts") ||
    file.endsWith("pricing-provider-lifecycle.ts") ||
    file.endsWith("pricing-provider-diagnostics.ts") ||
    file.endsWith("pricing-source-policy.ts");

  return {
    disposition: isContractOnly ? "barrel-or-contract" : isDeferred ? "deferred-ratchet" : "covered-by-enrolled-entrypoint",
    owner: "platform",
    createdAt: CRITICAL_COVERAGE_WAIVER_CREATED_AT,
    reason: waiverReasonForFile(file),
  };
}

function waiverReasonForFile(file) {
  if (file.includes("/sync-stablecoins/")) {
    return "Pricing sync split helper is covered through the enrolled sync-stablecoins/enrich-prices critical suite; promote it when it becomes an independently edited decision surface.";
  }
  if (file.includes("/address-price-providers/")) {
    return "Provider-specific fetcher is covered through the enrolled address-price provider suite, but not ratcheted independently until provider-specific critical behavior grows.";
  }
  if (file.endsWith("authoritative-price-sources.ts") || file.endsWith("live-reserves-store.ts")) {
    return "Barrel module with no standalone runtime behavior; ratchet the concrete implementation modules instead.";
  }
  if (file.includes("/depeg-resolver/")) {
    return "DDR helper is covered by enrolled depeg-resolver cron tests, but is not a standalone critical-coverage target yet.";
  }
  if (file.includes("/dews/")) {
    return "DEWS support helper is covered by the enrolled compute-dews suite; promote it if it becomes a scoring decision boundary.";
  }
  if (file.includes("sync-live-reserves")) {
    return "Live-reserve support/config helper is covered by the enrolled sync-live-reserves suite; promote it if it starts owning persistence or scoring logic.";
  }
  return "Reviewed high-stakes support module; current critical behavior is covered by an enrolled entrypoint test suite.";
}

function isValidDateOnly(value) {
  if (typeof value !== "string" || !DATE_ONLY_RE.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.valueOf()) && date.toISOString().slice(0, 10) === value;
}
