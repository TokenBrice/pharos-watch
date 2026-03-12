"use client";

import { useQuery } from "@tanstack/react-query";
import { fetchStablecoinReserves } from "@/lib/api";
import type { ReserveResult } from "@shared/lib/reserve-templates";

const STALE_TIME = 60 * 60 * 1000; // 1 hour — daily cron
const REFETCH_INTERVAL = 2 * 60 * 60 * 1000; // 2 hours

/**
 * Fetches live reserve composition for a stablecoin from the API.
 * Returns null when no live data is available (cron not yet run or not configured).
 * Only call this when `coin.liveReservesConfig` is defined.
 * `displayUrl` comes from the static coin metadata (not the API) since it never changes.
 */
export function useStablecoinReserves(
  stablecoinId: string,
  enabled: boolean,
  displayUrl?: string,
): ReserveResult | null {
  const { data } = useQuery({
    queryKey: ["stablecoin-reserves", stablecoinId],
    queryFn: () => fetchStablecoinReserves(stablecoinId),
    enabled,
    staleTime: STALE_TIME,
    refetchInterval: REFETCH_INTERVAL,
    retry: 1,
  });

  if (!data) return null;
  return {
    reserves: data.slices,
    estimated: false,
    liveAt: data.fetchedAt,
    source: data.source,
    displayUrl,
  };
}
