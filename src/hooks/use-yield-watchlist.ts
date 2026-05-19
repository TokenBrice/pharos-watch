"use client";

import { useCallback, useEffect, useState } from "react";
import { getWindowStorage } from "@/lib/browser-storage";
import { readJsonStorageValue, writeJsonStorageValue } from "@/lib/url-storage-codecs";

const STORAGE_KEY = "pharos:yield-watchlist:v1";

export interface YieldWatchlistState {
  ids: ReadonlySet<string>;
  has: (id: string) => boolean;
  toggle: (id: string) => void;
  add: (id: string) => void;
  remove: (id: string) => void;
  clear: () => void;
  isHydrated: boolean;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string" && entry.length > 0);
}

function loadFromStorage(): string[] {
  const storage = getWindowStorage("local");
  return readJsonStorageValue(
    storage,
    STORAGE_KEY,
    (parsed) => (isStringArray(parsed) ? Array.from(new Set(parsed)) : []),
    [],
    (error) => console.warn("[useYieldWatchlist] Failed to parse stored watchlist, resetting:", error),
  );
}

function saveToStorage(ids: ReadonlySet<string>): void {
  writeJsonStorageValue(getWindowStorage("local"), STORAGE_KEY, Array.from(ids));
}

function getInitialWatchlistState(): { ids: ReadonlySet<string>; isHydrated: boolean } {
  if (typeof window === "undefined") {
    return { ids: new Set<string>(), isHydrated: false };
  }
  return { ids: new Set(loadFromStorage()), isHydrated: true };
}

export function useYieldWatchlist(): YieldWatchlistState {
  const [bootState] = useState(getInitialWatchlistState);
  const [ids, setIds] = useState<ReadonlySet<string>>(bootState.ids);
  const isHydrated = bootState.isHydrated;

  useEffect(() => {
    if (isHydrated) saveToStorage(ids);
  }, [ids, isHydrated]);

  const has = useCallback((id: string) => ids.has(id), [ids]);

  const toggle = useCallback((id: string) => {
    setIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const add = useCallback((id: string) => {
    setIds((prev) => {
      if (prev.has(id)) return prev;
      const next = new Set(prev);
      next.add(id);
      return next;
    });
  }, []);

  const remove = useCallback((id: string) => {
    setIds((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  }, []);

  const clear = useCallback(() => {
    setIds((prev) => (prev.size === 0 ? prev : new Set<string>()));
  }, []);

  return { ids, has, toggle, add, remove, clear, isHydrated };
}
