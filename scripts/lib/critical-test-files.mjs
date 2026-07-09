import { CRITICAL_FILES } from "./critical-coverage.mjs";

export const CRITICAL_TEST_FILES = [
  "src/lib/__tests__/api-fetch-contracts.test.ts",
  "src/lib/__tests__/critical-invariants.test.ts",
  "worker/src/__tests__/index.scheduled.test.ts",
  "worker/src/lib/__tests__/api-utils.test.ts",
  "worker/src/lib/__tests__/api-pagination.test.ts",
  "worker/src/lib/__tests__/api-keys.test.ts",
  "worker/src/handlers/http/__tests__/gates.test.ts",
  "worker/src/lib/__tests__/alerts.test.ts",
  "worker/src/lib/__tests__/auth.test.ts",
  "worker/src/api/__tests__/telegram-webhook-auth.test.ts",
  "worker/src/api/__tests__/telegram-webhook-auth-lifecycle.test.ts",
  "worker/src/api/__tests__/telegram-webhook-rate-limits-commands.test.ts",
  "worker/src/api/__tests__/telegram-webhook-setup-access.test.ts",
  "worker/src/api/__tests__/telegram-webhook-subscriptions-settings.test.ts",
  "worker/src/api/__tests__/telegram-webhook-callback-confirmations.test.ts",
  "worker/src/api/__tests__/telegram-webhook-callbacks.test.ts",
  "worker/src/api/__tests__/telegram-mini-app.test.ts",
  "worker/src/lib/__tests__/telegram-mini-app-auth.test.ts",
  "worker/src/lib/__tests__/evm-rpc.test.ts",
  "worker/src/lib/__tests__/safety-scores.test.ts",
  "worker/src/lib/__tests__/safety-score-golden.test.ts",
  "worker/src/lib/__tests__/stablecoins-cache.test.ts",
  "worker/src/lib/__tests__/price-divergence.test.ts",
  "worker/src/lib/__tests__/price-consensus.test.ts",
  "worker/src/lib/__tests__/price-validation.test.ts",
  "worker/src/lib/__tests__/price-publish-policy.test.ts",
  "worker/src/lib/__tests__/pricing-circuit-map.test.ts",
  "worker/src/lib/__tests__/pricing-source-freshness.test.ts",
  "worker/src/lib/__tests__/primary-price-collector.test.ts",
  "worker/src/lib/__tests__/geckoterminal-price-probe.test.ts",
  "worker/src/lib/__tests__/address-price-providers.test.ts",
  "worker/src/lib/__tests__/authoritative-price-sources.test.ts",
  "worker/src/lib/__tests__/live-reserves-store.test.ts",
  "worker/src/api/__tests__/cache-passthrough.test.ts",
  "worker/src/api/__tests__/discovery.test.ts",
  "worker/src/api/__tests__/health.test.ts",
  "worker/src/api/__tests__/peg-summary.test.ts",
  "worker/src/api/__tests__/report-cards.test.ts",
  "worker/src/api/__tests__/blacklist.test.ts",
  "worker/src/api/__tests__/blacklist-summary.test.ts",
  "worker/src/lib/__tests__/blacklist-contracts.test.ts",
  "worker/src/cron/__tests__/sync-blacklist.test.ts",
  "shared/lib/__tests__/report-card-blacklist-authority.test.ts",
  "shared/lib/__tests__/blacklist-active-records.test.ts",
  "worker/src/api/__tests__/dex-liquidity.test.ts",
  "worker/src/api/__tests__/yield-rankings.test.ts",
  "worker/src/api/__tests__/yield-history.test.ts",
  "worker/src/api/__tests__/stress-signals.test.ts",
  "worker/src/lib/__tests__/stress-signals-current-rows.test.ts",
  "worker/src/api/__tests__/mint-burn-flows.test.ts",
  "worker/src/api/__tests__/stablecoin-detail.test.ts",
  "worker/src/api/__tests__/stablecoin-reserves.test.ts",
  "worker/src/api/__tests__/status-snapshots-core.test.ts",
  "worker/src/api/__tests__/status-data-loaders.test.ts",
  "worker/src/api/__tests__/status-cron-telegram.test.ts",
  "worker/src/api/__tests__/status-data-quality-state.test.ts",
  "worker/src/cron/__tests__/daily-digest.test.ts",
  "worker/src/cron/__tests__/sync-stablecoins.test.ts",
  "worker/src/cron/__tests__/enrich-prices-validation.test.ts",
  "worker/src/cron/__tests__/enrich-prices-fallback-contract-dex.test.ts",
  "worker/src/cron/__tests__/enrich-prices-fallback-cmc-jupiter.test.ts",
  "worker/src/cron/__tests__/enrich-prices-primary-consensus.test.ts",
  "worker/src/cron/__tests__/enrich-prices-pool-challenges.test.ts",
  "worker/src/cron/__tests__/detect-depegs.test.ts",
  "worker/src/cron/__tests__/confirm-pending-depegs.test.ts",
  "worker/src/lib/dews/__tests__/signal-families.test.ts",
  "worker/src/cron/__tests__/compute-dews.test.ts",
  "worker/src/cron/__tests__/compute-depeg-resolver.test.ts",
  "worker/src/cron/__tests__/depeg-resolver-public-projection.test.ts",
  "worker/src/cron/__tests__/compute-depeg-resolver-review.test.ts",
  "worker/src/lib/__tests__/depeg-resolver-ddrv2-store.test.ts",
  "worker/src/cron/depeg-detection/__tests__/decision-engine.test.ts",
  "worker/src/cron/depeg-detection/__tests__/repair.test.ts",
  "worker/src/cron/depeg-resolver/__tests__/incident-resolution.test.ts",
  "worker/src/cron/depeg-resolver/__tests__/incident-state.test.ts",
  "worker/src/cron/dews/__tests__/source-state-legacy.test.ts",
  "worker/src/cron/__tests__/sync-live-reserves.test.ts",
  "worker/src/cron/__tests__/sync-live-reserves-run-state.test.ts",
  "worker/src/cron/reserve-adapters/__tests__/cap-vault.test.ts",
  "worker/src/cron/__tests__/sync-yield-data-publication-cache.test.ts",
  "worker/src/cron/__tests__/sync-yield-data-discovery-coverage.test.ts",
  "worker/src/cron/__tests__/sync-yield-data-rates-history.test.ts",
  "worker/src/cron/__tests__/sync-yield-data-lending-degradation.test.ts",
  "worker/src/cron/__tests__/sync-dex-liquidity.test.ts",
  "shared/lib/selector/__tests__/snapshot.test.ts",
  "functions/__tests__/middleware.test.ts",
  "functions/__tests__/selector-snapshot.test.ts",
  "functions/__tests__/admin-host-gate.test.ts",
  "functions/__tests__/admin-api-host-gate.test.ts",
  "functions/__tests__/ops-admin-proxy.test.ts",
  "functions/__tests__/site-data-proxy.test.ts",
];

export const CRITICAL_CONTRACT_TEST_FILES = [
  "src/lib/__tests__/api-fetch-contracts.test.ts",
  "src/lib/__tests__/api-endpoints.test.ts",
  "worker/src/api/__tests__/router-contract.test.ts",
  "worker/src/api/__tests__/cache-passthrough.test.ts",
  "worker/src/api/__tests__/peg-summary.test.ts",
  "worker/src/api/__tests__/report-cards.test.ts",
  "worker/src/api/__tests__/stability-index.test.ts",
  "worker/src/api/__tests__/dex-liquidity.test.ts",
  "worker/src/api/__tests__/yield-rankings.test.ts",
  "worker/src/api/__tests__/yield-history.test.ts",
  "worker/src/api/__tests__/stress-signals.test.ts",
  "worker/src/api/__tests__/mint-burn-flows.test.ts",
  "worker/src/api/__tests__/stablecoin-reserves.test.ts",
  "worker/src/api/__tests__/depeg-events.test.ts",
  "worker/src/api/__tests__/events.test.ts",
];

export function buildCriticalContractTestArgs(extraArgs = []) {
  return ["run", ...CRITICAL_CONTRACT_TEST_FILES, ...extraArgs];
}

// coverage.include values are globs; enrolled paths like
// functions/api/admin/[[path]].ts would otherwise parse as character classes
// and silently drop those files from lcov (surfacing as MISSING failures).
export function escapeCoverageIncludeGlob(file) {
  return file.replace(/[\\[\](){}*?!+@|]/g, "\\$&");
}

export function buildCriticalCoverageArgs(extraArgs = []) {
  return [
    "run",
    "--coverage",
    "--coverage.thresholds.lines=0",
    // Scope v8 remapping to the enrolled critical source. Per-file numbers for
    // the enrolled files are unchanged, but the reporter stops remapping the
    // rest of the loaded module graph — the heaviest part of this invocation.
    ...CRITICAL_FILES.map((file) => `--coverage.include=${escapeCoverageIncludeGlob(file)}`),
    ...CRITICAL_TEST_FILES,
    ...extraArgs,
  ];
}

// CLI --exclude flags are silently ignored by project-scoped include lists
// (vitest test.projects), so the critical-file exclusion is applied inside
// vitest.config.ts when this env flag is set by run-noncritical-tests.mjs.
export const NONCRITICAL_EXCLUDE_CRITICAL_TESTS_ENV = "VITEST_EXCLUDE_CRITICAL_TESTS";

export function buildNoncriticalTestArgs(extraArgs = []) {
  return ["run", ...extraArgs];
}
