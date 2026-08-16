"use client";

import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import {
  EMPTY_WATCHLIST_IDS,
  getWatchlistServerSnapshot,
  getWatchlistSnapshot,
  mutateWatchlist,
  subscribeWatchlist,
  syncWatchlistFromStorage,
  WATCHLIST_STORAGE_KEY,
} from "@/lib/watchlist-storage";

export { WATCHLIST_STORAGE_KEY } from "@/lib/watchlist-storage";

// WHY: a single watchlist persists across screener, yield, alt-pegs, and compare.
// Sibling components subscribe via useSyncExternalStore so toggles in one place
// reflect everywhere without a Context provider, and the storage event keeps a
// second tab in sync.

export interface WatchlistState {
  ids: readonly string[];
  idSet: ReadonlySet<string>;
  count: number;
  has: (id: string) => boolean;
  add: (id: string) => void;
  remove: (id: string) => void;
  toggle: (id: string) => void;
  clear: () => void;
  isHydrated: boolean;
}

export function useWatchlist(): WatchlistState {
  const ids = useSyncExternalStore(subscribeWatchlist, getWatchlistSnapshot, getWatchlistServerSnapshot);
  // After the first render commits on the client, useSyncExternalStore is
  // guaranteed to reflect the live store snapshot rather than the SSR-only
  // empty list. We expose that as `isHydrated` for consumers that gate UI on
  // browser-only state.
  const isHydrated = typeof window !== "undefined";

  useEffect(() => {
    syncWatchlistFromStorage();
    function onStorage(event: StorageEvent) {
      if (event.key !== WATCHLIST_STORAGE_KEY) return;
      syncWatchlistFromStorage();
    }
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const idSet = useMemo(() => new Set(ids), [ids]);

  const has = useCallback((id: string) => idSet.has(id), [idSet]);

  const add = useCallback((id: string) => {
    mutateWatchlist((prev) => {
      if (prev.includes(id)) return prev;
      return [id, ...prev];
    });
  }, []);

  const remove = useCallback((id: string) => {
    mutateWatchlist((prev) => {
      if (!prev.includes(id)) return prev;
      return prev.filter((entry) => entry !== id);
    });
  }, []);

  const toggle = useCallback((id: string) => {
    mutateWatchlist((prev) => {
      if (prev.includes(id)) return prev.filter((entry) => entry !== id);
      return [id, ...prev];
    });
  }, []);

  const clear = useCallback(() => {
    mutateWatchlist((prev) => (prev.length === 0 ? prev : EMPTY_WATCHLIST_IDS));
  }, []);

  return { ids, idSet, count: ids.length, has, add, remove, toggle, clear, isHydrated };
}
