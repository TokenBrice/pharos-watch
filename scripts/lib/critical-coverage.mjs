import { relative } from "node:path";

import { isValidDateOnly } from "./date-helpers.mjs";
import { collectSourceFilesUnderRoot } from "./source-files.mjs";

export const CRITICAL_FILES = [
  "src/lib/api.ts",
  "worker/src/api/safety-score-history-v2.ts",
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
  "worker/src/cron/depeg-resolver/pre-lock-incident-reaper.ts",
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
  "worker/src/lib/geckoterminal-price-probe-stats.ts",
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
  "worker/src/lib/authoritative-price-sources/rate-cache.ts",
  "worker/src/lib/live-reserves-store-overview.ts",
  "worker/src/lib/live-reserves-store-read.ts",
  "worker/src/lib/live-reserves-store-row-decoding.ts",
  "worker/src/lib/live-reserves-store-shared.ts",
  "worker/src/lib/live-reserves-store-snapshot-state.ts",
  "worker/src/lib/live-reserves-store-statements.ts",
  "worker/src/lib/live-reserves-store-views.ts",
  "worker/src/lib/live-reserves-store-write.ts",
  "worker/src/lib/publication-contract.ts",
  "shared/lib/safety-score-publication.ts",
  "shared/lib/safety-score-v9-input-identity.ts",
  "worker/src/lib/identified-active-safety-score-source.ts",
  "worker/src/lib/safety-score-active-source.ts",
  "worker/src/lib/safety-score-history-v2.ts",
  "worker/src/lib/safety-score-v9-anchor-gate.ts",
  "worker/src/lib/safety-score-v9-candidate.ts",
  "worker/src/lib/safety-score-v9-capture.ts",
  "worker/src/lib/safety-score-v9-consumer-freshness.ts",
  "worker/src/lib/safety-score-v9-extension.ts",
  "worker/src/lib/safety-score-v9-extension-mechanism.ts",
  "worker/src/lib/safety-score-v9-extension-operational-resilience.ts",
  "worker/src/lib/safety-score-v9-extension-reserves.ts",
  "worker/src/lib/safety-score-v9-extension-routes.ts",
  "worker/src/lib/safety-score-v9-extension-shock.ts",
  "worker/src/lib/safety-score-v9-extension-supply.ts",
  "worker/src/lib/safety-score-v9-extension-transfer.ts",
  "worker/src/lib/safety-score-v9-fact-set-backing.ts",
  "worker/src/lib/safety-score-v9-fact-set-boundary.ts",
  "worker/src/lib/safety-score-v9-fact-set-context.ts",
  "worker/src/lib/safety-score-v9-fact-set-control.ts",
  "worker/src/lib/safety-score-v9-fact-set-exit.ts",
  "worker/src/lib/safety-score-v9-fact-set-operational-resilience.ts",
  "worker/src/lib/safety-score-v9-fact-set-peg-supply.ts",
  "worker/src/lib/safety-score-v9-fact-set-schema.ts",
  "worker/src/lib/safety-score-v9-fact-set-wrapper.ts",
  "worker/src/lib/safety-score-v9-fact-set.ts",
  "worker/src/lib/safety-score-v9-native-input.ts",
  "worker/src/lib/safety-score-v9-peg-provenance.ts",
  "worker/src/lib/safety-score-v9-publication-assessment.ts",
  "worker/src/lib/safety-score-v9-publication-codec.ts",
  "worker/src/lib/safety-score-v9-publication-runner.ts",
  "worker/src/lib/safety-score-v9-publication-store.ts",
  "worker/src/lib/safety-score-v9-centrifuge-supply-observer.ts",
  "worker/src/lib/safety-score-v9-supply-observation-primitives.ts",
  "worker/src/lib/safety-score-v9-supply-attribution-contract.ts",
  "worker/src/lib/safety-score-v9-supply-attribution-generation.ts",
  "worker/src/lib/safety-score-v9-supply-attribution-journal-store.ts",
  "worker/src/lib/safety-score-v9-supply-attribution.ts",
  "worker/src/lib/safety-score-v9-wm-supply-observer.ts",
  "worker/src/lib/safety-score-v9-xaut-supply-attribution-contract.ts",
  "worker/src/lib/safety-score-v9-xaut-supply-observer.ts",
  "worker/src/cron/daily-digest.ts",
  "worker/src/cron/sync-yield-data.ts",
  "worker/src/api/peg-summary.ts",
  "worker/src/api/report-cards-v9.ts",
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
  "worker/src/cron/telegram-alert-source-events.ts",
  "worker/src/cron/telegram-alert-job-target-outcomes.ts",
  "worker/src/lib/telegram-delivery-sli.ts",
  "worker/src/cron/telegram-alert-target-plans/coordinator.ts",
  "worker/src/cron/telegram-alert-target-plans/delivery.ts",
  "worker/src/cron/telegram-alert-target-plans/horizon.ts",
  "worker/src/cron/telegram-alert-target-plans/materialization.ts",
  "worker/src/cron/telegram-alert-target-plans/read-model.ts",
  "worker/src/cron/telegram-alert-target-plans/source-state.ts",
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
  "shared/lib/safety-score-v9-research.ts",
  "shared/lib/safety-score-v9-supply-attribution-journal.ts",
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
// Waived high-stakes candidates mapped to their review deadline. The completeness
// guard fails once a reviewAfter date passes, forcing enrollment or a new deadline.
/** @type {Record<string, string>} */
export const CRITICAL_COVERAGE_WAIVERS = {
  "worker/src/cron/depeg-resolver/constants.ts": "2026-08-30",
  "worker/src/cron/depeg-resolver/storage-adapters.ts": "2026-08-30",
  "worker/src/cron/dews/contracts.ts": "2026-09-05",
  "worker/src/cron/dews/progress.ts": "2026-09-05",
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
  "worker/src/cron/sync-stablecoins/enrich-prices-primary-gt-probe.ts": "2026-09-05",
  "worker/src/cron/sync-stablecoins/enrich-prices-primary-hardening.ts": "2026-09-05",
  "worker/src/cron/sync-stablecoins/enrich-prices-primary-provider-collection.ts": "2026-09-05",
  "worker/src/cron/sync-stablecoins/enrich-prices-primary-shared.ts": "2026-09-05",
  "worker/src/cron/sync-stablecoins/enrich-prices-primary.ts": "2026-09-05",
  "worker/src/cron/sync-stablecoins/enrich-prices-progress.ts": "2026-09-05",
  "worker/src/cron/sync-stablecoins/enrich-prices-shared.ts": "2026-09-05",
  "worker/src/cron/sync-stablecoins/fallback-cache.ts": "2026-09-05",
  "worker/src/cron/sync-stablecoins/fallback-enrichment.ts": "2026-09-05",
  "worker/src/cron/sync-stablecoins/fallback-fx.ts": "2026-09-05",
  "worker/src/cron/sync-stablecoins/fallback-intake.ts": "2026-09-05",
  "worker/src/cron/sync-stablecoins/fallback-publish.ts": "2026-09-05",
  "worker/src/cron/sync-stablecoins/fallback.ts": "2026-09-05",
  "worker/src/cron/sync-stablecoins/intake.ts": "2026-09-05",
  "worker/src/cron/sync-stablecoins/main-publication.ts": "2026-09-05",
  "worker/src/cron/sync-stablecoins/metadata.ts": "2026-09-05",
  "worker/src/cron/sync-stablecoins/phase-helpers.ts": "2026-09-05",
  "worker/src/cron/sync-stablecoins/post-enrichment.ts": "2026-09-05",
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
  "worker/src/lib/address-price-providers/alchemy.ts": "2026-09-05",
  "worker/src/lib/address-price-providers/birdeye.ts": "2026-09-05",
  "worker/src/lib/address-price-providers/coingecko-onchain.ts": "2026-09-05",
  "worker/src/lib/address-price-providers/moralis.ts": "2026-09-05",
  "worker/src/lib/authoritative-price-sources.ts": "2026-09-05",
  "worker/src/lib/coingecko-simple-price.ts": "2026-09-05",
  "worker/src/lib/depeg-resolver-assessment-store.ts": "2026-08-30",
  "worker/src/lib/depeg-resolver-errata-store.ts": "2026-08-30",
  "worker/src/lib/depeg-resolver-methodology.ts": "2026-08-30",
  "worker/src/lib/depeg-resolver-repair-store.ts": "2026-08-30",
  "worker/src/lib/depeg-resolver-review-snapshot-cache.ts": "2026-08-30",
  "worker/src/lib/depeg-resolver-snapshot-cache.ts": "2026-08-30",
  "worker/src/lib/depeg-resolver-store-validators.ts": "2026-08-30",
  "worker/src/lib/dex-api-token-pricing.ts": "2026-09-05",
  "worker/src/lib/live-reserves-store.ts": "2026-09-05",
  "worker/src/lib/native-peg-implied-prices.ts": "2026-09-05",
  "worker/src/lib/pricing-provider-diagnostics.ts": "2026-09-05",
  "worker/src/lib/pricing-provider-lifecycle.ts": "2026-09-05",
  "worker/src/lib/psi-history-universe.ts": "2026-09-05",
  "worker/src/lib/psi-recompute.ts": "2026-09-05",
  "worker/src/lib/psi-replay.ts": "2026-09-05",
  "shared/lib/psi-contribution.ts": "2026-09-05",
  "shared/lib/psi-eligible-client.ts": "2026-09-05",
  "shared/lib/psi-view-model.ts": "2026-09-05",
  "shared/lib/redemption-backstop-scoring.ts": "2026-09-05",
};

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
