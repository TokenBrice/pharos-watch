"use client";

import { useCallback, useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { dexLiquidityHistoryQueryOptions } from "./api-hooks";
import { supplyHistoryQueryOptions } from "./use-stablecoins";

const DEBOUNCE_MS = 100;

export function usePrefetchStablecoin() {
  const queryClient = useQueryClient();
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingCoinIdRef = useRef<string | null>(null);

  useEffect(() => {
    return () => {
      const timer = timerRef.current;
      if (timer) {
        clearTimeout(timer);
        timerRef.current = null;
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
        // Prefetch only the queries the detail page fires on first paint
        // (view-model supply history + eager DexLiquidityCard), with matching
        // query keys. Safety-score history (10y) and depeg events live behind
        // below-fold LazySections and fetch on scroll instead.
        void queryClient.prefetchQuery(supplyHistoryQueryOptions(coinId));
        void queryClient.prefetchQuery(dexLiquidityHistoryQueryOptions(coinId, 90));
      }, DEBOUNCE_MS);
    },
    [queryClient]
  );
}
