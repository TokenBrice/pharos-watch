"use client";

import { useQuery } from "@tanstack/react-query";
import type { StablecoinListResponse, SupplyHistoryPoint } from "@shared/types";
import {
  asPlainQueryOptions,
  createRegisteredApiPollingQueryOptions,
  useRegisteredApiQuery,
  type QueryControlOverrides,
} from "./api-hooks";
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
  days = 1825,
  overrides?: QueryControlOverrides,
) {
  return asPlainQueryOptions<SupplyHistoryPoint[]>(
    createRegisteredApiPollingQueryOptions<SupplyHistoryPoint[]>(
      FRONTEND_API_QUERY_DESCRIPTORS.supplyHistory(id, days),
      { enabled: !!id, ...overrides },
    ),
  );
}

export function useSupplyHistory(
  id: string,
  days = 1825,
  overrides?: QueryControlOverrides,
) {
  const query = useQuery<SupplyHistoryPoint[], Error>(supplyHistoryQueryOptions(id, days, overrides));

  return {
    data: query.data ?? [],
    isLoading: query.isLoading,
    isError: query.isError,
    error: query.error,
    refetch: query.refetch,
    dataUpdatedAt: query.dataUpdatedAt,
  };
}
