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
  type ReportCardsV9CurrentResponse,
  type RedemptionBackstopsResponse,
  type SafetyScoreHistoryResponse,
  type SafetyScoreHistoryV2Response,
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
import type { TelegramPulse } from "@shared/types/status";
import {
  createApiQueryFn,
  createApiPollingQueryOptions,
  createApiPollingQueryOptionsWithMeta,
  createStaticQueryOptions,
  type ApiQueryOptions,
  type ApiQueryWithMetaResult,
  type PollingQueryControlOptions,
  unwrapApiQueryWithMetaResult,
} from "./use-api-query";
import {
  FRONTEND_API_QUERY_DESCRIPTORS,
  type NonUsdSharePoint as RegistryNonUsdSharePoint,
} from "@/lib/api-query-descriptors";
import type { FrontendApiQueryDescriptor, FrontendStaticApiQueryDescriptor } from "@/lib/api-query-contract";
import type { ApiMeta } from "@/lib/api";

export type { StabilityContributor };

export type QueryControlOverrides = PollingQueryControlOptions & Pick<ApiQueryOptions<unknown>, "fetchInit">;
export type V9QueryControlOverrides = Omit<QueryControlOverrides, "keepPreviousData">;

type QueryWithMetaEnvelope<T> = { data: T; meta: ApiMeta | null };

export type PlainApiQueryOptions<T> = UseQueryOptions<T, Error, T, readonly unknown[]>;
export type MetaApiQueryOptions<T> = UseQueryOptions<
  QueryWithMetaEnvelope<T>,
  Error,
  QueryWithMetaEnvelope<T>,
  readonly unknown[]
>;
type RegisteredApiQueryOptions<T> = PlainApiQueryOptions<T> | MetaApiQueryOptions<T>;

/**
 * Narrow the union returned by `createRegisteredApiPollingQueryOptions` for a
 * descriptor the caller statically knows the response mode of. The descriptor's
 * mode type argument is the proof; TypeScript cannot carry it through the
 * runtime branch inside the builder.
 */
export function asPlainQueryOptions<T>(options: RegisteredApiQueryOptions<T>): PlainApiQueryOptions<T> {
  return options as PlainApiQueryOptions<T>;
}

export function asMetaQueryOptions<T>(options: RegisteredApiQueryOptions<T>): MetaApiQueryOptions<T> {
  return options as MetaApiQueryOptions<T>;
}

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

/**
 * Returns the union of both response modes. Callers that know the descriptor is
 * `"plain"` narrow with `asPlainQueryOptions(...)`; `useRegisteredApiQuery`
 * keeps the descriptor-mode overloads so component call sites stay narrowed.
 */
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
  return asPlainQueryOptions<DexLiquidityHistoryPoint[]>(
    createRegisteredApiPollingQueryOptions<DexLiquidityHistoryPoint[]>(
      FRONTEND_API_QUERY_DESCRIPTORS.dexLiquidityHistory(stablecoinId, days),
    ),
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

/** Canonical V9 query. Its model-specific key and disabled previous-data
 * retention prevent an earlier-policy payload from surviving a refetch. */
export function useReportCardsV9(overrides?: V9QueryControlOverrides) {
  return useRegisteredApiQuery<ReportCardsV9CurrentResponse>(FRONTEND_API_QUERY_DESCRIPTORS.reportCardsV9, {
    ...overrides,
    keepPreviousData: false,
  });
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

export function useSafetyScoreHistoryV2(stablecoinId: string, days = 3650) {
  return useRegisteredApiQuery<SafetyScoreHistoryV2Response>(
    FRONTEND_API_QUERY_DESCRIPTORS.safetyScoreHistoryV2(stablecoinId, days),
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

// Public /pharoswatchbot telemetry contract. Keep rendered fields and
// docs/telegram-alerts.md in sync with worker/src/api/telegram-pulse.ts.
export function useTelegramPulse() {
  return useRegisteredApiQuery<TelegramPulse>(FRONTEND_API_QUERY_DESCRIPTORS.telegramPulse);
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
  return useRegisteredApiQuery<YieldRankingsSummaryResponse>(FRONTEND_API_QUERY_DESCRIPTORS.yieldRankingsSummary, {
    keepPreviousData: true,
  });
}

export function useYieldAdapterManifest() {
  return useQuery<YieldAdapterManifestResponse, Error>(
    createRegisteredStaticQueryOptions(FRONTEND_API_QUERY_DESCRIPTORS.yieldAdapterManifest, { retry: 1 }),
  );
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
