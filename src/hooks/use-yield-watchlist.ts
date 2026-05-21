"use client";

import { useMemo } from "react";
import { useWatchlist } from "@/hooks/use-watchlist";

export interface YieldWatchlistState {
  ids: ReadonlySet<string>;
  has: (id: string) => boolean;
  toggle: (id: string) => void;
  add: (id: string) => void;
  remove: (id: string) => void;
  clear: () => void;
  isHydrated: boolean;
}

export function useYieldWatchlist(): YieldWatchlistState {
  const watchlist = useWatchlist();
  const ids = useMemo(() => new Set(watchlist.ids), [watchlist.ids]);

  return useMemo(
    () => ({
      ids,
      has: watchlist.has,
      toggle: watchlist.toggle,
      add: watchlist.add,
      remove: watchlist.remove,
      clear: watchlist.clear,
      isHydrated: watchlist.isHydrated,
    }),
    [
      ids,
      watchlist.add,
      watchlist.clear,
      watchlist.has,
      watchlist.isHydrated,
      watchlist.remove,
      watchlist.toggle,
    ],
  );
}
