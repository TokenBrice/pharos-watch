"use client";

import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { API_PATHS } from "@shared/lib/api-endpoints";
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
  type YieldHistoryPoint,
  type YieldRankingsResponse,
} from "@shared/types";
import {
  createApiQueryFn,
  createStaticQueryOptions,
  useApiQuery,
  useApiQueryWithMeta,
} from "./use-api-query";
import { CRON_1H, CRON_1MIN, CRON_15MIN, CRON_24H, CRON_30MIN } from "@/lib/cron-intervals";

export type { StabilityContributor };

export function useBluechipRatings() {
  return useApiQuery<BluechipRatingsMap | null>(["bluechip-ratings"], API_PATHS.bluechipRatings(), CRON_24H);
}

export function useDailyDigest() {
  return useApiQuery<DailyDigestResponse>(["daily-digest"], API_PATHS.dailyDigest(), CRON_24H);
}

export function useDexLiquidity() {
  return useApiQueryWithMeta<DexLiquidityMap>(
    ["dex-liquidity"],
    API_PATHS.dexLiquidity(),
    CRON_30MIN,
    { schema: DexLiquidityMapSchema },
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
  return useApiQuery<DigestArchiveResponse>(["digest-archive"], API_PATHS.digestArchive(), CRON_24H);
}

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
    { schema: PegSummaryResponseSchema },
  );
}

export function useReportCards() {
  return useApiQuery<ReportCardsResponse>(
    ["report-cards"],
    API_PATHS.reportCards(),
    CRON_15MIN,
    { schema: ReportCardsResponseSchema },
  );
}

export function useRedemptionBackstops() {
  return useApiQuery<RedemptionBackstopsResponse>(
    ["redemption-backstops"],
    API_PATHS.redemptionBackstops(),
    CRON_1H,
    { schema: RedemptionBackstopsResponseSchema },
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
  return useApiQuery<StabilityIndexResponse>(
    ["stability-index"],
    API_PATHS.stabilityIndex(),
    CRON_30MIN,
    { schema: StabilityIndexResponseSchema },
  );
}

export function useStabilityIndexDetail() {
  return useApiQuery<StabilityIndexResponse>(
    ["stability-index-detail"],
    API_PATHS.stabilityIndex(true),
    CRON_30MIN,
    { schema: StabilityIndexResponseSchema },
  );
}

export function useUsdsStatus() {
  return useApiQuery<UsdsStatusResponse | null>(["usds-status"], API_PATHS.usdsStatus(), CRON_15MIN);
}

export function useYieldHistory(stablecoinId: string, days = 90) {
  return useApiQueryWithMeta<YieldHistoryPoint[]>(
    ["yield-history", stablecoinId, days],
    API_PATHS.yieldHistory(stablecoinId, days),
    CRON_30MIN,
    { metaMaxAgeSec: 1800 },
  );
}

export function useYieldRankings() {
  return useApiQueryWithMeta<YieldRankingsResponse>(
    ["yield-rankings"],
    API_PATHS.yieldRankings(),
    CRON_30MIN,
    { metaMaxAgeSec: 1800, schema: YieldRankingsResponseSchema },
  );
}

export function useStressSignals() {
  return useApiQueryWithMeta<StressSignalsAllResponse>(
    ["stress-signals"],
    API_PATHS.stressSignals(),
    CRON_30MIN,
    { schema: StressSignalsAllResponseSchema },
  );
}

export function useStressSignalDetail(stablecoinId: string, days = 30) {
  return useApiQueryWithMeta<StressSignalDetailResponse>(
    ["stress-signals", stablecoinId, days],
    API_PATHS.stressSignals(stablecoinId, days),
    CRON_30MIN,
    { enabled: !!stablecoinId, schema: StressSignalDetailResponseSchema },
  );
}
