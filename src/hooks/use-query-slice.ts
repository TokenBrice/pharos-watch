"use client";

import { useMemo } from "react";
import type { ApiMeta } from "@/lib/api";

/**
 * The read-only surface every view-model builder consumes from a query. TanStack v5
 * returns a **fresh result object on every render**, so passing a query straight into a
 * `useMemo` dependency would defeat the memo; the historical workaround was to destructure
 * the five stable fields, re-assemble them into an object literal inside the memo, and list
 * every field in the dependency array. `useQuerySlice` does that once, in one place.
 */
export interface QueryResultLike<TData> {
  data?: TData;
  isLoading?: boolean;
  isError?: boolean;
  error?: unknown;
  dataUpdatedAt: number;
  meta?: ApiMeta | null;
}

export interface QuerySlice<TData> {
  data: TData | undefined;
  isLoading: boolean;
  isError: boolean;
  error: unknown | null;
  dataUpdatedAt: number;
  meta: ApiMeta | null;
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
  };
}

/**
 * Referentially stable projection of one query result. The identity only changes when one
 * of the five transported fields changes, so the slice can be listed as a single dependency.
 */
export function useQuerySlice<TData>(query: QueryResultLike<TData>): QuerySlice<TData> {
  const { data, isLoading, isError, error, dataUpdatedAt, meta } = query;
  return useMemo(
    () => ({
      data,
      isLoading: isLoading ?? false,
      isError: isError ?? false,
      error: error ?? null,
      dataUpdatedAt,
      meta: meta ?? null,
    }),
    [data, dataUpdatedAt, error, isError, isLoading, meta],
  );
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
  // One dependency per transported field, in a stable order — the record's key set is static
  // per call site, so the array length never changes between renders.
  const deps = entries.flatMap(([key, query]) => [
    key,
    query.data,
    query.isLoading,
    query.isError,
    query.error,
    query.dataUpdatedAt,
    query.meta,
  ]);
  return useMemo(
    () => {
      const slices = {} as Slices;
      for (const [key, query] of entries) {
        slices[key] = toQuerySlice(query) as Slices[keyof TQueries];
      }
      return slices;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- derived above, one entry per field
    deps,
  );
}
