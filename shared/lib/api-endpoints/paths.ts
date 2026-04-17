type QueryParamValue = string | number | boolean | null | undefined;

export function buildQueryPath(path: string, params?: Record<string, QueryParamValue>): string {
  if (!params) return path;
  const searchParams = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value == null) continue;
    searchParams.set(key, String(value));
  }
  const query = searchParams.toString();
  return query ? `${path}?${query}` : path;
}

export const API_PATHS = {
  stablecoins: () => "/api/stablecoins",
  stablecoinDetail: (stablecoinId: string) => `/api/stablecoin/${encodeURIComponent(stablecoinId)}`,
  stablecoinSummary: (stablecoinId: string) => `/api/stablecoin-summary/${encodeURIComponent(stablecoinId)}`,
  stablecoinReserves: (stablecoinId: string) => `/api/stablecoin-reserves/${encodeURIComponent(stablecoinId)}`,
  stablecoinCharts: () => "/api/stablecoin-charts",
  pegSummary: () => "/api/peg-summary",
  health: () => "/api/health",
  blacklist: (params?: Record<string, QueryParamValue>) => buildQueryPath("/api/blacklist", params),
  blacklistSummary: () => "/api/blacklist-summary",
  depegEvents: (params?: { stablecoinId?: string; limit?: number; offset?: number }) =>
    buildQueryPath("/api/depeg-events", {
      stablecoin: params?.stablecoinId,
      limit: params?.limit,
      offset: params?.offset,
    }),
  usdsStatus: () => "/api/usds-status",
  bluechipRatings: () => "/api/bluechip-ratings",
  dexLiquidity: () => "/api/dex-liquidity",
  dexLiquidityHistoryBase: () => "/api/dex-liquidity-history",
  dexLiquidityHistory: (stablecoinId: string, days = 90) =>
    buildQueryPath("/api/dex-liquidity-history", { stablecoin: stablecoinId, days }),
  dexLiquidityHistoryProbe: (stablecoinId: string) =>
    buildQueryPath("/api/dex-liquidity-history", { stablecoin: stablecoinId }),
  supplyHistoryBase: () => "/api/supply-history",
  supplyHistory: (stablecoinId: string, days?: number) =>
    buildQueryPath("/api/supply-history", { stablecoin: stablecoinId, days }),
  dailyDigest: () => "/api/daily-digest",
  digestArchive: () => "/api/digest-archive",
  digestSnapshotBase: () => "/api/digest-snapshot",
  digestSnapshot: (date: string) => buildQueryPath("/api/digest-snapshot", { date }),
  yieldRankings: () => "/api/yield-rankings",
  yieldHistoryBase: () => "/api/yield-history",
  yieldHistory: (stablecoinId: string, days = 90, mode?: string, sourceKey?: string) =>
    buildQueryPath("/api/yield-history", {
      stablecoin: stablecoinId,
      days,
      mode,
      sourceKey,
    }),
  yieldHistoryProbe: (stablecoinId: string) =>
    buildQueryPath("/api/yield-history", { stablecoin: stablecoinId }),
  safetyScoreHistoryBase: () => "/api/safety-score-history",
  safetyScoreHistory: (stablecoinId: string, days = 3650) =>
    buildQueryPath("/api/safety-score-history", { stablecoin: stablecoinId, days }),
  safetyScoreHistoryProbe: (stablecoinId: string) =>
    buildQueryPath("/api/safety-score-history", { stablecoin: stablecoinId }),
  stabilityIndex: (detail = false) => buildQueryPath("/api/stability-index", detail ? { detail: true } : undefined),
  reportCards: () => "/api/report-cards",
  redemptionBackstops: () => "/api/redemption-backstops",
  mintBurnFlowsBase: () => "/api/mint-burn-flows",
  mintBurnFlows: (params?: Record<string, QueryParamValue>) => buildQueryPath("/api/mint-burn-flows", params),
  mintBurnEventsBase: () => "/api/mint-burn-events",
  mintBurnEvents: (params?: Record<string, QueryParamValue>) => buildQueryPath("/api/mint-burn-events", params),
  stressSignalsBase: () => "/api/stress-signals",
  stressSignals: (stablecoinId?: string, days?: number) =>
    buildQueryPath("/api/stress-signals", { stablecoin: stablecoinId, days }),
  chains: () => "/api/chains",
  nonUsdShareBase: () => "/api/non-usd-share",
  nonUsdShare: (days?: number) => buildQueryPath("/api/non-usd-share", days ? { days } : undefined),
  publicStatusHistory: (params?: { limit?: number; window?: "24h" | "7d" | "30d" }) =>
    buildQueryPath("/api/public-status-history", {
      limit: params?.limit,
      window: params?.window,
    }),
  telegramPulse: () => "/api/telegram-pulse",
  feedback: () => "/api/feedback",
  telegramWebhook: () => "/api/telegram-webhook",
  status: () => "/api/status",
  statusHistoryBase: () => "/api/status-history",
  statusHistory: (params?: { limit?: number }) => buildQueryPath("/api/status-history", { limit: params?.limit }),
  requestSourceStatsBase: () => "/api/request-source-stats",
  requestSourceStats: (params?: { hours?: number; bucketSec?: number; routeLimit?: number; apiKeyLimit?: number }) =>
    buildQueryPath("/api/request-source-stats", {
      hours: params?.hours,
      bucketSec: params?.bucketSec,
      routeLimit: params?.routeLimit,
      apiKeyLimit: params?.apiKeyLimit,
    }),
  apiKeys: () => "/api/api-keys",
  apiKeyAuditLog: () => "/api/api-keys/audit-log",
  apiKeyUpdate: (id: number) => `/api/api-keys/${id}/update`,
  apiKeyDeactivate: (id: number) => `/api/api-keys/${id}/deactivate`,
  apiKeyRotate: (id: number) => `/api/api-keys/${id}/rotate`,
  triggerDigest: () => "/api/trigger-digest",
  adminActionLog: () => "/api/admin-action-log",
  resetBlacklistSync: () => "/api/reset-blacklist-sync",
  debugSyncState: () => "/api/debug-sync-state",
  remediateBlacklistAmountGaps: () => "/api/remediate-blacklist-amount-gaps",
  backfillBlacklistCurrentBalances: () => "/api/backfill-blacklist-current-balances",
  backfillDepegs: () => "/api/backfill-depegs",
  backfillSupplyHistory: () => "/api/backfill-supply-history",
  backfillCgPrices: () => "/api/backfill-cg-prices",
  backfillStabilityIndex: () => "/api/backfill-stability-index",
  backfillMintBurnPrices: () => "/api/backfill-mint-burn-prices",
  backfillMintBurn: () => "/api/backfill-mint-burn",
  reclassifyAtomicRoundtrips: () => "/api/reclassify-atomic-roundtrips",
  auditDepegHistoryBase: () => "/api/audit-depeg-history",
  auditDepegHistoryDryRun: () => buildQueryPath("/api/audit-depeg-history", { "dry-run": true }),
  backfillDews: () => "/api/backfill-dews",
  discoveryCandidates: () => "/api/discovery-candidates",
  resetCronLease: (params?: { job?: string }) =>
    buildQueryPath("/api/reset-cron-lease", { job: params?.job }),
  resetCircuitBreaker: (params?: { circuit?: string }) =>
    buildQueryPath("/api/reset-circuit-breaker", { circuit: params?.circuit }),
  killCronInFlight: (params?: { job?: string; leaseOwner?: string }) =>
    buildQueryPath("/api/kill-cron-in-flight", { job: params?.job, leaseOwner: params?.leaseOwner }),
  bulkDismissDiscoveryCandidates: (params?: { all?: boolean; ids?: string }) =>
    buildQueryPath("/api/bulk-dismiss-discovery-candidates", { all: params?.all, ids: params?.ids }),
  statusProbeHistory: (params?: { path?: string; days?: number }) =>
    buildQueryPath("/api/status-probe-history", { path: params?.path, days: params?.days }),
} as const;
