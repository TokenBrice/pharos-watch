"use client";

import { useQuery, type UseQueryOptions, type UseQueryResult } from "@tanstack/react-query";
import { apiFetch, apiFetchWithMeta, type ApiContractMode, type ApiMeta } from "@/lib/api";
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

export interface PollingWindow {
  staleTime: number;
  refetchInterval: number;
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
): UseQueryOptions<T, Error, T, readonly unknown[]> {
  const { staleTime, refetchInterval } = getPollingWindow(cronInterval);
  return {
    queryKey: key,
    queryFn,
    staleTime,
    refetchInterval,
    retry: opts?.retry ?? 2,
    retryDelay: opts?.retryDelay ?? DEFAULT_RETRY_DELAY,
    enabled: opts?.enabled,
  };
}

export function getPollingWindow(cronInterval: number): PollingWindow {
  return {
    staleTime: cronInterval,
    refetchInterval: 2 * cronInterval,
  };
}

export function createApiPollingQueryOptions<T>(
  key: readonly unknown[],
  path: string,
  cronInterval: number,
  opts?: ApiQueryOptions<T>,
): UseQueryOptions<T, Error, T, readonly unknown[]> {
  return createPollingQueryOptions(
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

export function createApiPollingQueryOptionsWithMeta<T>(
  key: readonly unknown[],
  path: string,
  cronInterval: number,
  opts?: ApiQueryOptions<T>,
): UseQueryOptions<{ data: T; meta: ApiMeta | null }, Error, { data: T; meta: ApiMeta | null }, readonly unknown[]> {
  const metaMaxAgeSec = opts?.metaMaxAgeSec ?? Math.max(1, Math.round(cronInterval / 1000));
  return createPollingQueryOptions(
    key,
    createApiQueryFnWithMeta(path, opts?.schema, opts?.fetchInit, metaMaxAgeSec, opts?.contractMode),
    cronInterval,
    {
      enabled: opts?.enabled,
      retry: opts?.retry,
      retryDelay: opts?.retryDelay,
    },
  );
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
): UseQueryOptions<T, Error, T, readonly unknown[]> {
  return {
    queryKey: key,
    queryFn,
    staleTime: opts?.staleTime ?? Infinity,
    refetchInterval: false as const,
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
  return useQuery<T, Error>(createApiPollingQueryOptions(key, path, cronInterval, opts));
}

export interface ApiQueryWithMetaResult<T>
  extends Omit<UseQueryResult<{ data: T; meta: ApiMeta | null }, Error>, "data"> {
  data: T | undefined;
  meta: ApiMeta | null;
}

export function unwrapApiQueryWithMetaResult<T>(
  query: UseQueryResult<{ data: T; meta: ApiMeta | null }, Error>,
): ApiQueryWithMetaResult<T> {
  const { data, ...rest } = query;
  return {
    ...rest,
    data: data?.data,
    meta: data?.meta ?? null,
  };
}

export function useApiQueryWithMeta<T>(
  key: readonly unknown[],
  path: string,
  cronInterval: number,
  opts?: ApiQueryOptions<T>,
): ApiQueryWithMetaResult<T> {
  return unwrapApiQueryWithMetaResult(
    useQuery<{ data: T; meta: ApiMeta | null }, Error>(
      createApiPollingQueryOptionsWithMeta(key, path, cronInterval, opts),
    ),
  );
}
