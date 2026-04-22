"use client";

import { useCallback, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { depegEventsInfiniteQueryOptions } from "./use-depeg-events";
import { dexLiquidityHistoryQueryOptions, safetyScoreHistoryQueryOptions } from "./api-hooks";
import { supplyHistoryQueryOptions } from "./use-stablecoins";

const DEBOUNCE_MS = 100;

export function usePrefetchStablecoin() {
  const queryClient = useQueryClient();
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  return useCallback(
    (coinId: string) => {
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => {
        void queryClient.prefetchQuery(supplyHistoryQueryOptions(coinId));
        void queryClient.prefetchInfiniteQuery(depegEventsInfiniteQueryOptions(coinId));
        void queryClient.prefetchQuery(dexLiquidityHistoryQueryOptions(coinId, 90));
        void queryClient.prefetchQuery(safetyScoreHistoryQueryOptions(coinId, 3650));
      }, DEBOUNCE_MS);
    },
    [queryClient]
  );
}
