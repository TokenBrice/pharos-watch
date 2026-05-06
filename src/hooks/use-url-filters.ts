"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

/**
 * Shared hook for managing URL search-param-based filters.
 *
 * - `getParam(key, default?)` — read a param (falls back to default or "")
 * - `setParam(key, value)` / `setParams(updates)` — replace the current search state
 * - `pushParam(key, value)` / `pushParams(updates)` — create a new history entry
 *
 * This keeps route-local filter state shareable without requiring App Router navigation.
 */

const URL_FILTER_HISTORY_CHANGE_EVENT = "pharos:url-filter-history-change";
let historyPatchSubscribers = 0;
let originalPushState: History["pushState"] | null = null;
let originalReplaceState: History["replaceState"] | null = null;

function dispatchHistoryChangeEvent(): void {
  window.dispatchEvent(new Event(URL_FILTER_HISTORY_CHANGE_EVENT));
}

function subscribeToHistoryChanges(listener: () => void): () => void {
  if (historyPatchSubscribers === 0) {
    originalPushState = window.history.pushState;
    originalReplaceState = window.history.replaceState;

    window.history.pushState = ((data, unused, url) => {
      originalPushState?.call(window.history, data, unused, url);
      dispatchHistoryChangeEvent();
    }) satisfies History["pushState"];

    window.history.replaceState = ((data, unused, url) => {
      originalReplaceState?.call(window.history, data, unused, url);
      dispatchHistoryChangeEvent();
    }) satisfies History["replaceState"];
  }

  historyPatchSubscribers += 1;
  window.addEventListener(URL_FILTER_HISTORY_CHANGE_EVENT, listener);

  return () => {
    window.removeEventListener(URL_FILTER_HISTORY_CHANGE_EVENT, listener);
    historyPatchSubscribers = Math.max(0, historyPatchSubscribers - 1);
    if (historyPatchSubscribers === 0 && originalPushState && originalReplaceState) {
      window.history.pushState = originalPushState;
      window.history.replaceState = originalReplaceState;
      originalPushState = null;
      originalReplaceState = null;
    }
  };
}

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
    const unsubscribeFromHistoryChanges = subscribeToHistoryChanges(syncFromLocation);
    return () => {
      window.removeEventListener("popstate", syncFromLocation);
      unsubscribeFromHistoryChanges();
    };
  }, [syncFromLocation]);

  const searchParams = useMemo(() => new URLSearchParams(search), [search]);

  const getParam = useCallback(
    (key: string, defaultValue = ""): string => {
      return searchParams.get(key) ?? defaultValue;
    },
    [searchParams],
  );

  const writeParams = useCallback((params: URLSearchParams, mode: "replace" | "push" = "replace") => {
    if (typeof window === "undefined") return;
    const qs = params.toString();
    const nextSearch = qs ? `?${qs}` : "";
    const nextUrl = `${window.location.pathname}${nextSearch}`;
    if (window.location.search !== nextSearch) {
      if (mode === "push") {
        window.history.pushState(null, "", nextUrl);
      } else {
        window.history.replaceState(null, "", nextUrl);
      }
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
      writeParams(params, "replace");
    },
    [searchParams, writeParams],
  );

  const pushParam = useCallback(
    (key: string, value: string) => {
      const params = new URLSearchParams(searchParams.toString());
      if (isUrlFilterClearValue(value)) {
        params.delete(key);
      } else {
        params.set(key, value);
      }
      writeParams(params, "push");
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
      writeParams(params, "replace");
    },
    [searchParams, writeParams],
  );

  const pushParams = useCallback(
    (updates: Record<string, string>) => {
      const params = new URLSearchParams(searchParams.toString());
      for (const [key, value] of Object.entries(updates)) {
        if (isUrlFilterClearValue(value)) {
          params.delete(key);
        } else {
          params.set(key, value);
        }
      }
      writeParams(params, "push");
    },
    [searchParams, writeParams],
  );

  const pushSearchParams = useCallback(
    (updater: (params: URLSearchParams) => void) => {
      const params = new URLSearchParams(searchParams.toString());
      updater(params);
      writeParams(params, "push");
    },
    [searchParams, writeParams],
  );

  const replaceParams = useCallback(
    (updater: (params: URLSearchParams) => void) => {
      const params = new URLSearchParams(searchParams.toString());
      updater(params);
      writeParams(params, "replace");
    },
    [searchParams, writeParams],
  );

  return { searchParams, getParam, setParam, pushParam, setParams, pushParams, pushSearchParams, replaceParams };
}
