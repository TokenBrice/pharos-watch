"use client";

import { useCallback, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { API_BASE } from "@/lib/api";
import { CRON_5MIN, CRON_1H } from "@/hooks/use-api-query";

const DEBOUNCE_MS = 100;

export function usePrefetchStablecoin() {
  const queryClient = useQueryClient();
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  return useCallback(
    (coinId: string) => {
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => {
        const fetchJson = (path: string) =>
          fetch(`${API_BASE}${path}`).then((r) => r.json());

        queryClient.prefetchQuery({
          queryKey: ["supply-history", coinId],
          queryFn: () =>
            fetchJson(
              `/api/supply-history?stablecoin=${encodeURIComponent(coinId)}&days=1825`
            ),
          staleTime: CRON_1H,
        });

        queryClient.prefetchQuery({
          queryKey: ["depeg-events", coinId],
          queryFn: () =>
            fetchJson(
              `/api/depeg-events?stablecoin=${encodeURIComponent(coinId)}`
            ),
          staleTime: CRON_5MIN,
        });

        queryClient.prefetchQuery({
          queryKey: ["dex-liquidity-history", coinId, 90],
          queryFn: () =>
            fetchJson(
              `/api/dex-liquidity-history?stablecoin=${encodeURIComponent(coinId)}&days=90`
            ),
          staleTime: CRON_1H,
        });
      }, DEBOUNCE_MS);
    },
    [queryClient]
  );
}
