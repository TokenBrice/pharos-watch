"use client";

import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { API_BASE } from "@/lib/api";

/** Cron interval constants — staleTime = cron interval, refetchInterval = 2x. */
export const CRON_5MIN = 5 * 60_000;
export const CRON_10MIN = 10 * 60_000;
export const CRON_15MIN = 15 * 60_000;
export const CRON_1H = 60 * 60_000;
export const CRON_2H = 2 * 60 * 60_000;

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
    queryFn: async () => {
      const res = await fetch(`${API_BASE}${path}`);
      if (!res.ok) throw new Error(`Failed to fetch ${path}`);
      return res.json();
    },
    staleTime: cronInterval,
    refetchInterval: 2 * cronInterval,
    retry: 1,
    ...opts,
  });
}
