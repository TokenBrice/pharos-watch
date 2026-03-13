"use client";

import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { apiFetch, apiFetchWithMeta, type ApiContractMode, type ApiMeta } from "@/lib/api";
export {
  CRON_1MIN,
  CRON_15MIN,
  CRON_20MIN,
  CRON_30MIN,
  CRON_1H,
  CRON_24H,
} from "@/lib/cron-intervals";
import type { ZodType } from "zod";

const DEFAULT_RETRY_DELAY = (attempt: number) => Math.min(1000 * 2 ** attempt, 10000);

interface PollingQueryControlOptions {
  enabled?: boolean;
  retry?: number | boolean;
  retryDelay?: (attempt: number) => number;
}

interface ApiQueryOptions<T> extends PollingQueryControlOptions {
  schema?: ZodType<T>;
  fetchInit?: RequestInit;
  metaMaxAgeSec?: number;
  contractMode?: ApiContractMode;
}

export function createApiQueryFn<T>(
  path: string,
  schema?: ZodType<T>,
  fetchInit?: RequestInit,
  contractMode?: ApiContractMode,
): () => Promise<T> {
  return () => {
    if (fetchInit) {
      return apiFetch<T>(path, schema, fetchInit, contractMode);
    }
    return apiFetch<T>(path, schema, undefined, contractMode);
  };
}

export function createApiQueryFnWithMeta<T>(
  path: string,
  schema?: ZodType<T>,
  fetchInit?: RequestInit,
  metaMaxAgeSec?: number,
  contractMode?: ApiContractMode,
): () => Promise<{ data: T; meta: ApiMeta | null }> {
  return () => {
    if (fetchInit) {
      return apiFetchWithMeta<T>(path, schema, fetchInit, metaMaxAgeSec, contractMode);
    }
    return apiFetchWithMeta<T>(path, schema, undefined, metaMaxAgeSec, contractMode);
  };
}

export function createPollingQueryOptions<T>(
  key: readonly unknown[],
  queryFn: () => Promise<T>,
  cronInterval: number,
  opts?: PollingQueryControlOptions,
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

export function usePollingQuery<T>(
  key: readonly unknown[],
  queryFn: () => Promise<T>,
  cronInterval: number,
  opts?: PollingQueryControlOptions,
): UseQueryResult<T, Error> {
  return useQuery<T, Error>(createPollingQueryOptions(
    key,
    queryFn,
    cronInterval,
    opts,
  ));
}

export function createStaticQueryOptions<T>(
  key: readonly unknown[],
  queryFn: () => Promise<T>,
  opts?: {
    enabled?: boolean;
    retry?: number | boolean;
    retryDelay?: (attempt: number) => number;
    staleTime?: number;
  },
) {
  return {
    queryKey: key,
    queryFn,
    staleTime: opts?.staleTime ?? Infinity,
    enabled: opts?.enabled,
    retry: opts?.retry ?? 1,
    retryDelay: opts?.retryDelay ?? DEFAULT_RETRY_DELAY,
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
  opts?: ApiQueryOptions<T>,
): UseQueryResult<T, Error> {
  return usePollingQuery(
    key,
    createApiQueryFn(path, opts?.schema, opts?.fetchInit, opts?.contractMode),
    cronInterval,
    {
      enabled: opts?.enabled,
      retry: opts?.retry,
      retryDelay: opts?.retryDelay,
    },
  );
}

export interface ApiQueryWithMetaResult<T>
  extends Omit<UseQueryResult<{ data: T; meta: ApiMeta | null }, Error>, "data"> {
  data: T | undefined;
  meta: ApiMeta | null;
}

export function useApiQueryWithMeta<T>(
  key: readonly unknown[],
  path: string,
  cronInterval: number,
  opts?: ApiQueryOptions<T>,
): ApiQueryWithMetaResult<T> {
  const metaMaxAgeSec = opts?.metaMaxAgeSec ?? Math.max(1, Math.round(cronInterval / 1000));
  const query = usePollingQuery(
    key,
    createApiQueryFnWithMeta(path, opts?.schema, opts?.fetchInit, metaMaxAgeSec, opts?.contractMode),
    cronInterval,
    {
      enabled: opts?.enabled,
      retry: opts?.retry,
      retryDelay: opts?.retryDelay,
    },
  );

  const { data, ...rest } = query;
  return {
    ...rest,
    data: data?.data,
    meta: data?.meta ?? null,
  };
}
