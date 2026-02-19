"use client";

import { useSearchParams, useRouter, usePathname } from "next/navigation";
import { useCallback } from "react";

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
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();

  const getParam = useCallback(
    (key: string, defaultValue = ""): string => {
      return searchParams.get(key) ?? defaultValue;
    },
    [searchParams],
  );

  const isClearValue = (value: string): boolean =>
    value === "all" || value === "" || value === "1";

  const setParam = useCallback(
    (key: string, value: string) => {
      const params = new URLSearchParams(searchParams.toString());
      if (isClearValue(value)) {
        params.delete(key);
      } else {
        params.set(key, value);
      }
      const qs = params.toString();
      router.replace(`${pathname}${qs ? `?${qs}` : ""}`, { scroll: false });
    },
    [searchParams, router, pathname],
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
      const qs = params.toString();
      router.replace(`${pathname}${qs ? `?${qs}` : ""}`, { scroll: false });
    },
    [searchParams, router, pathname],
  );

  return { searchParams, getParam, setParam, setParams };
}
