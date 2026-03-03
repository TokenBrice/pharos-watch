"use client";

import { useMemo } from "react";
import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { apiFetch, apiFetchWithMeta, type ApiMeta } from "@/lib/api";
import type { ZodType } from "zod";
import { deriveDataHealth, type DataHealthInfo } from "@/lib/data-health";

/** Cron interval constants — staleTime = cron interval, refetchInterval = 2x. */
export const CRON_15MIN = 15 * 60_000;
export const CRON_20MIN = 20 * 60_000;
export const CRON_30MIN = 30 * 60_000;
export const CRON_1H = 60 * 60_000;
export const CRON_24H = 24 * 60 * 60_000;

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
  return useQuery<T, Error>({
    queryKey: key,
    queryFn: () => apiFetch<T>(path, opts?.schema),
    staleTime: cronInterval,
    refetchInterval: 2 * cronInterval,
    retry: 2,
    retryDelay: (attempt) => Math.min(1000 * 2 ** attempt, 10000),
    enabled: opts?.enabled,
  });
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
  return useQuery<{ data: T; meta: ApiMeta | null }, Error>({
    queryKey: key,
    queryFn: () => apiFetchWithMeta<T>(path, opts?.schema),
    staleTime: cronInterval,
    refetchInterval: 2 * cronInterval,
    retry: 2,
    retryDelay: (attempt) => Math.min(1000 * 2 ** attempt, 10000),
    enabled: opts?.enabled,
  });
}

/**
 * Health-aware query wrapper. Keeps the meta-aware payload and derives
 * a canonical trust state (`fresh`, `degraded`, `stale`, `unavailable`, `error`).
 */
export function useApiQueryWithHealth<T>(
  key: readonly unknown[],
  path: string,
  cronInterval: number,
  opts?: { enabled?: boolean; schema?: ZodType<T>; label?: string },
): UseQueryResult<{ data: T; meta: ApiMeta | null }, Error> & {
  health: DataHealthInfo;
  payload: T | undefined;
  meta: ApiMeta | null;
} {
  const query = useApiQueryWithMeta<T>(key, path, cronInterval, opts);
  const meta = query.data?.meta ?? null;
  const payload = query.data?.data;

  const health = useMemo(
    () =>
      deriveDataHealth({
        label: opts?.label ?? path,
        dataUpdatedAt: query.dataUpdatedAt,
        staleTime: cronInterval,
        error: query.error,
        hasData: payload !== undefined,
        meta,
      }),
    [cronInterval, meta, opts?.label, path, payload, query.dataUpdatedAt, query.error],
  );

  return {
    ...query,
    health,
    payload,
    meta,
  };
}
