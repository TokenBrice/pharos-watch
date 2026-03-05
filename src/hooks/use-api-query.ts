"use client";

import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { apiFetch, apiFetchWithMeta, type ApiMeta } from "@/lib/api";
import type { ZodType } from "zod";

/** Cron interval constants — staleTime = cron interval, refetchInterval = 2x. */
export const CRON_1MIN = 60_000;
export const CRON_15MIN = 15 * 60_000;
export const CRON_20MIN = 20 * 60_000;
export const CRON_30MIN = 30 * 60_000;
export const CRON_1H = 60 * 60_000;
export const CRON_24H = 24 * 60 * 60_000;
const DEFAULT_RETRY_DELAY = (attempt: number) => Math.min(1000 * 2 ** attempt, 10000);

export function createPollingQueryOptions<T>(
  key: readonly unknown[],
  queryFn: () => Promise<T>,
  cronInterval: number,
  opts?: {
    enabled?: boolean;
    retry?: number | boolean;
    retryDelay?: (attempt: number) => number;
  },
) {
  return {
    queryKey: key,
    queryFn,
    staleTime: cronInterval,
    refetchInterval: 2 * cronInterval,
    retry: opts?.retry ?? 2,
    retryDelay: opts?.retryDelay ?? DEFAULT_RETRY_DELAY,
    enabled: opts?.enabled,
  };
}

/**
 * Generic TanStack Query hook for API endpoints.
 * Encodes the staleTime = cronInterval, refetchInterval = 2 × cronInterval rule.
 * When a Zod schema is provided, validates the response at runtime.
 */
export function useApiQuery<T>(
  key: readonly unknown[],
  path: string,
  cronInterval: number,
  opts?: { enabled?: boolean; schema?: ZodType<T> }
): UseQueryResult<T, Error> {
  return useQuery<T, Error>(createPollingQueryOptions(
    key,
    () => apiFetch<T>(path, opts?.schema),
    cronInterval,
    { enabled: opts?.enabled },
  ));
}

/**
 * Meta-aware variant of useApiQuery — returns { data, meta } where meta
 * contains freshness info (updatedAt, ageSeconds, status).
 */
export function useApiQueryWithMeta<T>(
  key: readonly unknown[],
  path: string,
  cronInterval: number,
  opts?: { enabled?: boolean; schema?: ZodType<T> }
): UseQueryResult<{ data: T; meta: ApiMeta | null }, Error> {
  return useQuery<{ data: T; meta: ApiMeta | null }, Error>(createPollingQueryOptions(
    key,
    () => apiFetchWithMeta<T>(path, opts?.schema),
    cronInterval,
    { enabled: opts?.enabled },
  ));
}
