"use client";

import { useCallback, useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { supplyHistoryQueryOptions } from "./use-stablecoins";

const PREFETCH_DEBOUNCE_MS = 100;

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
        // Prefetch only the query the detail page fires on first paint
        // (view-model supply history), with a matching query key. DEX
        // liquidity, safety-score history (10y), and depeg events live
        // behind below-fold LazySections and fetch on scroll instead.
        void queryClient.prefetchQuery(supplyHistoryQueryOptions(coinId));
      }, PREFETCH_DEBOUNCE_MS);
    },
    [queryClient]
  );
}
