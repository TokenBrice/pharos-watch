"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

/**
 * Shared hook for managing URL search-param-based filters.
 *
 * - `getParam(key, default?)` — read a param (falls back to default or "")
 * - `setParam(key, value)` / `setParams(updates)` — replace the current search state
 * - `pushSearchParams(updater)` — create a new history entry
 *
 * This keeps route-local filter state shareable without requiring App Router navigation.
 */

const URL_FILTER_HISTORY_CHANGE_EVENT = "pharos:url-filter-history-change";
let historyPatchSubscribers = 0;
let originalPushState: History["pushState"] | null = null;
let originalReplaceState: History["replaceState"] | null = null;
let patchedPushState: History["pushState"] | null = null;
let patchedReplaceState: History["replaceState"] | null = null;

function dispatchHistoryChangeEvent(targetWindow: Window): void {
  const event = new Event(URL_FILTER_HISTORY_CHANGE_EVENT);
  const dispatch = () => {
    if (historyPatchSubscribers === 0) return;
    targetWindow.dispatchEvent(event);
  };
  if (typeof targetWindow.queueMicrotask === "function") {
    targetWindow.queueMicrotask(dispatch);
  } else {
    targetWindow.setTimeout(dispatch, 0);
  }
}

function subscribeToHistoryChanges(listener: () => void): () => void {
  const targetWindow = window;
  if (historyPatchSubscribers === 0) {
    const pushStateOriginal = targetWindow.history.pushState;
    const replaceStateOriginal = targetWindow.history.replaceState;
    originalPushState = pushStateOriginal;
    originalReplaceState = replaceStateOriginal;

    patchedPushState = ((data, unused, url) => {
      pushStateOriginal.call(targetWindow.history, data, unused, url);
      dispatchHistoryChangeEvent(targetWindow);
    }) satisfies History["pushState"];
    targetWindow.history.pushState = patchedPushState;

    patchedReplaceState = ((data, unused, url) => {
      replaceStateOriginal.call(targetWindow.history, data, unused, url);
      dispatchHistoryChangeEvent(targetWindow);
    }) satisfies History["replaceState"];
    targetWindow.history.replaceState = patchedReplaceState;
  }

  historyPatchSubscribers += 1;
  targetWindow.addEventListener(URL_FILTER_HISTORY_CHANGE_EVENT, listener);

  return () => {
    targetWindow.removeEventListener(URL_FILTER_HISTORY_CHANGE_EVENT, listener);
    historyPatchSubscribers = Math.max(0, historyPatchSubscribers - 1);
    if (historyPatchSubscribers === 0 && originalPushState && originalReplaceState) {
      if (targetWindow.history.pushState === patchedPushState) {
        targetWindow.history.pushState = originalPushState;
      }
      if (targetWindow.history.replaceState === patchedReplaceState) {
        targetWindow.history.replaceState = originalReplaceState;
      }
      originalPushState = null;
      originalReplaceState = null;
      patchedPushState = null;
      patchedReplaceState = null;
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
    let active = true;
    window.addEventListener("popstate", syncFromLocation);
    const unsubscribeFromHistoryChanges = subscribeToHistoryChanges(syncFromLocation);
    const syncAfterCommit = () => {
      if (active) syncFromLocation();
    };
    if (typeof window.queueMicrotask === "function") {
      window.queueMicrotask(syncAfterCommit);
    } else {
      window.setTimeout(syncAfterCommit, 0);
    }
    return () => {
      active = false;
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

  return { searchParams, getParam, setParam, setParams, pushSearchParams, replaceParams };
}
