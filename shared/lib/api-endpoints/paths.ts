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
  dexLiquidityHistory: (stablecoinId: string, days = 90) =>
    buildQueryPath("/api/dex-liquidity-history", { stablecoin: stablecoinId, days }),
  supplyHistory: (stablecoinId: string, days?: number) =>
    buildQueryPath("/api/supply-history", { stablecoin: stablecoinId, days }),
  dailyDigest: () => "/api/daily-digest",
  digestArchive: () => "/api/digest-archive",
  digestSnapshot: (date: string) => buildQueryPath("/api/digest-snapshot", { date }),
  yieldRankings: () => "/api/yield-rankings",
  yieldHistory: (stablecoinId: string, days = 90, mode?: string, sourceKey?: string) =>
    buildQueryPath("/api/yield-history", {
      stablecoin: stablecoinId,
      days,
      mode,
      sourceKey,
    }),
  safetyScoreHistory: (stablecoinId: string, days = 3650) =>
    buildQueryPath("/api/safety-score-history", { stablecoin: stablecoinId, days }),
  stabilityIndex: (detail = false) => buildQueryPath("/api/stability-index", detail ? { detail: true } : undefined),
  reportCards: () => "/api/report-cards",
  redemptionBackstops: () => "/api/redemption-backstops",
  treasuryStableExposure: () => "/api/treasury-stable-exposure",
  mintBurnFlows: (params?: Record<string, QueryParamValue>) => buildQueryPath("/api/mint-burn-flows", params),
  mintBurnEvents: (params?: Record<string, QueryParamValue>) => buildQueryPath("/api/mint-burn-events", params),
  stressSignals: (stablecoinId?: string, days?: number) =>
    buildQueryPath("/api/stress-signals", { stablecoin: stablecoinId, days }),
  chains: () => "/api/chains",
  nonUsdShare: (days?: number) => buildQueryPath("/api/non-usd-share", days ? { days } : undefined),
  publicStatusHistory: (params?: { limit?: number; window?: "24h" | "7d" | "30d" }) =>
    buildQueryPath("/api/public-status-history", {
      limit: params?.limit,
      window: params?.window,
    }),
  telegramPulse: () => "/api/telegram-pulse",
  requestSourceStats: (params?: { hours?: number; bucketSec?: number; routeLimit?: number }) =>
    buildQueryPath("/api/request-source-stats", {
      hours: params?.hours,
      bucketSec: params?.bucketSec,
      routeLimit: params?.routeLimit,
    }),
  apiKeys: () => "/api/api-keys",
  apiKeyUpdate: (id: number) => `/api/api-keys/${id}/update`,
  apiKeyDeactivate: (id: number) => `/api/api-keys/${id}/deactivate`,
  apiKeyRotate: (id: number) => `/api/api-keys/${id}/rotate`,
} as const;
