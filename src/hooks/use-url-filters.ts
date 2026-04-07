"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

/**
 * Shared hook for managing URL search-param-based filters.
 *
 * - `getParam(key, default?)` — read a param (falls back to default or "")
 * - `setParam(key, value)` — set a single param; deletes it when value is a
 *   "clear" sentinel ("all", "")
 * - `setParams(updates)` — batch-set multiple params in one history.replaceState()
 *
 * All updates use `history.replaceState()` to avoid scroll jumps and keep the
 * browser history clean without requiring App Router navigation.
 */

export function isUrlFilterClearValue(value: string): boolean {
  return value === "all" || value === "";
}

export function useUrlFilters() {
  const [search, setSearch] = useState(() => (
    typeof window !== "undefined" ? window.location.search : ""
  ));

  // syncFromLocation is referentially stable (empty useCallback deps) —
  // safe to use as a useEffect dependency without causing re-subscription loops.
  const syncFromLocation = useCallback(() => {
    if (typeof window === "undefined") return;
    setSearch(window.location.search);
  }, []);

  useEffect(() => {
    window.addEventListener("popstate", syncFromLocation);
    return () => window.removeEventListener("popstate", syncFromLocation);
  }, [syncFromLocation]);

  const searchParams = useMemo(() => new URLSearchParams(search), [search]);

  const getParam = useCallback(
    (key: string, defaultValue = ""): string => {
      return searchParams.get(key) ?? defaultValue;
    },
    [searchParams],
  );

  const writeParams = useCallback((params: URLSearchParams) => {
    if (typeof window === "undefined") return;
    const qs = params.toString();
    const nextSearch = qs ? `?${qs}` : "";
    const nextUrl = `${window.location.pathname}${nextSearch}`;
    if (window.location.search !== nextSearch) {
      window.history.replaceState(null, "", nextUrl);
    }
    setSearch(nextSearch);
  }, []);

  const setParam = useCallback(
    (key: string, value: string) => {
      const params = new URLSearchParams(searchParams.toString());
      if (isUrlFilterClearValue(value)) {
        params.delete(key);
      } else {
        params.set(key, value);
      }
      writeParams(params);
    },
    [searchParams, writeParams],
  );

  const setParams = useCallback(
    (updates: Record<string, string>) => {
      const params = new URLSearchParams(searchParams.toString());
      for (const [key, value] of Object.entries(updates)) {
        if (isUrlFilterClearValue(value)) {
          params.delete(key);
        } else {
          params.set(key, value);
        }
      }
      writeParams(params);
    },
    [searchParams, writeParams],
  );

  const replaceParams = useCallback(
    (updater: (params: URLSearchParams) => void) => {
      const params = new URLSearchParams(searchParams.toString());
      updater(params);
      writeParams(params);
    },
    [searchParams, writeParams],
  );

  return { searchParams, getParam, setParam, setParams, replaceParams };
}
