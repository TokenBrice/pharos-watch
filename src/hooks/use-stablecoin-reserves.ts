"use client";

import { useQuery, type QueryFunctionContext } from "@tanstack/react-query";
import { fetchStablecoinReserves } from "@/lib/api";
import { getPollingWindow } from "@/hooks/use-api-query";
import { CRON_RESERVE_SYNC } from "@/lib/cron-intervals";
import type { QueryRefetchFn } from "@/lib/query-refetch-group";
import type { StablecoinReservesResponse } from "@shared/types";

// Reserve-sync cron runs every 4h; derive live stale/refetch from the shared polling helper convention.
const { staleTime: LIVE_STALE_TIME, refetchInterval: LIVE_REFETCH_INTERVAL } = getPollingWindow(CRON_RESERVE_SYNC);
const FALLBACK_STALE_TIME = 60 * 1000; // fallback/live-stale responses are intentionally short-lived
const FALLBACK_REFETCH_INTERVAL = 2 * 60 * 1000;

export type StablecoinReserveResult = Omit<StablecoinReservesResponse, "stablecoinId">;

function hasActiveSyncIssue(data: StablecoinReservesResponse | null | undefined): boolean {
  return data?.mode === "live" && !!data.sync && (
    data.sync?.status !== "ok" || data.sync?.uncertainWrite === true
  );
}

function reserveQueryStaleTime(query: { state: { data?: StablecoinReservesResponse | null } }): number {
  return query.state.data?.mode === "live" && !hasActiveSyncIssue(query.state.data)
    ? LIVE_STALE_TIME
    : FALLBACK_STALE_TIME;
}

function reserveQueryRefetchInterval(query: { state: { data?: StablecoinReservesResponse | null } }): number {
  return query.state.data?.mode === "live" && !hasActiveSyncIssue(query.state.data)
    ? LIVE_REFETCH_INTERVAL
    : FALLBACK_REFETCH_INTERVAL;
}

export interface StablecoinReservesQueryState {
  reserveResult: StablecoinReserveResult | null;
  error: unknown | null;
  refetch: QueryRefetchFn;
  isFetching: boolean;
}

export function toReserveResult(response: StablecoinReservesResponse): StablecoinReserveResult {
  const { stablecoinId: _stablecoinId, ...reserveResult } = response;
  return reserveResult;
}

/**
 * Fetches resolved reserve presentation data for a stablecoin from the API.
 * Returns `reserveResult = null` only when the coin is not live-enabled or unknown to the worker.
 */
export function useStablecoinReserves(
  stablecoinId: string,
  enabled: boolean,
): StablecoinReservesQueryState {
  const { data, error, refetch, isFetching } = useQuery<StablecoinReservesResponse | null>({
    queryKey: ["stablecoin-reserves", stablecoinId],
    queryFn: (context: QueryFunctionContext) => fetchStablecoinReserves(stablecoinId, { signal: context.signal }),
    enabled,
    staleTime: reserveQueryStaleTime,
    refetchInterval: reserveQueryRefetchInterval,
    retry: 1,
  });

  return {
    reserveResult: data ? toReserveResult(data) : null,
    error: error ?? null,
    refetch,
    isFetching,
  };
}
