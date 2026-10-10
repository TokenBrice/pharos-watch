"use client";

import { useCallback, useMemo } from "react";
import { useWatchlist } from "@/hooks/use-watchlist";
import { normalizePinnedStablecoinIds } from "@/lib/pinned-stablecoins";
import { mutateWatchlist } from "@/lib/watchlist-storage";

export function usePinnedStablecoins() {
  const watchlist = useWatchlist();
  const pinnedIds = useMemo(() => normalizePinnedStablecoinIds(watchlist.ids), [watchlist.ids]);
  const pinnedIdSet = useMemo(() => new Set(pinnedIds), [pinnedIds]);
  const isPinned = useCallback((stablecoinId: string) => pinnedIdSet.has(stablecoinId), [pinnedIdSet]);
  const togglePinned = useCallback((stablecoinId: string) => {
    mutateWatchlist((ids) => {
      if (normalizePinnedStablecoinIds(ids).includes(stablecoinId)) {
        return ids.filter((id) => id !== stablecoinId);
      }
      if (!normalizePinnedStablecoinIds([stablecoinId]).length) return ids;
      return [stablecoinId, ...ids.filter((id) => id !== stablecoinId)];
    });
  }, []);

  return {
    pinnedIds,
    pinnedIdSet,
    isPinned,
    togglePinned,
    unpinStablecoin: watchlist.remove,
    resetPinnedIds: watchlist.clear,
  };
}
