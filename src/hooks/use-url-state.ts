"use client";
import { useCallback, useMemo } from "react";
import { useUrlFilters } from "@/hooks/use-url-filters";
import { decodeState, encodeState, type UrlStateSchema } from "@/lib/url-state";
import { replaceEncodedUrlState } from "@/lib/replace-encoded-url-state";

type UseUrlStateOptions<T> = { enabled?: boolean; clear?: "schema" | { key: keyof T & string }; fallback?: T };

export function useUrlState<T>(schema: UrlStateSchema<T>, options?: UseUrlStateOptions<T>) {
  const { searchParams, replaceParams } = useUrlFilters();
  const clearKey = typeof options?.clear === "object" ? options.clear.key : null;
  const state = useMemo(() => options?.enabled === false
    ? options.fallback ?? decodeState("", schema)
    : decodeState(searchParams, schema), [options?.enabled, options?.fallback, schema, searchParams]);
  const replaceState = useCallback(
    (next: T) => {
      replaceParams((params) => replaceEncodedUrlState(
        params, encodeState(next, schema),
        clearKey === null
          ? { clear: "all", schemaKeys: Object.keys(schema) }
          : { clear: "key", key: clearKey },
      ));
    }, [clearKey, replaceParams, schema],
  );
  const patchState = useCallback(
    (patch: Partial<T>) => replaceState({ ...state, ...patch }), [replaceState, state],
  );
  return { state, replaceState, patchState, searchParams };
}
