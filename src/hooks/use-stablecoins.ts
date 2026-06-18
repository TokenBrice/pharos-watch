"use client";

import { useQuery } from "@tanstack/react-query";
import type { StablecoinListResponse, SupplyHistoryPoint } from "@shared/types";
import { createRegisteredApiPollingQueryOptions, useRegisteredApiQueryWithMeta } from "./api-hooks";
import { FRONTEND_API_QUERY_REGISTRY } from "@/lib/api-query-registry";

export type { SupplyHistoryPoint } from "@shared/types";

export function useStablecoins() {
  return useRegisteredApiQueryWithMeta<StablecoinListResponse>(
    FRONTEND_API_QUERY_REGISTRY.stablecoins,
    {
      // M1: home + screener filter/sort the cached list client-side, so keep the
      // prior payload visible during the 15-min background refetch instead of
      // wiping to a skeleton. The RefreshingBar signals the in-flight refresh.
      keepPreviousData: true,
    },
  );
}

export function supplyHistoryQueryOptions(id: string, days = 1825) {
  return createRegisteredApiPollingQueryOptions<SupplyHistoryPoint[]>(
    FRONTEND_API_QUERY_REGISTRY.supplyHistory(id, days),
    { enabled: !!id },
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
