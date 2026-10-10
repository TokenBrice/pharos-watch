"use client";

import { useQuery } from "@tanstack/react-query";
import type { StablecoinListResponse, SupplyHistoryPoint } from "@shared/types";
import {
  asMetaQueryOptions,
  createRegisteredApiPollingQueryOptions,
  useRegisteredApiQuery,
  type QueryControlOverrides,
} from "./api-hooks";
import { unwrapApiQueryWithMetaResult } from "./use-api-query";
import { FRONTEND_API_QUERY_DESCRIPTORS } from "@/lib/api-query-descriptors";

export type { SupplyHistoryPoint } from "@shared/types";

export function useStablecoins() {
  return useRegisteredApiQuery<StablecoinListResponse>(
    FRONTEND_API_QUERY_DESCRIPTORS.stablecoins,
    {
      // M1: home + screener filter/sort the cached list client-side, so keep the
      // prior payload visible during the 15-min background refetch instead of
      // wiping to a skeleton. The RefreshingBar signals the in-flight refresh.
      keepPreviousData: true,
    },
  );
}

export function supplyHistoryQueryOptions(
  id: string,
  days?: number,
  overrides?: QueryControlOverrides,
) {
  return asMetaQueryOptions<SupplyHistoryPoint[]>(
    createRegisteredApiPollingQueryOptions<SupplyHistoryPoint[]>(
      FRONTEND_API_QUERY_DESCRIPTORS.supplyHistory(id, days),
      { enabled: !!id, ...overrides },
    ),
  );
}

export function useSupplyHistory(
  id: string,
  days?: number,
  overrides?: QueryControlOverrides,
) {
  const query = unwrapApiQueryWithMetaResult(useQuery(supplyHistoryQueryOptions(id, days, overrides)));
  const meta = query.meta ?? {
    updatedAt: null,
    ageSeconds: null,
    status: "unknown" as const,
    reason: "producer-timestamp-unavailable",
  };

  return {
    data: query.data ?? [],
    isLoading: query.isLoading,
    isError: query.isError,
    error: query.error,
    refetch: query.refetch,
    dataUpdatedAt: query.dataUpdatedAt,
    meta,
  };
}
