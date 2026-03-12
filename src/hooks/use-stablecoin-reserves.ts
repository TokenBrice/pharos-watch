"use client";

import { useQuery } from "@tanstack/react-query";
import { fetchStablecoinReserves } from "@/lib/api";
import type { ReserveResult } from "@shared/lib/reserve-templates";

const STALE_TIME = 60 * 60 * 1000; // 1 hour — hourly cron
const REFETCH_INTERVAL = 2 * 60 * 60 * 1000; // 2 hours

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
  const { data, error } = useQuery({
    queryKey: ["stablecoin-reserves", stablecoinId],
    queryFn: () => fetchStablecoinReserves(stablecoinId),
    enabled,
    staleTime: STALE_TIME,
    refetchInterval: REFETCH_INTERVAL,
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
