"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  decodeState,
  encodeState,
  type UrlStateSchema,
} from "@/lib/url-state";

/**
 * Shared hook for managing URL search-param-based filters.
 *
 * - `getParam(key, default?)` — read a param (falls back to default or "")
 * - `setParam(key, value)` / `setParams(updates)` — replace the current search state
 * - `pushParam(key, value)` / `pushParams(updates)` — create a new history entry
 *
 * This keeps route-local filter state shareable without requiring App Router navigation.
 *
 * For typed schema-driven access, prefer {@link useTypedUrlState}. It layers
 * `decodeState`/`encodeState` over this hook so any surface with a
 * `UrlStateSchema` gets ergonomic `values` + `setValue` + `resetValues` calls.
 */

const URL_FILTER_HISTORY_CHANGE_EVENT = "pharos:url-filter-history-change";
let historyPatchSubscribers = 0;
let originalPushState: History["pushState"] | null = null;
let originalReplaceState: History["replaceState"] | null = null;

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
    originalPushState = targetWindow.history.pushState;
    originalReplaceState = targetWindow.history.replaceState;

    targetWindow.history.pushState = ((data, unused, url) => {
      originalPushState?.call(targetWindow.history, data, unused, url);
      dispatchHistoryChangeEvent(targetWindow);
    }) satisfies History["pushState"];

    targetWindow.history.replaceState = ((data, unused, url) => {
      originalReplaceState?.call(targetWindow.history, data, unused, url);
      dispatchHistoryChangeEvent(targetWindow);
    }) satisfies History["replaceState"];
  }

  historyPatchSubscribers += 1;
  targetWindow.addEventListener(URL_FILTER_HISTORY_CHANGE_EVENT, listener);

  return () => {
    targetWindow.removeEventListener(URL_FILTER_HISTORY_CHANGE_EVENT, listener);
    historyPatchSubscribers = Math.max(0, historyPatchSubscribers - 1);
    if (historyPatchSubscribers === 0 && originalPushState && originalReplaceState) {
      targetWindow.history.pushState = originalPushState;
      targetWindow.history.replaceState = originalReplaceState;
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

/**
 * Typed, schema-driven URL state hook. Wraps {@link useUrlFilters} so the
 * underlying `popstate` / `pushState` / `replaceState` subscription is shared.
 *
 * `values` is decoded from the current URL on each render via
 * `decodeState(searchParams, schema)`; defaults are applied for missing or
 * invalid params. Writes go through `replaceParams`, touching only the keys
 * owned by `schema` — unrelated params on the same URL are preserved.
 *
 * The hook does not gate on hydration: server-rendered output starts with
 * `decodeState("", schema)` (= schema defaults). Consumers that need to avoid
 * a hydration-mismatch should gate their dependent UI on a `useHasHydrated`
 * boolean, matching the screener's existing pattern.
 *
 * @example
 * const { values, setValue, resetValues } = useTypedUrlState(LIQUIDITY_URL_SCHEMA);
 * // values.peg: string
 * // values.q: string
 * setValue("peg", "EUR");
 */
export function useTypedUrlState<T>(
  schema: UrlStateSchema<T>,
): {
  values: T;
  setValue: <K extends keyof T>(key: K, value: T[K]) => void;
  setValues: (next: Partial<T>) => void;
  resetValues: () => void;
  asQueryString: () => string;
} {
  const { searchParams, replaceParams } = useUrlFilters();

  const values = useMemo<T>(
    () => decodeState(searchParams, schema),
    [searchParams, schema],
  );

  const writeOwnedKeys = useCallback(
    (next: T) => {
      const encoded = encodeState(next, schema);
      const incoming = new URLSearchParams(encoded);
      replaceParams((params) => {
        // Clear only schema-owned keys; leave any unrelated params alone so
        // generalized adoption doesn't stomp on coexisting state.
        for (const key of Object.keys(schema as Record<string, unknown>)) {
          params.delete(key);
        }
        for (const [key, value] of incoming) {
          params.set(key, value);
        }
      });
    },
    [replaceParams, schema],
  );

  const setValue = useCallback(
    <K extends keyof T>(key: K, value: T[K]) => {
      const next = { ...values, [key]: value } as T;
      writeOwnedKeys(next);
    },
    [values, writeOwnedKeys],
  );

  const setValues = useCallback(
    (patch: Partial<T>) => {
      const next = { ...values, ...patch } as T;
      writeOwnedKeys(next);
    },
    [values, writeOwnedKeys],
  );

  const resetValues = useCallback(() => {
    const defaults = decodeState(new URLSearchParams(), schema);
    writeOwnedKeys(defaults);
  }, [schema, writeOwnedKeys]);

  const asQueryString = useCallback(() => encodeState(values, schema), [schema, values]);

  return { values, setValue, setValues, resetValues, asQueryString };
}
