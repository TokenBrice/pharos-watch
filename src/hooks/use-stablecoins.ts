"use client";

import { useQuery } from "@tanstack/react-query";
import { API_PATHS } from "@shared/lib/api-endpoints";
import type { StablecoinListResponse, SupplyHistoryPoint } from "@shared/types";
import { StablecoinListResponseSchema } from "@shared/types/market";
import { API_FRESHNESS_MAX_AGE_SEC } from "@shared/lib/api-freshness";
import { createApiPollingQueryOptions, useApiQueryWithMeta } from "./use-api-query";
import { FRONTEND_API_QUERY_REGISTRY } from "@/lib/api-query-registry";
import { CRON_15MIN } from "@/lib/cron-intervals";

export type { SupplyHistoryPoint } from "@shared/types";

export function useStablecoins() {
  return useApiQueryWithMeta<StablecoinListResponse>(["stablecoins"], API_PATHS.stablecoins(), CRON_15MIN, {
    schema: StablecoinListResponseSchema,
    metaMaxAgeSec: API_FRESHNESS_MAX_AGE_SEC.stablecoins,
  });
}

export function supplyHistoryQueryOptions(id: string, days = 1825) {
  const descriptor = FRONTEND_API_QUERY_REGISTRY.supplyHistory(id, days);
  return createApiPollingQueryOptions<SupplyHistoryPoint[]>(
    descriptor.queryKey,
    descriptor.path,
    descriptor.producerIntervalMs,
    {
      enabled: !!id,
      schema: descriptor.schema,
    },
  );
}

export function useSupplyHistory(id: string, days = 1825) {
  const query = useQuery<SupplyHistoryPoint[], Error>(supplyHistoryQueryOptions(id, days));

  return {
    data: query.data ?? [],
    isLoading: query.isLoading,
    isError: query.isError,
    error: query.error,
    refetch: query.refetch,
    dataUpdatedAt: query.dataUpdatedAt,
  };
}
