"use client";

import { useQuery } from "@tanstack/react-query";
import { fetchStablecoinReserves } from "@/lib/api";
import { createPollingQueryOptions } from "@/hooks/use-api-query";
import type { ReserveResult } from "@shared/lib/reserve-templates";
import type { StablecoinReservesResponse } from "@shared/types";

// Reserves cron runs hourly; derive live stale/refetch from the shared polling helper convention.
const RESERVES_CRON_INTERVAL = 3_600_000; // 1 hour
const { staleTime: LIVE_STALE_TIME, refetchInterval: LIVE_REFETCH_INTERVAL } =
  createPollingQueryOptions([], () => Promise.resolve(null), RESERVES_CRON_INTERVAL);
const FALLBACK_STALE_TIME = 60 * 1000; // fallback/live-stale responses are intentionally short-lived
const FALLBACK_REFETCH_INTERVAL = 2 * 60 * 1000;

function reserveQueryStaleTime(query: { state: { data?: StablecoinReservesResponse | null } }): number {
  return query.state.data?.mode === "live" ? LIVE_STALE_TIME : FALLBACK_STALE_TIME;
}

function reserveQueryRefetchInterval(query: { state: { data?: StablecoinReservesResponse | null } }): number {
  return query.state.data?.mode === "live" ? LIVE_REFETCH_INTERVAL : FALLBACK_REFETCH_INTERVAL;
}

export interface StablecoinReservesQueryState {
  reserveResult: ReserveResult | null;
  error: unknown | null;
}

/**
 * Fetches resolved reserve presentation data for a stablecoin from the API.
 * Returns `reserveResult = null` only when the coin is not live-enabled or unknown to the worker.
 */
export function useStablecoinReserves(
  stablecoinId: string,
  enabled: boolean,
): StablecoinReservesQueryState {
  const { data, error } = useQuery<StablecoinReservesResponse | null>({
    queryKey: ["stablecoin-reserves", stablecoinId],
    queryFn: () => fetchStablecoinReserves(stablecoinId),
    enabled,
    staleTime: reserveQueryStaleTime,
    refetchInterval: reserveQueryRefetchInterval,
    retry: 1,
  });

  if (!data) return { reserveResult: null, error: error ?? null };

  const { stablecoinId: _id, ...reserveResult } = data;
  // Type-check: ensure the spread matches ReserveResult exactly.
  const checked: ReserveResult = reserveResult;
  return { reserveResult: checked, error: error ?? null };
}
