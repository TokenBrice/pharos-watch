"use client";

import { useMemo, useState } from "react";
import type { ApiMeta } from "@/lib/api";

/**
 * The read-only surface every view-model builder consumes from a query. TanStack v5
 * returns a **fresh result object on every render**, so passing a query straight into a
 * `useMemo` dependency would defeat the memo; the historical workaround was to destructure
 * the stable transport fields, re-assemble them into an object literal inside the memo, and list
 * every field in the dependency array. `useQuerySlice` does that once, in one place.
 */
export interface QueryResultLike<TData> {
  data?: TData;
  isLoading?: boolean;
  isError?: boolean;
  error?: unknown;
  dataUpdatedAt: number;
  meta?: ApiMeta | null;
  /** Preserve explicit feature gates so deferred data is not treated as unavailable. */
  enabled?: boolean;
}

export interface QuerySlice<TData> {
  data: TData | undefined;
  isLoading: boolean;
  isError: boolean;
  error: unknown | null;
  dataUpdatedAt: number;
  meta: ApiMeta | null;
  enabled?: boolean;
}

type QuerySliceData<TQuery> = TQuery extends QueryResultLike<infer TData> ? TData : never;

function toQuerySlice<TData>(query: QueryResultLike<TData>): QuerySlice<TData> {
  return {
    data: query.data,
    isLoading: query.isLoading ?? false,
    isError: query.isError ?? false,
    error: query.error ?? null,
    dataUpdatedAt: query.dataUpdatedAt,
    meta: query.meta ?? null,
    ...(query.enabled === undefined ? {} : { enabled: query.enabled }),
  };
}

/**
 * Referentially stable projection of one query result. The identity only changes when one
 * of the transported fields changes, so the slice can be listed as a single dependency.
 */
export function useQuerySlice<TData>(query: QueryResultLike<TData>): QuerySlice<TData> {
  const { data, isLoading, isError, error, dataUpdatedAt, meta, enabled } = query;
  return useMemo(
    () => ({
      data,
      isLoading: isLoading ?? false,
      isError: isError ?? false,
      error: error ?? null,
      dataUpdatedAt,
      meta: meta ?? null,
      ...(enabled === undefined ? {} : { enabled }),
    }),
    [data, dataUpdatedAt, error, isError, isLoading, meta, enabled],
  );
}

interface QuerySlicesMemo<T> {
  deps: readonly unknown[];
  slices: T;
}

function createQuerySlicesMemo<T>() {
  let previous: QuerySlicesMemo<T> | null = null;
  return (deps: readonly unknown[], buildSlices: () => T): T => {
    if (previous && previous.deps.length === deps.length
      && deps.every((value, index) => Object.is(value, previous?.deps[index]))) {
      return previous.slices;
    }
    const slices = buildSlices();
    previous = { deps, slices };
    return slices;
  };
}

/**
 * Record form of {@link useQuerySlice}. Both the container and each member keep their
 * identity while their inputs are unchanged, so a whole query group is one dependency.
 *
 * The key set must be static per call site (the same rule every hook dependency list obeys).
 */
export function useQuerySlices<TQueries extends Record<string, QueryResultLike<unknown>>>(
  queries: TQueries,
): { [K in keyof TQueries]: QuerySlice<QuerySliceData<TQueries[K]>> } {
  type Slices = { [K in keyof TQueries]: QuerySlice<QuerySliceData<TQueries[K]>> };
  const entries = Object.entries(queries) as [keyof TQueries, QueryResultLike<unknown>][];
  // One dependency per transported field, in a stable order. The key set is
  // static per call site, so the dependency count stays fixed between renders.
  const deps = entries.flatMap(([key, query]) => [
    key,
    query.data,
    query.isLoading,
    query.isError,
    query.error,
    query.dataUpdatedAt,
    query.meta,
    query.enabled,
  ]);
  // Keep a per-hook memo function, not render-phase state: fresh upstream
  // transport references must not schedule another render to update this cache.
  const [memoize] = useState(() => createQuerySlicesMemo<Slices>());
  return memoize(deps, () => {
    const slices = {} as Slices;
    for (const [key, query] of entries) {
      slices[key] = toQuerySlice(query) as Slices[keyof TQueries];
    }
    return slices;
  });
}
