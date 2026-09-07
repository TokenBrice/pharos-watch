"use client";
import { useCallback, useEffect, useMemo } from "react";
import { useUrlFilters } from "@/hooks/use-url-filters";
import { decodeState, encodeState, type UrlStateSchema } from "@/lib/url-state";
import { replaceEncodedUrlState } from "@/lib/replace-encoded-url-state";

type UseUrlStateOptions<T> = {
  enabled?: boolean;
  clear?: "schema" | { key: keyof T & string };
  fallback?: T;
  normalize?: keyof T & string;
};

export function useUrlState<T>(schema: UrlStateSchema<T>, options?: UseUrlStateOptions<T>) {
  const { searchParams, isReady, replaceParams } = useUrlFilters();
  const enabled = options?.enabled;
  const fallback = options?.fallback;
  const clear = options?.clear;
  const normalizeKey = options?.normalize;
  const state = useMemo(() => enabled === false
    ? fallback ?? decodeState("", schema)
    : decodeState(searchParams, schema), [enabled, fallback, schema, searchParams]);
  const replaceState = useCallback(
    (next: T) => {
      replaceParams((params) => replaceEncodedUrlState(
        params, encodeState(next, schema),
        typeof clear !== "object"
          ? { clear: "all", schemaKeys: Object.keys(schema) }
          : { clear: "key", key: clear.key },
      ));
    }, [clear, replaceParams, schema],
  );
  const patchState = useCallback(
    (patch: Partial<T>) => replaceState({ ...state, ...patch }), [replaceState, state],
  );

  useEffect(() => {
    if (!isReady || !normalizeKey || enabled === false) return;
    const value = new URLSearchParams(encodeState(state, schema)).get(normalizeKey);
    if (searchParams.get(normalizeKey) === value) return;
    replaceParams((params) => {
      if (value === null) params.delete(normalizeKey);
      else params.set(normalizeKey, value);
    });
  }, [enabled, isReady, normalizeKey, replaceParams, schema, searchParams, state]);

  return { state, replaceState, patchState, searchParams };
}
