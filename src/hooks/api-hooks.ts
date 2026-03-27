"use client";

import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { API_PATHS } from "@shared/lib/api-endpoints";
import { API_FRESHNESS_MAX_AGE_SEC } from "@shared/lib/api-freshness";
import {
  DexLiquidityMapSchema,
  HealthResponseSchema,
  PegSummaryResponseSchema,
  ReportCardsResponseSchema,
  RedemptionBackstopsResponseSchema,
  SafetyScoreHistoryResponseSchema,
  StabilityIndexResponseSchema,
  StressSignalsAllResponseSchema,
  StressSignalDetailResponseSchema,
  YieldHistoryResponseSchema,
  YieldRankingsResponseSchema,
  type BluechipRatingsMap,
  type DailyDigestResponse,
  type DexLiquidityHistoryPoint,
  type DexLiquidityMap,
  type DigestArchiveResponse,
  type DigestSnapshotResponse,
  type HealthResponse,
  type PegSummaryResponse,
  type ReportCardsResponse,
  type RedemptionBackstopsResponse,
  type SafetyScoreHistoryResponse,
  type StabilityContributor,
  type StabilityIndexResponse,
  type StablecoinChartPoint,
  type StressSignalsAllResponse,
  type StressSignalDetailResponse,
  type UsdsStatusResponse,
  type YieldHistoryResponse,
  type YieldRankingsResponse,
} from "@shared/types";
import {
  createApiQueryFn,
  createStaticQueryOptions,
  useApiQuery,
  useApiQueryWithMeta,
} from "./use-api-query";
import { CRON_1H, CRON_1MIN, CRON_15MIN, CRON_24H, CRON_30MIN, CRON_YIELD } from "@/lib/cron-intervals";

const YIELD_META_MAX_AGE_SEC = CRON_YIELD / 1000;

export type { StabilityContributor };

export function useBluechipRatings() {
  return useApiQueryWithMeta<BluechipRatingsMap | null>(
    ["bluechip-ratings"],
    API_PATHS.bluechipRatings(),
    CRON_24H,
    { metaMaxAgeSec: API_FRESHNESS_MAX_AGE_SEC.bluechip },
  );
}

export function useDailyDigest() {
  return useApiQuery<DailyDigestResponse>(["daily-digest"], API_PATHS.dailyDigest(), CRON_24H);
}

export function useDexLiquidity() {
  return useApiQueryWithMeta<DexLiquidityMap>(
    ["dex-liquidity"],
    API_PATHS.dexLiquidity(),
    CRON_30MIN,
    {
      schema: DexLiquidityMapSchema,
      metaMaxAgeSec: API_FRESHNESS_MAX_AGE_SEC.dexLiquidity,
    },
  );
}

export function useDexLiquidityHistory(stablecoinId: string, days = 90) {
  return useApiQuery<DexLiquidityHistoryPoint[]>(
    ["dex-liquidity-history", stablecoinId, days],
    API_PATHS.dexLiquidityHistory(stablecoinId, days),
    CRON_1H,
  );
}

export function useDigestArchive() {
  return useApiQueryWithMeta<DigestArchiveResponse>(
    ["digest-archive"],
    API_PATHS.digestArchive(),
    CRON_24H,
    { metaMaxAgeSec: API_FRESHNESS_MAX_AGE_SEC.digestArchive },
  );
}

// Digest snapshots are immutable by date — static cache, no polling needed
export function useDigestSnapshot(date: string): UseQueryResult<DigestSnapshotResponse, Error> {
  return useQuery<DigestSnapshotResponse, Error>(
    createStaticQueryOptions(
      ["digest-snapshot", date],
      createApiQueryFn<DigestSnapshotResponse>(API_PATHS.digestSnapshot(date)),
      { enabled: !!date, retry: 1 },
    ),
  );
}

export function useHealth(): UseQueryResult<HealthResponse, Error> {
  return useApiQuery<HealthResponse>(
    ["health"],
    API_PATHS.health(),
    CRON_1MIN,
    { retry: 1, schema: HealthResponseSchema },
  );
}

export function usePegSummary() {
  return useApiQueryWithMeta<PegSummaryResponse>(
    ["peg-summary"],
    API_PATHS.pegSummary(),
    CRON_15MIN,
    {
      schema: PegSummaryResponseSchema,
      metaMaxAgeSec: API_FRESHNESS_MAX_AGE_SEC.pegSummary,
    },
  );
}

export function useReportCards() {
  return useApiQueryWithMeta<ReportCardsResponse>(
    ["report-cards"],
    API_PATHS.reportCards(),
    CRON_15MIN,
    {
      schema: ReportCardsResponseSchema,
      metaMaxAgeSec: API_FRESHNESS_MAX_AGE_SEC.reportCards,
    },
  );
}

export function useRedemptionBackstops() {
  return useApiQueryWithMeta<RedemptionBackstopsResponse>(
    ["redemption-backstops"],
    API_PATHS.redemptionBackstops(),
    CRON_1H,
    {
      schema: RedemptionBackstopsResponseSchema,
      metaMaxAgeSec: API_FRESHNESS_MAX_AGE_SEC.redemptionBackstops,
    },
  );
}

export function useSafetyScoreHistory(stablecoinId: string, days = 3650) {
  return useApiQuery<SafetyScoreHistoryResponse>(
    ["safety-score-history", stablecoinId, days],
    API_PATHS.safetyScoreHistory(stablecoinId, days),
    CRON_24H,
    {
      enabled: !!stablecoinId,
      schema: SafetyScoreHistoryResponseSchema,
    },
  );
}

export function useStablecoinCharts() {
  return useApiQuery<StablecoinChartPoint[]>(["stablecoin-charts"], API_PATHS.stablecoinCharts(), CRON_1H);
}

export function useStabilityIndex() {
  return useApiQueryWithMeta<StabilityIndexResponse>(
    ["stability-index"],
    API_PATHS.stabilityIndex(),
    CRON_30MIN,
    {
      schema: StabilityIndexResponseSchema,
      metaMaxAgeSec: API_FRESHNESS_MAX_AGE_SEC.stabilityIndex,
    },
  );
}

export function useStabilityIndexDetail() {
  return useApiQueryWithMeta<StabilityIndexResponse>(
    ["stability-index-detail"],
    API_PATHS.stabilityIndex(true),
    CRON_30MIN,
    {
      schema: StabilityIndexResponseSchema,
      metaMaxAgeSec: API_FRESHNESS_MAX_AGE_SEC.stabilityIndex,
    },
  );
}

export function useUsdsStatus() {
  return useApiQuery<UsdsStatusResponse | null>(["usds-status"], API_PATHS.usdsStatus(), CRON_15MIN);
}

export function useYieldHistory(
  stablecoinId: string,
  options?: {
    days?: number;
    mode?: "best" | "source";
    sourceKey?: string | null;
    enabled?: boolean;
  },
) {
  const days = options?.days ?? 90;
  const mode = options?.sourceKey ? "source" : (options?.mode ?? "best");
  const sourceKey = options?.sourceKey ?? null;
  return useApiQueryWithMeta<YieldHistoryResponse>(
    ["yield-history", stablecoinId, days, mode, sourceKey],
    API_PATHS.yieldHistory(stablecoinId, days, mode, sourceKey ?? undefined),
    CRON_YIELD,
    { metaMaxAgeSec: YIELD_META_MAX_AGE_SEC, enabled: options?.enabled ?? !!stablecoinId, schema: YieldHistoryResponseSchema },
  );
}

export function useYieldRankings() {
  return useApiQueryWithMeta<YieldRankingsResponse>(
    ["yield-rankings"],
    API_PATHS.yieldRankings(),
    CRON_YIELD,
    { metaMaxAgeSec: YIELD_META_MAX_AGE_SEC, schema: YieldRankingsResponseSchema },
  );
}

export function useStressSignals() {
  return useApiQueryWithMeta<StressSignalsAllResponse>(
    ["stress-signals"],
    API_PATHS.stressSignals(),
    CRON_30MIN,
    {
      schema: StressSignalsAllResponseSchema,
      metaMaxAgeSec: API_FRESHNESS_MAX_AGE_SEC.stressSignals,
    },
  );
}

export function useStressSignalDetail(stablecoinId: string, days = 30) {
  return useApiQueryWithMeta<StressSignalDetailResponse>(
    ["stress-signals", stablecoinId, days],
    API_PATHS.stressSignals(stablecoinId, days),
    CRON_30MIN,
    {
      enabled: !!stablecoinId,
      schema: StressSignalDetailResponseSchema,
      metaMaxAgeSec: API_FRESHNESS_MAX_AGE_SEC.stressSignals,
    },
  );
}
