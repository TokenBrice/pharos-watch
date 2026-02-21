"use client";

import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api";

/** Cron interval constants — staleTime = cron interval, refetchInterval = 2x. */
export const CRON_15MIN = 15 * 60_000;
export const CRON_1H = 60 * 60_000;
export const CRON_24H = 24 * 60 * 60_000;

/**
 * Generic TanStack Query hook for API endpoints.
 * Encodes the staleTime = cronInterval, refetchInterval = 2 × cronInterval rule.
 */
export function useApiQuery<T>(
  key: readonly unknown[],
  path: string,
  cronInterval: number,
  opts?: { enabled?: boolean }
): UseQueryResult<T, Error> {
  return useQuery<T, Error>({
    queryKey: key,
    queryFn: () => apiFetch<T>(path),
    staleTime: cronInterval,
    refetchInterval: 2 * cronInterval,
    retry: 2,
    retryDelay: (attempt) => Math.min(1000 * 2 ** attempt, 10000),
    ...opts,
  });
}
