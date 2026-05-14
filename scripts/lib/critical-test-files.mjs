export const CRITICAL_TEST_FILES = [
  "src/lib/__tests__/api-fetch-contracts.test.ts",
  "src/lib/__tests__/critical-invariants.test.ts",
  "worker/src/__tests__/index.scheduled.test.ts",
  "worker/src/lib/__tests__/api-utils.test.ts",
  "worker/src/lib/__tests__/api-keys.test.ts",
  "worker/src/handlers/http/__tests__/gates.test.ts",
  "worker/src/lib/__tests__/alerts.test.ts",
  "worker/src/lib/__tests__/auth.test.ts",
  "worker/src/api/__tests__/telegram-webhook-auth.test.ts",
  "worker/src/api/__tests__/telegram-webhook.test.ts",
  "worker/src/api/__tests__/telegram-webhook-callbacks.test.ts",
  "worker/src/api/__tests__/telegram-mini-app.test.ts",
  "worker/src/lib/__tests__/telegram-mini-app-auth.test.ts",
  "worker/src/lib/__tests__/evm-rpc.test.ts",
  "worker/src/lib/__tests__/safety-scores.test.ts",
  "worker/src/lib/__tests__/stablecoins-cache.test.ts",
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
  "worker/src/api/__tests__/mint-burn-flows.test.ts",
  "worker/src/api/__tests__/stablecoin-detail.test.ts",
  "worker/src/api/__tests__/status.test.ts",
  "worker/src/cron/__tests__/daily-digest.test.ts",
  "worker/src/cron/__tests__/sync-stablecoins.test.ts",
  "worker/src/cron/__tests__/sync-yield-data.test.ts",
  "worker/src/cron/__tests__/sync-dex-liquidity.test.ts",
  "functions/__tests__/ops-admin-proxy.test.ts",
  "functions/__tests__/site-data-proxy.test.ts",
];

export function buildCriticalCoverageArgs(extraArgs = []) {
  return [
    "run",
    "--coverage",
    "--coverage.thresholds.lines=0",
    ...CRITICAL_TEST_FILES,
    ...extraArgs,
  ];
}

export function buildNoncriticalTestArgs(extraArgs = []) {
  return [
    "run",
    ...CRITICAL_TEST_FILES.flatMap((file) => ["--exclude", file]),
    ...extraArgs,
  ];
}
