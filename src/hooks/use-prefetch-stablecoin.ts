"use client";

import { useCallback, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  createApiQueryFn,
  CRON_15MIN,
  CRON_1H,
  CRON_24H,
} from "@/hooks/use-api-query";

const DEBOUNCE_MS = 100;

export function usePrefetchStablecoin() {
  const queryClient = useQueryClient();
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  return useCallback(
    (coinId: string) => {
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => {
        queryClient.prefetchQuery({
          queryKey: ["stablecoin-detail", coinId],
          queryFn: createApiQueryFn(
            `/api/stablecoin/${encodeURIComponent(coinId)}`
          ),
          staleTime: CRON_1H,
        });

        queryClient.prefetchQuery({
          queryKey: ["depeg-events", coinId],
          queryFn: createApiQueryFn(
            `/api/depeg-events?stablecoin=${encodeURIComponent(coinId)}`
          ),
          staleTime: CRON_15MIN,
        });

        queryClient.prefetchQuery({
          queryKey: ["dex-liquidity-history", coinId, 90],
          queryFn: createApiQueryFn(
            `/api/dex-liquidity-history?stablecoin=${encodeURIComponent(coinId)}&days=90`
          ),
          staleTime: CRON_1H,
        });

        queryClient.prefetchQuery({
          queryKey: ["safety-score-history", coinId, 3650],
          queryFn: createApiQueryFn(
            `/api/safety-score-history?stablecoin=${encodeURIComponent(coinId)}&days=3650`
          ),
          staleTime: CRON_24H,
        });
      }, DEBOUNCE_MS);
    },
    [queryClient]
  );
}
