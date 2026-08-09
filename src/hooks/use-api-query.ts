"use client";

import {
  keepPreviousData,
  useQuery,
  type QueryFunctionContext,
  type UseQueryOptions,
  type UseQueryResult,
} from "@tanstack/react-query";
import { mergeAbortSignals } from "@shared/lib/abort-signals";
import { apiFetch, apiFetchWithMeta, type ApiContractMode, type ApiMeta } from "@/lib/api";
import { resolveSchemaLike, type SchemaLikeSource } from "@/lib/schema-like";

const DEFAULT_RETRY_DELAY = (attempt: number) => Math.min(1000 * 2 ** attempt, 10000);
const NO_CLEANUP = (): void => {};
type ApiQueryFunction<T> = (context?: Pick<QueryFunctionContext<readonly unknown[]>, "signal">) => Promise<T>;
type PollingQueryFunction<T> = (context: Pick<QueryFunctionContext<readonly unknown[]>, "signal">) => Promise<T>;

export interface PollingQueryControlOptions {
  enabled?: boolean;
  retry?: number | boolean;
  retryDelay?: (attempt: number) => number;
  staleTime?: number;
  refetchInterval?: number | false;
  /**
   * Opt in to TanStack's stale-while-revalidate behavior (M1): keeps the prior
   * query result visible while a refetch is in flight instead of dropping to
   * `undefined`. Only useful for hooks that power filter/sort surfaces, where a
   * full skeleton wipe between data sets is jarring. Default false.
   */
  keepPreviousData?: boolean;
}

export interface ApiQueryOptions<T> extends PollingQueryControlOptions {
  schema?: SchemaLikeSource<T>;
  fetchInit?: RequestInit;
  metaMaxAgeSec?: number;
  contractMode?: ApiContractMode;
}

export interface PollingWindow {
  staleTime: number;
  refetchInterval: number;
}

/**
 * Fold TanStack's per-attempt signal into the caller's `fetchInit`. The merge is
 * disposed once the request settles so a long-lived caller signal does not
 * accumulate one listener per refetch.
 */
function mergeFetchInitSignal(
  fetchInit: RequestInit | undefined,
  signal: AbortSignal | undefined,
): { requestInit: RequestInit | undefined; dispose: () => void } {
  if (!signal) return { requestInit: fetchInit, dispose: NO_CLEANUP };
  if (!fetchInit) return { requestInit: { signal }, dispose: NO_CLEANUP };
  if (!fetchInit.signal || fetchInit.signal === signal) {
    return { requestInit: { ...fetchInit, signal }, dispose: NO_CLEANUP };
  }
  const merged = mergeAbortSignals([fetchInit.signal, signal]);
  return { requestInit: { ...fetchInit, signal: merged.signal }, dispose: merged.dispose };
}

export function createApiQueryFn<T>(
  path: string,
  schema?: SchemaLikeSource<T>,
  fetchInit?: RequestInit,
  contractMode?: ApiContractMode,
): ApiQueryFunction<T> {
  return async (context) => {
    const { requestInit, dispose } = mergeFetchInitSignal(fetchInit, context?.signal);
    try {
      return await apiFetch<T>(path, await resolveSchemaLike(schema), requestInit, contractMode);
    } finally {
      dispose();
    }
  };
}

function createApiQueryFnWithMeta<T>(
  path: string,
  schema?: SchemaLikeSource<T>,
  fetchInit?: RequestInit,
  metaMaxAgeSec?: number,
  contractMode?: ApiContractMode,
): ApiQueryFunction<{ data: T; meta: ApiMeta | null }> {
  return async (context) => {
    const { requestInit, dispose } = mergeFetchInitSignal(fetchInit, context?.signal);
    try {
      return await apiFetchWithMeta<T>(path, await resolveSchemaLike(schema), requestInit, metaMaxAgeSec, contractMode);
    } finally {
      dispose();
    }
  };
}

function createPollingQueryOptions<T>(
  key: readonly unknown[],
  queryFn: PollingQueryFunction<T>,
  cronInterval: number,
  opts?: PollingQueryControlOptions,
): UseQueryOptions<T, Error, T, readonly unknown[]> {
  const { staleTime, refetchInterval } = getPollingWindow(cronInterval);
  return {
    queryKey: key,
    queryFn,
    staleTime: opts?.staleTime ?? staleTime,
    refetchInterval: opts?.refetchInterval ?? refetchInterval,
    retry: opts?.retry ?? 2,
    retryDelay: opts?.retryDelay ?? DEFAULT_RETRY_DELAY,
    enabled: opts?.enabled,
    placeholderData: opts?.keepPreviousData ? keepPreviousData : undefined,
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
    opts,
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
    opts,
  );
}

export function usePollingQuery<T>(
  key: readonly unknown[],
  queryFn: PollingQueryFunction<T>,
  cronInterval: number,
  opts?: PollingQueryControlOptions,
): UseQueryResult<T, Error> {
  return useQuery<T, Error>(createPollingQueryOptions(key, queryFn, cronInterval, opts));
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

export interface ApiQueryWithMetaResult<T> extends Omit<
  UseQueryResult<{ data: T; meta: ApiMeta | null }, Error>,
  "data"
> {
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
