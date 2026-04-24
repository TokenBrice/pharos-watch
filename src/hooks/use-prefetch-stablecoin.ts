"use client";

import { useCallback, useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { depegEventsInfiniteQueryOptions } from "./use-depeg-events";
import { dexLiquidityHistoryQueryOptions, safetyScoreHistoryQueryOptions } from "./api-hooks";
import { supplyHistoryQueryOptions } from "./use-stablecoins";

const DEBOUNCE_MS = 100;

export function usePrefetchStablecoin() {
  const queryClient = useQueryClient();
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingCoinIdRef = useRef<string | null>(null);

  useEffect(() => {
    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
      }
    };
  }, []);

  return useCallback(
    (coinId: string) => {
      if (pendingCoinIdRef.current === coinId && timerRef.current) return;
      if (timerRef.current) clearTimeout(timerRef.current);
      pendingCoinIdRef.current = coinId;
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        pendingCoinIdRef.current = null;
        void queryClient.prefetchQuery(supplyHistoryQueryOptions(coinId));
        void queryClient.prefetchInfiniteQuery(depegEventsInfiniteQueryOptions(coinId));
        void queryClient.prefetchQuery(dexLiquidityHistoryQueryOptions(coinId, 90));
        void queryClient.prefetchQuery(safetyScoreHistoryQueryOptions(coinId, 3650));
      }, DEBOUNCE_MS);
    },
    [queryClient]
  );
}
