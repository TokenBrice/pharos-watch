"use client";

import { useCallback, useMemo } from "react";
import { useWatchlist } from "@/hooks/use-watchlist";
import { normalizePinnedStablecoinIds } from "@/lib/pinned-stablecoins";

export function usePinnedStablecoins() {
  const watchlist = useWatchlist();
  const pinnedIds = useMemo(() => normalizePinnedStablecoinIds(watchlist.ids), [watchlist.ids]);
  const pinnedIdSet = useMemo(() => new Set(pinnedIds), [pinnedIds]);
  const isPinned = useCallback((stablecoinId: string) => pinnedIdSet.has(stablecoinId), [pinnedIdSet]);

  return {
    pinnedIds,
    pinnedIdSet,
    isPinned,
    togglePinned: watchlist.toggle,
    unpinStablecoin: watchlist.remove,
    resetPinnedIds: watchlist.clear,
  };
}
