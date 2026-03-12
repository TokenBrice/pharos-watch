"use client";

import { API_PATHS } from "@shared/lib/api-endpoints";
import {
  StablecoinListResponseSchema,
  SupplyHistoryResponseSchema,
  type StablecoinListResponse,
  type SupplyHistoryPoint,
} from "@shared/types";
import { useApiQuery, CRON_15MIN, CRON_1H } from "./use-api-query";

export type { SupplyHistoryPoint } from "@shared/types";

export function useStablecoins() {
  return useApiQuery<StablecoinListResponse>(
    ["stablecoins"], API_PATHS.stablecoins(), CRON_15MIN,
    { schema: StablecoinListResponseSchema },
  );
}

export function useSupplyHistory(id: string, days = 1825) {
  const query = useApiQuery<SupplyHistoryPoint[]>(
    ["supply-history", id, days],
    API_PATHS.supplyHistory(id, days),
    CRON_1H,
    {
      enabled: !!id,
      schema: SupplyHistoryResponseSchema,
    },
  );

  return {
    data: query.data ?? [],
    isLoading: query.isLoading,
    isError: query.isError,
    error: query.error,
    refetch: query.refetch,
    dataUpdatedAt: query.dataUpdatedAt,
  };
}
