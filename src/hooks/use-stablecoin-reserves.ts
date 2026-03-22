"use client";

import { useQuery } from "@tanstack/react-query";
import { fetchStablecoinReserves } from "@/lib/api";
import type { ReserveResult } from "@shared/lib/reserve-templates";
import type { StablecoinReservesResponse } from "@shared/types";

const LIVE_STALE_TIME = 60 * 60 * 1000; // 1 hour — hourly cron
const LIVE_REFETCH_INTERVAL = 2 * 60 * 60 * 1000; // 2 hours
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

  return {
    reserveResult: data
      ? {
          reserves: data.reserves,
          estimated: data.estimated,
          mode: data.mode,
          liveAt: data.liveAt,
          source: data.source,
          displayUrl: data.displayUrl,
          sync: data.sync,
        }
      : null,
    error: error ?? null,
  };
}
