"use client";

import { useQuery } from "@tanstack/react-query";
import { API_PATHS } from "@shared/lib/api-endpoints";
import {
  StablecoinListResponseSchema,
  SupplyHistoryResponseSchema,
  type StablecoinListResponse,
  type SupplyHistoryPoint,
} from "@shared/types";
import { API_FRESHNESS_MAX_AGE_SEC } from "@shared/lib/api-freshness";
import { createApiPollingQueryOptions, useApiQueryWithMeta } from "./use-api-query";
import { CRON_15MIN, CRON_1H } from "@/lib/cron-intervals";

export type { SupplyHistoryPoint } from "@shared/types";

export function useStablecoins() {
  return useApiQueryWithMeta<StablecoinListResponse>(
    ["stablecoins"], API_PATHS.stablecoins(), CRON_15MIN,
    {
      schema: StablecoinListResponseSchema,
      metaMaxAgeSec: API_FRESHNESS_MAX_AGE_SEC.stablecoins,
    },
  );
}

export function supplyHistoryQueryOptions(id: string, days = 1825) {
  return createApiPollingQueryOptions<SupplyHistoryPoint[]>(
    ["supply-history", id, days],
    API_PATHS.supplyHistory(id, days),
    CRON_1H,
    {
      enabled: !!id,
      schema: SupplyHistoryResponseSchema,
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
