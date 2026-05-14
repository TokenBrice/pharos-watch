"use client";

import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import {
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
import type { RecentEventsResponse } from "@shared/types/tape";
import {
  createApiQueryFn,
  createApiPollingQueryOptions,
  createApiPollingQueryOptionsWithMeta,
  createStaticQueryOptions,
  useApiQuery,
  useApiQueryWithMeta,
} from "./use-api-query";
import {
  FRONTEND_API_QUERY_REGISTRY,
  type FrontendApiQueryDescriptor,
  type FrontendStaticApiQueryDescriptor,
  type NonUsdSharePoint as RegistryNonUsdSharePoint,
} from "@/lib/api-query-registry";

export type { StabilityContributor };
export type { NonUsdSharePoint } from "@/lib/api-query-registry";

interface QueryControlOverrides {
  enabled?: boolean;
  retry?: number | boolean;
  retryDelay?: (attempt: number) => number;
}

function useRegisteredApiQuery<T>(
  descriptor: FrontendApiQueryDescriptor<T>,
  overrides?: QueryControlOverrides,
) {
  return useApiQuery<T>(
    descriptor.queryKey,
    descriptor.path,
    descriptor.producerIntervalMs,
    { ...overrides, schema: descriptor.schema },
  );
}

function useRegisteredApiQueryWithMeta<T>(
  descriptor: FrontendApiQueryDescriptor<T>,
  overrides?: QueryControlOverrides,
) {
  return useApiQueryWithMeta<T>(
    descriptor.queryKey,
    descriptor.path,
    descriptor.producerIntervalMs,
    { ...overrides, schema: descriptor.schema, metaMaxAgeSec: descriptor.metaMaxAgeSec },
  );
}

function createRegisteredApiPollingQueryOptions<T>(
  descriptor: FrontendApiQueryDescriptor<T>,
  overrides?: QueryControlOverrides,
) {
  return createApiPollingQueryOptions<T>(
    descriptor.queryKey,
    descriptor.path,
    descriptor.producerIntervalMs,
    { ...overrides, schema: descriptor.schema },
  );
}

function createRegisteredApiPollingQueryOptionsWithMeta<T>(
  descriptor: FrontendApiQueryDescriptor<T>,
  overrides?: QueryControlOverrides,
) {
  return createApiPollingQueryOptionsWithMeta<T>(
    descriptor.queryKey,
    descriptor.path,
    descriptor.producerIntervalMs,
    { ...overrides, schema: descriptor.schema, metaMaxAgeSec: descriptor.metaMaxAgeSec },
  );
}

function createRegisteredStaticQueryOptions<T>(
  descriptor: FrontendStaticApiQueryDescriptor<T>,
  opts?: {
    enabled?: boolean;
    retry?: number | boolean;
    retryDelay?: (attempt: number) => number;
    staleTime?: number;
  },
) {
  return createStaticQueryOptions(
    descriptor.queryKey,
    createApiQueryFn<T>(descriptor.path, descriptor.schema),
    opts,
  );
}

export function useBluechipRatings() {
  return useRegisteredApiQueryWithMeta<BluechipRatingsMap | null>(
    FRONTEND_API_QUERY_REGISTRY.bluechipRatings,
  );
}

export function useDailyDigest() {
  return useRegisteredApiQuery<DailyDigestResponse>(FRONTEND_API_QUERY_REGISTRY.dailyDigest);
}

export function useDexLiquidity(overrides?: QueryControlOverrides) {
  return useRegisteredApiQueryWithMeta<DexLiquidityMap>(
    FRONTEND_API_QUERY_REGISTRY.dexLiquidity,
    overrides,
  );
}

export function useDexLiquidityHistory(stablecoinId: string, days = 90) {
  return useQuery<DexLiquidityHistoryPoint[], Error>(
    dexLiquidityHistoryQueryOptions(stablecoinId, days),
  );
}

export function dexLiquidityHistoryQueryOptions(stablecoinId: string, days = 90) {
  return createRegisteredApiPollingQueryOptions<DexLiquidityHistoryPoint[]>(
    FRONTEND_API_QUERY_REGISTRY.dexLiquidityHistory(stablecoinId, days),
  );
}

export function useDigestArchive() {
  return useRegisteredApiQueryWithMeta<DigestArchiveResponse>(
    FRONTEND_API_QUERY_REGISTRY.digestArchive,
  );
}

// Digest snapshots are immutable by date — static cache, no polling needed
export function useDigestSnapshot(date: string): UseQueryResult<DigestSnapshotResponse, Error> {
  return useQuery<DigestSnapshotResponse, Error>(
    createRegisteredStaticQueryOptions(
      FRONTEND_API_QUERY_REGISTRY.digestSnapshot(date),
      { enabled: !!date, retry: 1 },
    ),
  );
}

export function useHealth(): UseQueryResult<HealthResponse, Error> {
  return useRegisteredApiQuery<HealthResponse>(
    FRONTEND_API_QUERY_REGISTRY.health,
    { retry: 1 },
  );
}

export function usePegSummary() {
  return useRegisteredApiQueryWithMeta<PegSummaryResponse>(FRONTEND_API_QUERY_REGISTRY.pegSummary);
}

export function useReportCards(overrides?: QueryControlOverrides) {
  return useRegisteredApiQueryWithMeta<ReportCardsResponse>(
    FRONTEND_API_QUERY_REGISTRY.reportCards,
    overrides,
  );
}

export function useRedemptionBackstops() {
  return useRegisteredApiQueryWithMeta<RedemptionBackstopsResponse>(
    FRONTEND_API_QUERY_REGISTRY.redemptionBackstops,
  );
}

export function useSafetyScoreHistory(stablecoinId: string, days = 3650) {
  return useRegisteredApiQueryWithMeta<SafetyScoreHistoryResponse>(
    FRONTEND_API_QUERY_REGISTRY.safetyScoreHistory(stablecoinId, days),
    { enabled: !!stablecoinId },
  );
}

export function safetyScoreHistoryQueryOptions(stablecoinId: string, days = 3650) {
  return createRegisteredApiPollingQueryOptionsWithMeta<SafetyScoreHistoryResponse>(
    FRONTEND_API_QUERY_REGISTRY.safetyScoreHistory(stablecoinId, days),
    { enabled: !!stablecoinId },
  );
}

export function useStablecoinCharts() {
  return useRegisteredApiQuery<StablecoinChartPoint[]>(
    FRONTEND_API_QUERY_REGISTRY.stablecoinCharts,
  );
}

export function useNonUsdShare() {
  return useRegisteredApiQuery<RegistryNonUsdSharePoint[]>(FRONTEND_API_QUERY_REGISTRY.nonUsdShare);
}

export function useStabilityIndex() {
  return useRegisteredApiQueryWithMeta<StabilityIndexResponse>(
    FRONTEND_API_QUERY_REGISTRY.stabilityIndex,
  );
}

export function useStabilityIndexDetail() {
  return useRegisteredApiQueryWithMeta<StabilityIndexResponse>(
    FRONTEND_API_QUERY_REGISTRY.stabilityIndexDetail,
  );
}

export function useUsdsStatus() {
  return useRegisteredApiQuery<UsdsStatusResponse | null>(FRONTEND_API_QUERY_REGISTRY.usdsStatus);
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
  return useRegisteredApiQueryWithMeta<YieldHistoryResponse>(
    FRONTEND_API_QUERY_REGISTRY.yieldHistory(stablecoinId, days, mode, sourceKey),
    { enabled: options?.enabled ?? !!stablecoinId },
  );
}

export function useYieldRankings() {
  return useRegisteredApiQueryWithMeta<YieldRankingsResponse>(
    FRONTEND_API_QUERY_REGISTRY.yieldRankings,
  );
}

export function useStressSignals(overrides?: QueryControlOverrides) {
  return useRegisteredApiQueryWithMeta<StressSignalsAllResponse>(
    FRONTEND_API_QUERY_REGISTRY.stressSignals,
    overrides,
  );
}

export function useStressSignalDetail(stablecoinId: string, days = 30) {
  return useRegisteredApiQueryWithMeta<StressSignalDetailResponse>(
    FRONTEND_API_QUERY_REGISTRY.stressSignalDetail(stablecoinId, days),
    { enabled: !!stablecoinId },
  );
}

export function useRecentEvents(limit = 20) {
  return useRegisteredApiQuery<RecentEventsResponse>(
    FRONTEND_API_QUERY_REGISTRY.recentEvents(limit),
  );
}
