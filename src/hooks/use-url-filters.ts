"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

/**
 * Shared hook for managing URL search-param-based filters.
 *
 * - `getParam(key, default?)` — read a param (falls back to default or "")
 * - `setParam(key, value)` — set a single param; deletes it when value is a
 *   "clear" sentinel ("all", "", "1")
 * - `setParams(updates)` — batch-set multiple params in one router.replace()
 *
 * All updates use `router.replace` with `{ scroll: false }` to avoid scroll
 * jumps and keep the browser history clean.
 */
export function useUrlFilters() {
  const [search, setSearch] = useState("");

  const syncFromLocation = useCallback(() => {
    if (typeof window === "undefined") return;
    setSearch(window.location.search);
  }, []);

  useEffect(() => {
    syncFromLocation();
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

  const isClearValue = (value: string): boolean =>
    value === "all" || value === "" || value === "1";

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
      if (isClearValue(value)) {
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
        if (isClearValue(value)) {
          params.delete(key);
        } else {
          params.set(key, value);
        }
      }
      writeParams(params);
    },
    [searchParams, writeParams],
  );

  return { searchParams, getParam, setParam, setParams };
}
