"use client";

import { useMemo } from "react";
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
