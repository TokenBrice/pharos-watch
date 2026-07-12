"use client";

import { useQuery, type UseQueryOptions, type UseQueryResult } from "@tanstack/react-query";
import {
  type BluechipRatingsMap,
  type DailyDigestResponse,
  type DdrResponse,
  type DdrrResponse,
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
  type YieldAdapterManifestResponse,
  type YieldHistoryResponse,
  type YieldRankingsResponse,
} from "@shared/types";
import type { YieldRankingsSummaryResponse } from "@shared/types/yield-summary";
import {
  createApiQueryFn,
  createApiPollingQueryOptions,
  createApiPollingQueryOptionsWithMeta,
  createStaticQueryOptions,
  type ApiQueryWithMetaResult,
  type PollingQueryControlOptions,
  unwrapApiQueryWithMetaResult,
  useApiQueryWithMeta,
} from "./use-api-query";
import {
  FRONTEND_API_QUERY_DESCRIPTORS,
  type NonUsdSharePoint as RegistryNonUsdSharePoint,
} from "@/lib/api-query-descriptors";
import type { FrontendApiQueryDescriptor, FrontendStaticApiQueryDescriptor } from "@/lib/api-query-contract";
import type { ApiMeta } from "@/lib/api";

export type { StabilityContributor };
export type { NonUsdSharePoint } from "@/lib/api-query-descriptors";

export type QueryControlOverrides = PollingQueryControlOptions;

type QueryWithMetaEnvelope<T> = { data: T; meta: ApiMeta | null };

export function useRegisteredApiQuery<T>(
  descriptor: FrontendApiQueryDescriptor<T, "plain">,
  overrides?: QueryControlOverrides,
): UseQueryResult<T, Error>;
export function useRegisteredApiQuery<T>(
  descriptor: FrontendApiQueryDescriptor<T, "meta">,
  overrides?: QueryControlOverrides,
): ApiQueryWithMetaResult<T>;
export function useRegisteredApiQuery<T>(
  descriptor: FrontendApiQueryDescriptor<T>,
  overrides?: QueryControlOverrides,
): UseQueryResult<T, Error> | ApiQueryWithMetaResult<T> {
  const options = createRegisteredApiPollingQueryOptions(descriptor, overrides);
  const query = useQuery<unknown, Error>(options as UseQueryOptions<unknown, Error, unknown, readonly unknown[]>);
  return descriptor.responseMode === "meta"
    ? unwrapApiQueryWithMetaResult(query as UseQueryResult<QueryWithMetaEnvelope<T>, Error>)
    : (query as UseQueryResult<T, Error>);
}

export function useRegisteredApiQueryWithMeta<T>(
  descriptor: FrontendApiQueryDescriptor<T, "meta">,
  overrides?: QueryControlOverrides,
) {
  return useApiQueryWithMeta<T>(descriptor.queryKey, descriptor.path, descriptor.producerIntervalMs, {
    ...overrides,
    schema: descriptor.schema,
    metaMaxAgeSec: descriptor.metaMaxAgeSec,
  });
}

export function createRegisteredApiPollingQueryOptions<T>(
  descriptor: FrontendApiQueryDescriptor<T, "plain">,
  overrides?: QueryControlOverrides,
): UseQueryOptions<T, Error, T, readonly unknown[]>;
export function createRegisteredApiPollingQueryOptions<T>(
  descriptor: FrontendApiQueryDescriptor<T, "meta">,
  overrides?: QueryControlOverrides,
): UseQueryOptions<QueryWithMetaEnvelope<T>, Error, QueryWithMetaEnvelope<T>, readonly unknown[]>;
export function createRegisteredApiPollingQueryOptions<T>(
  descriptor: FrontendApiQueryDescriptor<T>,
  overrides?: QueryControlOverrides,
):
  | UseQueryOptions<T, Error, T, readonly unknown[]>
  | UseQueryOptions<QueryWithMetaEnvelope<T>, Error, QueryWithMetaEnvelope<T>, readonly unknown[]>;
export function createRegisteredApiPollingQueryOptions<T>(
  descriptor: FrontendApiQueryDescriptor<T>,
  overrides?: QueryControlOverrides,
):
  | UseQueryOptions<T, Error, T, readonly unknown[]>
  | UseQueryOptions<QueryWithMetaEnvelope<T>, Error, QueryWithMetaEnvelope<T>, readonly unknown[]> {
  return descriptor.responseMode === "meta"
    ? createApiPollingQueryOptionsWithMeta<T>(descriptor.queryKey, descriptor.path, descriptor.producerIntervalMs, {
        ...overrides,
        schema: descriptor.schema,
        metaMaxAgeSec: descriptor.metaMaxAgeSec,
      })
    : createApiPollingQueryOptions<T>(descriptor.queryKey, descriptor.path, descriptor.producerIntervalMs, {
        ...overrides,
        schema: descriptor.schema,
      });
}

export function createRegisteredApiPollingQueryOptionsWithMeta<T>(
  descriptor: FrontendApiQueryDescriptor<T, "meta">,
  overrides?: QueryControlOverrides,
) {
  return createRegisteredApiPollingQueryOptions(descriptor, overrides);
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
  return createStaticQueryOptions(descriptor.queryKey, createApiQueryFn<T>(descriptor.path, descriptor.schema), opts);
}

export function useBluechipRatings() {
  return useRegisteredApiQuery<BluechipRatingsMap | null>(FRONTEND_API_QUERY_DESCRIPTORS.bluechipRatings);
}

export function useDailyDigest() {
  return useRegisteredApiQuery<DailyDigestResponse>(FRONTEND_API_QUERY_DESCRIPTORS.dailyDigest);
}

export function useDexLiquidity(overrides?: QueryControlOverrides) {
  return useRegisteredApiQuery<DexLiquidityMap>(FRONTEND_API_QUERY_DESCRIPTORS.dexLiquidity, overrides);
}

export function useDexLiquidityHistory(stablecoinId: string, days = 90) {
  return useQuery<DexLiquidityHistoryPoint[], Error>(dexLiquidityHistoryQueryOptions(stablecoinId, days));
}

export function dexLiquidityHistoryQueryOptions(stablecoinId: string, days = 90) {
  return createRegisteredApiPollingQueryOptions<DexLiquidityHistoryPoint[]>(
    FRONTEND_API_QUERY_DESCRIPTORS.dexLiquidityHistory(stablecoinId, days),
  );
}

export function useDigestArchive() {
  return useRegisteredApiQuery<DigestArchiveResponse>(FRONTEND_API_QUERY_DESCRIPTORS.digestArchive);
}

// Digest snapshots are immutable by date — static cache, no polling needed
export function useDigestSnapshot(date: string): UseQueryResult<DigestSnapshotResponse, Error> {
  return useQuery<DigestSnapshotResponse, Error>(
    createRegisteredStaticQueryOptions(FRONTEND_API_QUERY_DESCRIPTORS.digestSnapshot(date), {
      enabled: !!date,
      retry: 1,
    }),
  );
}

export function useHealth(overrides?: QueryControlOverrides): UseQueryResult<HealthResponse, Error> {
  return useRegisteredApiQuery<HealthResponse>(FRONTEND_API_QUERY_DESCRIPTORS.health, { retry: 1, ...overrides });
}

export function usePegSummary() {
  return useRegisteredApiQuery<PegSummaryResponse>(FRONTEND_API_QUERY_DESCRIPTORS.pegSummary);
}

export function useReportCards(overrides?: QueryControlOverrides) {
  return useRegisteredApiQuery<ReportCardsResponse>(
    FRONTEND_API_QUERY_DESCRIPTORS.reportCards,
    // M1: report cards back the safety-grade filters on home + screener.
    // Keep the prior cards visible across background refetches so toggling a
    // grade filter doesn't blank the table. Callers can still override.
    { keepPreviousData: true, ...overrides },
  );
}

export function useDepegResolver(overrides?: QueryControlOverrides) {
  return useRegisteredApiQuery<DdrResponse>(FRONTEND_API_QUERY_DESCRIPTORS.depegResolver, {
    keepPreviousData: true,
    ...overrides,
  });
}

export function useDepegResolverReview(overrides?: QueryControlOverrides) {
  return useRegisteredApiQuery<DdrrResponse>(FRONTEND_API_QUERY_DESCRIPTORS.depegResolverReview, {
    keepPreviousData: true,
    ...overrides,
  });
}

export function useRedemptionBackstops() {
  return useRegisteredApiQuery<RedemptionBackstopsResponse>(FRONTEND_API_QUERY_DESCRIPTORS.redemptionBackstops);
}

export function useSafetyScoreHistory(stablecoinId: string, days = 3650) {
  return useRegisteredApiQuery<SafetyScoreHistoryResponse>(
    FRONTEND_API_QUERY_DESCRIPTORS.safetyScoreHistory(stablecoinId, days),
    { enabled: !!stablecoinId },
  );
}

export function useStablecoinCharts() {
  return useRegisteredApiQuery<StablecoinChartPoint[]>(FRONTEND_API_QUERY_DESCRIPTORS.stablecoinCharts);
}

export function useNonUsdShare() {
  return useRegisteredApiQuery<RegistryNonUsdSharePoint[]>(FRONTEND_API_QUERY_DESCRIPTORS.nonUsdShare);
}

export function useStabilityIndex() {
  return useRegisteredApiQuery<StabilityIndexResponse>(FRONTEND_API_QUERY_DESCRIPTORS.stabilityIndex);
}

export function useStabilityIndexDetail() {
  return useRegisteredApiQuery<StabilityIndexResponse>(FRONTEND_API_QUERY_DESCRIPTORS.stabilityIndexDetail);
}

export function useUsdsStatus() {
  return useRegisteredApiQuery<UsdsStatusResponse | null>(FRONTEND_API_QUERY_DESCRIPTORS.usdsStatus);
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
  return useRegisteredApiQuery<YieldHistoryResponse>(
    FRONTEND_API_QUERY_DESCRIPTORS.yieldHistory(stablecoinId, days, mode, sourceKey),
    { enabled: options?.enabled ?? !!stablecoinId },
  );
}

export function useYieldRankings(overrides?: QueryControlOverrides) {
  return useRegisteredApiQuery<YieldRankingsResponse>(FRONTEND_API_QUERY_DESCRIPTORS.yieldRankings, overrides);
}

export function useYieldRankingsSummary() {
  return useRegisteredApiQuery<YieldRankingsSummaryResponse>(FRONTEND_API_QUERY_DESCRIPTORS.yieldRankingsSummary);
}

export function useYieldAdapterManifest() {
  return useRegisteredApiQuery<YieldAdapterManifestResponse>(FRONTEND_API_QUERY_DESCRIPTORS.yieldAdapterManifest);
}

export function useStressSignals(overrides?: QueryControlOverrides) {
  return useRegisteredApiQuery<StressSignalsAllResponse>(FRONTEND_API_QUERY_DESCRIPTORS.stressSignals, overrides);
}

export function useStressSignalDetail(stablecoinId: string, days = 30) {
  return useRegisteredApiQuery<StressSignalDetailResponse>(
    FRONTEND_API_QUERY_DESCRIPTORS.stressSignalDetail(stablecoinId, days),
    { enabled: !!stablecoinId },
  );
}
