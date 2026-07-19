import { relative } from "node:path";

import { isValidDateOnly } from "./date-helpers.mjs";
import { collectSourceFilesUnderRoot } from "./source-files.mjs";

export const CRITICAL_FILES = [
  "src/lib/api.ts",
  "worker/src/api/safety-score-history-v2.ts",
  "worker/src/lib/safety-score-current-identity.ts",
  "worker/src/lib/api-cache-read.ts",
  "worker/src/lib/api-freshness.ts",
  "worker/src/lib/api-freshness-headers.ts",
  "worker/src/lib/freshness-sentinels.ts",
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
  "worker/src/lib/stablecoin-publication-alerts.ts",
  "worker/src/lib/stablecoin-publication-coverage.ts",
  "worker/src/lib/stablecoin-publication-health.ts",
  "worker/src/lib/safety-scores.ts",
  "worker/src/lib/mint-burn-scoring.ts",
  "worker/src/lib/mint-burn-historical-price-repair.ts",
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
  "worker/src/lib/dews/signal-families.ts",
  "worker/src/lib/dews-publication-pointer.ts",
  "worker/src/cron/compute-depeg-resolver.ts",
  "worker/src/cron/compute-depeg-resolver-review.ts",
  "worker/src/cron/depeg-detection/decision-engine.ts",
  "worker/src/cron/depeg-detection/native-quote-policy.ts",
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
  "worker/src/lib/depeg-resolver-incident-store.ts",
  "worker/src/lib/depeg-resolver-publication-store.ts",
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
  "worker/src/lib/price-divergence.ts",
  "worker/src/lib/price-validation.ts",
  "worker/src/lib/price-publish-policy.ts",
  "worker/src/lib/price-publication-state.ts",
  "worker/src/lib/pricing-circuit-map.ts",
  "worker/src/lib/pricing-provider-runtime-state.ts",
  "worker/src/lib/pricing-source-freshness.ts",
  "worker/src/lib/primary-price-collector.ts",
  "worker/src/lib/dex-price-estimators.ts",
  "worker/src/lib/geckoterminal-price-probe.ts",
  "worker/src/lib/address-price-providers/dexpaprika.ts",
  "worker/src/lib/address-price-providers/dexscreener.ts",
  "worker/src/lib/address-price-providers/index.ts",
  "worker/src/lib/address-price-providers/shared.ts",
  "worker/src/lib/authoritative-price-sources/aznd-curve-pool.ts",
  "worker/src/lib/authoritative-price-sources/cap-cusd.ts",
  "worker/src/lib/authoritative-price-sources/erc4626-nav.ts",
  "worker/src/lib/authoritative-price-sources/helpers.ts",
  "worker/src/lib/authoritative-price-sources/idle-cdo-tranche.ts",
  "worker/src/lib/authoritative-price-sources/index.ts",
  "worker/src/lib/authoritative-price-sources/infinifi-iusd.ts",
  "worker/src/lib/authoritative-price-sources/inherited-tracked.ts",
  "worker/src/lib/authoritative-price-sources/jusd-stablecoin-bridge.ts",
  "worker/src/lib/authoritative-price-sources/kava-pricefeed.ts",
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
  "worker/src/lib/publication-contract.ts",
  "worker/src/lib/report-card-publication.ts",
  "shared/lib/safety-score-v8-publication.ts",
  "worker/src/api/admin-safety-score-v9.ts",
  "worker/src/lib/safety-score-history-v2.ts",
  "worker/src/lib/safety-score-history-boundary-operation.ts",
  "worker/src/lib/safety-score-v9-anchor-gate.ts",
  "worker/src/lib/safety-score-v9-cache-codec.ts",
  "worker/src/lib/safety-score-v9-candidate.ts",
  "worker/src/lib/safety-score-v9-extension.ts",
  "worker/src/lib/safety-score-v9-extension-mechanism.ts",
  "worker/src/lib/safety-score-v9-extension-reserves.ts",
  "worker/src/lib/safety-score-v9-extension-routes.ts",
  "worker/src/lib/safety-score-v9-extension-shock.ts",
  "worker/src/lib/safety-score-v9-extension-supply.ts",
  "worker/src/lib/safety-score-v9-extension-transfer.ts",
  "worker/src/lib/safety-score-v9-release-coverage.ts",
  "worker/src/lib/safety-score-v9-fact-set-boundary.ts",
  "worker/src/lib/safety-score-v9-fact-set.ts",
  "worker/src/lib/safety-score-v9-movement-reviews.ts",
  "worker/src/lib/safety-score-v9-shadow-runner.ts",
  "worker/src/lib/safety-score-v9-shadow.ts",
  "worker/src/lib/safety-score-v9-store.ts",
  "worker/src/cron/daily-digest.ts",
  "worker/src/cron/sync-yield-data.ts",
  "worker/src/api/discovery.ts",
  "worker/src/api/peg-summary.ts",
  "worker/src/api/report-cards.ts",
  "worker/src/api/dex-liquidity.ts",
  "worker/src/api/stress-signals.ts",
  "worker/src/lib/stress-signals-current-rows.ts",
  "worker/src/api/mint-burn-flows.ts",
  "worker/src/api/status.ts",
  "worker/src/api/telegram-webhook.ts",
  "worker/src/api/telegram-webhook-callbacks.ts",
  "worker/src/api/telegram-webhook-effect-fence.ts",
  "worker/src/api/telegram-webhook-setup.ts",
  "worker/src/api/telegram-store/watchlist-import.ts",
  "worker/src/api/telegram-mini-app.ts",
  "worker/src/api/telegram-mini-app-state.ts",
  "worker/src/api/telegram-mini-app-mutations.ts",
  "shared/lib/telegram-mini-app-contract.ts",
  "worker/src/lib/telegram-mini-app-auth.ts",
  "src/app/pharoswatchbot/app/client.tsx",
  "src/app/pharoswatchbot/app/mini-app-api.ts",
  "src/app/pharoswatchbot/app/telegram-sdk.ts",
  "src/app/pharoswatchbot/app/telegram-theme.ts",
  "worker/src/cron/dispatch-telegram-alerts.ts",
  "worker/src/cron/dispatch-telegram-authoritative-path.ts",
  "worker/src/cron/dispatch-telegram-authoritative-planning.ts",
  "worker/src/cron/dispatch-telegram-routing.ts",
  "worker/src/cron/dispatch-telegram-delivery.ts",
  "worker/src/cron/telegram-alert-source-events.ts",
  "worker/src/cron/telegram-alert-job-target-outcomes.ts",
  "worker/src/lib/telegram-delivery-sli.ts",
  "worker/src/cron/telegram-alert-target-plans/coordinator.ts",
  "worker/src/cron/telegram-alert-target-plans/delivery.ts",
  "worker/src/cron/telegram-alert-target-plans/horizon.ts",
  "worker/src/cron/telegram-alert-target-plans/materialization.ts",
  "worker/src/cron/telegram-alert-target-plans/read-model.ts",
  "worker/src/cron/telegram-alert-target-plans/source-state.ts",
  "worker/src/cron/telegram-legacy-overflow-import.ts",
  "worker/src/cron/telegram-pending/capacity.ts",
  "worker/src/cron/telegram-pending/cleanup.ts",
  "worker/src/cron/telegram-pending/dead-letter.ts",
  "worker/src/cron/telegram-pending/drain.ts",
  "worker/src/cron/telegram-pending/dedupe.ts",
  "worker/src/cron/telegram-pending/enqueue.ts",
  "worker/src/cron/telegram-pending/lifecycle.ts",
  "worker/src/cron/telegram-pending/preference-revalidation.ts",
  "worker/src/lib/telegram-transport-control.ts",
  "worker/src/lib/telegram-watchlist-token.ts",
  "worker/src/lib/telegram.ts",
  "shared/lib/telegram-adoption-analytics.ts",
  "worker/src/lib/telegram-adoption-analytics.ts",
  "worker/src/api/admin-telegram-adoption-report.ts",
  "functions/pharoswatchbot-adoption.ts",
  "src/app/pharoswatchbot/telegram-adoption-link.tsx",
  "worker/src/lib/alerts.ts",
  "worker/src/api/stablecoin-detail.ts",
  "worker/src/cron/dex-liquidity/orchestrator.ts",
  "worker/src/api/blacklist.ts",
  "worker/src/api/blacklist-summary.ts",
  "worker/src/lib/blacklist-contracts.ts",
  "worker/src/cron/sync-blacklist.ts",
  "shared/lib/api-freshness.ts",
  "shared/lib/liquidity-score-weights.ts",
  "shared/lib/mint-authority-scoring.ts",
  "shared/lib/peg-score.ts",
  "shared/lib/psi-eligible.ts",
  "shared/lib/safety-score-v9-compiler.ts",
  "shared/lib/safety-score-v9-research.ts",
  "shared/lib/yield-scoring.ts",
  "shared/lib/report-card-blacklist-matchers.ts",
  "shared/lib/blacklist-active-records.ts",
  "shared/lib/selector/snapshot.ts",
  "shared/lib/selector/snapshot-normalize.ts",
  "functions/_middleware.ts",
  "functions/selector-snapshot/[[path]].ts",
  "functions/api/admin/[[path]].ts",
  "functions/_site-data/[[path]].ts",
  "functions/lib/csp-inject.ts",
  "functions/lib/pages-proxy-harness.ts",
  "functions/lib/proxy-paths.ts",
  "functions/lib/proxy-utils.ts",
  "functions/lib/upstream-proxy.ts",
];

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
  /^worker\/src\/lib\/live-reserves-store.*\.ts$/,
  /^worker\/src\/lib\/(?!(?:[^/]*-(?:version|colors))\.ts$)[^/]*(score|scoring|freshness|publication|psi)[^/]*\.ts$/,
  /^worker\/src\/api\/[^/]*(score|scoring|freshness|publication|psi)[^/]*\.ts$/,
  /^shared\/lib\/(?!(?:[^/]*-(?:version|colors))\.ts$)[^/]*(score|scoring|freshness|psi)[^/]*\.ts$/,
  /^functions\/lib\/[^/]*proxy[^/]*\.ts$/,
];
const CRITICAL_COVERAGE_WAIVER_CREATED_AT = "2026-06-05";
const CRITICAL_COVERAGE_WAIVER_DEFAULT_REVIEW_AFTER = "2026-09-05";
const CRITICAL_COVERAGE_WAIVER_DDR_REVIEW_AFTER = "2026-08-30";
const CRITICAL_COVERAGE_WAIVER_DISPOSITIONS = new Set([
  "covered-by-enrolled-entrypoint",
  "barrel-or-contract",
  "deferred-ratchet",
]);

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
  "worker/src/cron/sync-stablecoins/enrich-prices-progress.ts",
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
  "worker/src/cron/sync-stablecoins/tracked-asset-overrides.ts",
  "worker/src/cron/sync-stablecoins/zephyr-zsd.ts",
  "worker/src/api/safety-score-history.ts",
  "worker/src/lib/address-price-providers/alchemy.ts",
  "worker/src/lib/address-price-providers/birdeye.ts",
  "worker/src/lib/address-price-providers/coingecko-onchain.ts",
  "worker/src/lib/address-price-providers/moralis.ts",
  "worker/src/lib/authoritative-price-sources.ts",
  "worker/src/lib/coingecko-simple-price.ts",
  "worker/src/lib/depeg-resolver-assessment-store.ts",
  "worker/src/lib/depeg-resolver-errata-store.ts",
  "worker/src/lib/depeg-resolver-methodology.ts",
  "worker/src/lib/depeg-resolver-repair-store.ts",
  "worker/src/lib/depeg-resolver-review-snapshot-cache.ts",
  "worker/src/lib/depeg-resolver-snapshot-cache.ts",
  "worker/src/lib/depeg-resolver-store-validators.ts",
  "worker/src/lib/dex-api-token-pricing.ts",
  "worker/src/lib/live-reserves-store.ts",
  "worker/src/lib/native-peg-implied-prices.ts",
  "worker/src/lib/pricing-provider-diagnostics.ts",
  "worker/src/lib/pricing-provider-lifecycle.ts",
  "worker/src/lib/psi-history-universe.ts",
  "worker/src/lib/psi-recompute.ts",
  "worker/src/lib/psi-replay.ts",
  "shared/lib/psi-contribution.ts",
  "shared/lib/psi-eligible-client.ts",
  "shared/lib/psi-view-model.ts",
  "shared/lib/redemption-backstop-scoring.ts",
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

/**
 * @param {Record<string, object>} waivers
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
    if (!isValidDateOnly(waiver.reviewAfter)) {
      errors.push(`${file}: missing or invalid waiver reviewAfter`);
    }
    if (isValidDateOnly(waiver.createdAt) && isValidDateOnly(waiver.reviewAfter) && waiver.reviewAfter < waiver.createdAt) {
      errors.push(`${file}: waiver reviewAfter must be on or after createdAt`);
    }
    if (typeof waiver.nextAction !== "string" || waiver.nextAction.trim().length === 0) {
      errors.push(`${file}: missing waiver nextAction`);
    }
    if (
      typeof waiver.directEnrollmentCondition !== "string" ||
      waiver.directEnrollmentCondition.trim().length === 0
    ) {
      errors.push(`${file}: missing waiver directEnrollmentCondition`);
    }
  }

  return errors;
}

/**
 * @param {Record<string, object>} waivers
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
    if (!isValidDateOnly(waiver?.reviewAfter)) continue;
    const row = {
      file,
      owner: waiver.owner ?? "unknown",
      reviewAfter: waiver.reviewAfter,
      nextAction: waiver.nextAction ?? "",
      directEnrollmentCondition: waiver.directEnrollmentCondition ?? "",
    };
    if (waiver.reviewAfter <= todayString) {
      due.push(row);
    } else if (waiver.reviewAfter <= lookaheadString) {
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
    file.endsWith("pricing-source-policy.ts") ||
    file.endsWith("redemption-backstop-scoring.ts") ||
    file.endsWith("safety-score-history.ts") ||
    file.includes("/psi-");
  const disposition = isContractOnly ? "barrel-or-contract" : isDeferred ? "deferred-ratchet" : "covered-by-enrolled-entrypoint";

  return {
    disposition,
    owner: "platform",
    createdAt: CRITICAL_COVERAGE_WAIVER_CREATED_AT,
    reviewAfter: waiverReviewAfterForFile(file),
    reason: waiverReasonForFile(file),
    nextAction: waiverNextActionForFile(file, disposition),
    directEnrollmentCondition: waiverDirectEnrollmentConditionForFile(file, disposition),
  };
}

function waiverReviewAfterForFile(file) {
  if (file.includes("/depeg-resolver/") || file.includes("/depeg-resolver-")) {
    return CRITICAL_COVERAGE_WAIVER_DDR_REVIEW_AFTER;
  }
  return CRITICAL_COVERAGE_WAIVER_DEFAULT_REVIEW_AFTER;
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
  if (file.endsWith("depeg-resolver-methodology.ts")) {
    return "DDR methodology envelope helper is covered by enrolled depeg-resolver API tests that assert the public methodology payload.";
  }
  if (file.includes("/depeg-resolver-")) {
    return "DDR durable store or validator module is covered by depeg-resolver store/cron tests, but is tracked as a reviewed support surface until promoted to a standalone critical-coverage target.";
  }
  if (file.includes("/dews/")) {
    return "DEWS support helper is covered by the enrolled compute-dews suite; promote it if it becomes a scoring decision boundary.";
  }
  if (file.includes("sync-live-reserves")) {
    return "Live-reserve support/config helper is covered by the enrolled sync-live-reserves suite; promote it if it starts owning persistence or scoring logic.";
  }
  if (file.includes("/psi-")) {
    return "PSI support module has focused tests outside the critical coverage lane; keep waived until PSI recompute/history or client-display tests join the critical suite.";
  }
  if (file.endsWith("redemption-backstop-scoring.ts")) {
    return "Redemption backstop scoring has focused tests outside the critical coverage lane; keep waived until report-card scoring joins the critical suite.";
  }
  if (file.endsWith("safety-score-history.ts")) {
    return "Safety score history endpoint has focused API tests outside the critical coverage lane; keep waived until that endpoint joins the critical suite.";
  }
  return "Reviewed high-stakes support module; current critical behavior is covered by an enrolled entrypoint test suite.";
}

function waiverNextActionForFile(file, disposition) {
  if (disposition === "barrel-or-contract") {
    return "Keep as a metadata-only waiver while the module remains a barrel, config, or contract surface; enroll the concrete runtime module instead.";
  }
  if (file.includes("/sync-stablecoins/")) {
    return "Review split pricing helpers for independent source-selection, fallback, or publication behavior before the next coverage ratchet cycle.";
  }
  if (file.includes("/address-price-providers/")) {
    return "Add provider-specific critical tests before promoting the fetcher from entrypoint-covered waiver to direct coverage.";
  }
  if (file.endsWith("depeg-resolver-incident-store.ts") || file.endsWith("depeg-resolver-publication-store.ts")) {
    return "Add direct DDR store tests for row mapping, state transitions, malformed payloads, and D1 failures before enrollment.";
  }
  if (file.includes("/depeg-resolver/") || file.includes("/depeg-resolver-")) {
    return "Review DDR support helpers after the store-level test tranche and promote any decision-boundary module to direct coverage.";
  }
  if (file.includes("/dews/")) {
    return "Promote to direct coverage if the helper starts owning DEWS scoring decisions instead of support plumbing.";
  }
  if (file.includes("sync-live-reserves") || file.includes("live-reserves-store")) {
    return "Promote reserve support modules when persistence, scoring, or row-decoding behavior has direct critical tests.";
  }
  if (file.includes("/psi-")) {
    return "Promote PSI support modules when the PSI recompute/history or client-display test lane is added to critical coverage.";
  }
  if (file.endsWith("redemption-backstop-scoring.ts")) {
    return "Promote redemption backstop scoring when report-card scoring tests become part of critical coverage.";
  }
  if (file.endsWith("safety-score-history.ts")) {
    return "Promote the safety-score history endpoint when its focused API tests become part of critical coverage.";
  }
  return "Review whether entrypoint coverage still exercises the file's critical behavior; add direct tests before enrollment.";
}

function waiverDirectEnrollmentConditionForFile(file, disposition) {
  if (disposition === "barrel-or-contract") {
    return "Runtime behavior is added to this module, or the barrel starts hiding critical branch logic that cannot be ratcheted through concrete implementation files.";
  }
  if (file.includes("/sync-stablecoins/")) {
    return "Focused critical tests cover the helper's source selection, fallback, cache-publication, or payload-shaping behavior without relying only on the enrolled sync entrypoint.";
  }
  if (file.includes("/address-price-providers/")) {
    return "Provider-specific tests cover success, malformed response, non-OK response, timeout or circuit behavior, and normalized diagnostics.";
  }
  if (file.endsWith("depeg-resolver-incident-store.ts")) {
    return "Direct incident-store tests cover row mapping, lock transitions, malformed payload handling, and D1 failure behavior.";
  }
  if (file.endsWith("depeg-resolver-publication-store.ts")) {
    return "Direct publication-store tests cover publication row mapping, payload validation, projection reads, and D1 failure behavior.";
  }
  if (file.includes("/depeg-resolver/") || file.includes("/depeg-resolver-")) {
    return "Direct DDR tests cover the helper's decision boundary or durable-store behavior instead of only cron-level orchestration.";
  }
  if (file.includes("/dews/")) {
    return "Direct DEWS tests cover scoring or source-state decisions owned by the helper.";
  }
  if (file.includes("sync-live-reserves") || file.includes("live-reserves-store")) {
    return "Direct reserve tests cover persistence, row decoding, or scoring behavior owned by the module.";
  }
  if (file.includes("/psi-")) {
    return "Direct PSI recompute, replay, eligibility, contribution, or display tests are included in the critical coverage suite.";
  }
  if (file.endsWith("redemption-backstop-scoring.ts")) {
    return "Direct redemption backstop scoring tests are included in the critical coverage suite.";
  }
  if (file.endsWith("safety-score-history.ts")) {
    return "Focused safety-score history API tests are included in the critical coverage suite.";
  }
  return "Direct critical tests cover this module's high-stakes behavior independently of the enrolled entrypoint suite.";
}

function toUtcDateOnly(date) {
  return date.toISOString().slice(0, 10);
}
