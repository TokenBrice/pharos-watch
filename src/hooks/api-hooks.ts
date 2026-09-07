"use client";

import { useQuery, type UseQueryOptions, type UseQueryResult } from "@tanstack/react-query";
import {
  type DexLiquidityHistoryPoint,
  type DigestSnapshotResponse,
  type ReportCardsV9CurrentResponse,
  type SafetyScoreHistoryResponse,
  type SafetyScoreHistoryV2Response,
  type StabilityContributor,
  type StressSignalDetailResponse,
  type YieldAdapterManifestResponse,
  type YieldHistoryResponse,
} from "@shared/types";
import type { YieldRankingsSummaryResponse } from "@shared/types/yield-summary";
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
import { FRONTEND_API_QUERY_DESCRIPTORS } from "@/lib/api-query-descriptors";
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
type RegisteredApiQueryResult<T, TMode extends FrontendApiQueryDescriptor<T>["responseMode"]> =
  TMode extends "meta" ? ApiQueryWithMetaResult<T> : UseQueryResult<T, Error>;

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

function bindRegisteredApiQuery<T, TMode extends FrontendApiQueryDescriptor<T>["responseMode"]>(
  descriptor: FrontendApiQueryDescriptor<T, TMode>,
): () => RegisteredApiQueryResult<T, TMode>;
function bindRegisteredApiQuery<T, TMode extends FrontendApiQueryDescriptor<T>["responseMode"]>(
  descriptor: FrontendApiQueryDescriptor<T, TMode>,
  defaults: QueryControlOverrides | undefined,
): (overrides?: QueryControlOverrides) => RegisteredApiQueryResult<T, TMode>;
function bindRegisteredApiQuery<T, TMode extends FrontendApiQueryDescriptor<T>["responseMode"]>(
  descriptor: FrontendApiQueryDescriptor<T, TMode>,
  defaults?: QueryControlOverrides,
) {
  const useQueryDescriptor = useRegisteredApiQuery as (
    descriptor: FrontendApiQueryDescriptor<T, TMode>,
    overrides?: QueryControlOverrides,
  ) => RegisteredApiQueryResult<T, TMode>;
  return function useBoundRegisteredApiQuery(overrides?: QueryControlOverrides) {
    return useQueryDescriptor(descriptor, { ...defaults, ...overrides });
  };
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

export const useBluechipRatings = bindRegisteredApiQuery(FRONTEND_API_QUERY_DESCRIPTORS.bluechipRatings);
export const useDailyDigest = bindRegisteredApiQuery(FRONTEND_API_QUERY_DESCRIPTORS.dailyDigest);
export const useDexLiquidity = bindRegisteredApiQuery(FRONTEND_API_QUERY_DESCRIPTORS.dexLiquidity, undefined);

export function useDexLiquidityHistory(stablecoinId: string, days?: number) {
  return useQuery<DexLiquidityHistoryPoint[], Error>(dexLiquidityHistoryQueryOptions(stablecoinId, days));
}

export function dexLiquidityHistoryQueryOptions(stablecoinId: string, days?: number) {
  return asPlainQueryOptions<DexLiquidityHistoryPoint[]>(
    createRegisteredApiPollingQueryOptions<DexLiquidityHistoryPoint[]>(
      FRONTEND_API_QUERY_DESCRIPTORS.dexLiquidityHistory(stablecoinId, days),
    ),
  );
}

export const useDigestArchive = bindRegisteredApiQuery(FRONTEND_API_QUERY_DESCRIPTORS.digestArchive);

// Digest snapshots are immutable by date — static cache, no polling needed
export function useDigestSnapshot(date: string): UseQueryResult<DigestSnapshotResponse, Error> {
  return useQuery<DigestSnapshotResponse, Error>(
    createRegisteredStaticQueryOptions(FRONTEND_API_QUERY_DESCRIPTORS.digestSnapshot(date), {
      enabled: !!date,
      retry: 1,
    }),
  );
}
// Public health is a 15-minute cron snapshot; the registered descriptor derives
// the 15-minute staleTime and 30-minute refetchInterval for this hook.
export const useHealth = bindRegisteredApiQuery(FRONTEND_API_QUERY_DESCRIPTORS.health, { retry: 1 });
export const usePegSummary = bindRegisteredApiQuery(FRONTEND_API_QUERY_DESCRIPTORS.pegSummary);

/** Canonical V9 query. Its model-specific key and disabled previous-data
 * retention prevent an earlier-policy payload from surviving a refetch. */
export function useReportCardsV9(overrides?: V9QueryControlOverrides) {
  return useRegisteredApiQuery<ReportCardsV9CurrentResponse>(FRONTEND_API_QUERY_DESCRIPTORS.reportCardsV9, {
    ...overrides,
    keepPreviousData: false,
  });
}

export const useDepegResolver = bindRegisteredApiQuery(FRONTEND_API_QUERY_DESCRIPTORS.depegResolver, {
  keepPreviousData: true,
});
export const useDepegResolverReview = bindRegisteredApiQuery(FRONTEND_API_QUERY_DESCRIPTORS.depegResolverReview, {
  keepPreviousData: true,
});
export const useRedemptionBackstops = bindRegisteredApiQuery(FRONTEND_API_QUERY_DESCRIPTORS.redemptionBackstops);

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

export const useStablecoinCharts = bindRegisteredApiQuery(FRONTEND_API_QUERY_DESCRIPTORS.stablecoinCharts);
export const useNonUsdShare = bindRegisteredApiQuery(FRONTEND_API_QUERY_DESCRIPTORS.nonUsdShare);
export const useStabilityIndex = bindRegisteredApiQuery(FRONTEND_API_QUERY_DESCRIPTORS.stabilityIndex);
export const useStabilityIndexDetail = bindRegisteredApiQuery(FRONTEND_API_QUERY_DESCRIPTORS.stabilityIndexDetail);

// Public /pharoswatchbot telemetry contract. Keep rendered fields and
// docs/telegram-alerts.md in sync with worker/src/api/telegram-pulse.ts.
export const useTelegramPulse = bindRegisteredApiQuery(FRONTEND_API_QUERY_DESCRIPTORS.telegramPulse);
export const useUsdsStatus = bindRegisteredApiQuery(FRONTEND_API_QUERY_DESCRIPTORS.usdsStatus);

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

export const useYieldRankings = bindRegisteredApiQuery(FRONTEND_API_QUERY_DESCRIPTORS.yieldRankings, undefined);

export const useYieldRankingsSummary: () => ApiQueryWithMetaResult<YieldRankingsSummaryResponse> =
  bindRegisteredApiQuery(FRONTEND_API_QUERY_DESCRIPTORS.yieldRankingsSummary, {
    keepPreviousData: true,
  });

export function useYieldAdapterManifest() {
  return useQuery<YieldAdapterManifestResponse, Error>(
    createRegisteredStaticQueryOptions(FRONTEND_API_QUERY_DESCRIPTORS.yieldAdapterManifest, { retry: 1 }),
  );
}

export const useStressSignals = bindRegisteredApiQuery(FRONTEND_API_QUERY_DESCRIPTORS.stressSignals, undefined);

export function useStressSignalDetail(stablecoinId: string, days?: number) {
  return useRegisteredApiQuery<StressSignalDetailResponse>(
    FRONTEND_API_QUERY_DESCRIPTORS.stressSignalDetail(stablecoinId, days),
    { enabled: !!stablecoinId },
  );
}
