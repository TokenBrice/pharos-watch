import { STABLECOIN_HISTORY_QUERY_CONTRACTS } from "../api-query-history";

const DEX_HISTORY_DEFAULT_DAYS = STABLECOIN_HISTORY_QUERY_CONTRACTS.dexLiquidity.defaultDays;
const YIELD_HISTORY_DEFAULT_DAYS = STABLECOIN_HISTORY_QUERY_CONTRACTS.yield.defaultDays;
const SAFETY_HISTORY_PATH_DAYS = STABLECOIN_HISTORY_QUERY_CONTRACTS.safetyScore.maxDays;

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
  depegEvents: (params?: {
    stablecoinId?: string;
    limit?: number;
    offset?: number;
    active?: boolean;
    cursor?: string;
    includeTotal?: boolean;
    includePending?: boolean;
  }) =>
    buildQueryPath("/api/depeg-events", {
      stablecoin: params?.stablecoinId,
      limit: params?.limit,
      offset: params?.offset,
      active: params?.active,
      cursor: params?.cursor,
      includeTotal: params?.includeTotal,
      includePending: params?.includePending,
    }),
  events: (params?: Record<string, QueryParamValue>) => buildQueryPath("/api/events", params),
  usdsStatus: () => "/api/usds-status",
  bluechipRatings: () => "/api/bluechip-ratings",
  dexLiquidity: () => "/api/dex-liquidity",
  dexLiquidityHistoryBase: () => "/api/dex-liquidity-history",
  dexLiquidityHistory: (stablecoinId: string, days: number = DEX_HISTORY_DEFAULT_DAYS) =>
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
  snapshotsIndex: () => "/api/snapshots/index",
  snapshotDay: (date: string) => `/api/snapshots/${date}.json`,
  snapshotCoin: (date: string, stablecoinId: string) =>
    `/api/snapshot/${date}/stablecoin/${encodeURIComponent(stablecoinId)}`,
  yieldRankings: () => "/api/yield-rankings",
  yieldRankingsSummary: () => buildQueryPath("/api/yield-rankings", { projection: "summary" }),
  yieldAdapterManifest: () => "/api/yield-adapter-manifest",
  yieldHistoryBase: () => "/api/yield-history",
  yieldHistory: (stablecoinId: string, days: number = YIELD_HISTORY_DEFAULT_DAYS, mode?: string, sourceKey?: string) =>
    buildQueryPath("/api/yield-history", {
      stablecoin: stablecoinId,
      days,
      mode,
      sourceKey,
    }),
  yieldHistoryProbe: (stablecoinId: string) => buildQueryPath("/api/yield-history", { stablecoin: stablecoinId }),
  safetyScoreHistoryBase: () => "/api/safety-score-history",
  safetyScoreHistory: (stablecoinId: string, days: number = SAFETY_HISTORY_PATH_DAYS) =>
    buildQueryPath("/api/safety-score-history", { stablecoin: stablecoinId, days }),
  safetyScoreHistoryProbe: (stablecoinId: string) =>
    buildQueryPath("/api/safety-score-history", { stablecoin: stablecoinId }),
  safetyScoreHistoryV2Base: () => "/api/safety-score-history-v2",
  safetyScoreHistoryV2: (stablecoinId: string, days: number = SAFETY_HISTORY_PATH_DAYS) =>
    buildQueryPath("/api/safety-score-history-v2", { stablecoin: stablecoinId, days }),
  stabilityIndex: (detail = false) => buildQueryPath("/api/stability-index", detail ? { detail: true } : undefined),
  reportCardsV9: () => "/api/report-cards/v9",
  depegResolver: () => "/api/depeg-resolver",
  depegResolverReview: () => "/api/depeg-resolver-review",
  redemptionBackstops: () => "/api/redemption-backstops",
  mintBurnFlowsBase: () => "/api/mint-burn-flows",
  mintBurnFlows: (params?: Record<string, QueryParamValue>) => buildQueryPath("/api/mint-burn-flows", params),
  mintBurnEventsBase: () => "/api/mint-burn-events",
  mintBurnEvents: (params?: Record<string, QueryParamValue>) => buildQueryPath("/api/mint-burn-events", params),
  stressSignalsBase: () => "/api/stress-signals",
  stressSignals: (stablecoinId?: string, days?: number) =>
    buildQueryPath("/api/stress-signals", { stablecoin: stablecoinId, days }),
  chains: () => "/api/chains",
  chainsDetail: (chainId: string) => buildQueryPath("/api/chains", { chain: chainId }),
  nonUsdShareBase: () => "/api/non-usd-share",
  nonUsdShare: (days?: number) => buildQueryPath("/api/non-usd-share", days ? { days } : undefined),
  ogStablecoin: (stablecoinId: string) => `/api/og/stablecoin/${encodeURIComponent(stablecoinId)}`,
  ogChain: (chainId: string) => `/api/og/chain/${chainId}`,
  ogDepeg: () => "/api/og/depeg",
  ogSafetyScores: () => "/api/og/safety-scores",
  ogStabilityIndex: () => "/api/og/stability-index",
  publicStatusHistory: (params?: { limit?: number; window?: "24h" | "7d" | "30d" }) =>
    buildQueryPath("/api/public-status-history", {
      limit: params?.limit,
      window: params?.window,
    }),
  telegramPulse: () => "/api/telegram-pulse",
  telegramMiniAppSession: () => "/api/telegram-mini-app/session",
  telegramMiniAppMutation: () => "/api/telegram-mini-app/mutate",
  feedback: () => "/api/feedback",
  apiKeyRequests: () => "/api/api-key-requests",
  apiKeyRequestVerify: () => "/api/api-key-requests/verify",
  apiKeyRequestsAdmin: () => "/api/api-key-requests-admin",
  apiKeyRequestAdminReject: (requestId: string) =>
    `/api/api-key-requests-admin/${encodeURIComponent(requestId)}/reject`,
  apiKeyRequestAdminReleaseClaim: (requestId: string) =>
    `/api/api-key-requests-admin/${encodeURIComponent(requestId)}/release-claim`,
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
  credentialLifecycleSummary: () => "/api/api-keys/lifecycle-summary",
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
  backfillYieldHistory: () => "/api/backfill-yield-history",
  backfillStabilityIndex: (params?: { startDay?: string; endDay?: string }) =>
    buildQueryPath("/api/backfill-stability-index", {
      startDay: params?.startDay,
      endDay: params?.endDay,
    }),
  backfillMintBurnPrices: () => "/api/backfill-mint-burn-prices",
  backfillMintBurn: () => "/api/backfill-mint-burn",
  backfillTape: () => "/api/backfill-tape",
  reclassifyAtomicRoundtrips: () => "/api/reclassify-atomic-roundtrips",
  auditDepegHistoryBase: () => "/api/audit-depeg-history",
  auditDepegHistoryDryRun: () => buildQueryPath("/api/audit-depeg-history", { "dry-run": true }),
  backfillDews: () => "/api/backfill-dews",
  adminTelegramBroadcast: () => "/api/admin-telegram-broadcast",
} as const;
