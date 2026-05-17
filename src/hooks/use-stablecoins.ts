"use client";

import { useQuery } from "@tanstack/react-query";
import type { StablecoinListResponse, SupplyHistoryPoint } from "@shared/types";
import { createApiPollingQueryOptions, useApiQueryWithMeta } from "./use-api-query";
import { FRONTEND_API_QUERY_REGISTRY } from "@/lib/api-query-registry";

export type { SupplyHistoryPoint } from "@shared/types";

export function useStablecoins() {
  const descriptor = FRONTEND_API_QUERY_REGISTRY.stablecoins;
  return useApiQueryWithMeta<StablecoinListResponse>(
    descriptor.queryKey,
    descriptor.path,
    descriptor.producerIntervalMs,
    {
      schema: descriptor.schema,
      metaMaxAgeSec: descriptor.metaMaxAgeSec,
    },
  );
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
