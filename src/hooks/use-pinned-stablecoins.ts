"use client";

import { useCallback, useMemo } from "react";
import { usePreference } from "@/hooks/use-preferences";
import {
  PINNED_STABLECOINS_STORAGE_KEY,
  normalizePinnedStablecoinIds,
  removePinnedStablecoinId,
  togglePinnedStablecoinId,
} from "@/lib/pinned-stablecoins";

const EMPTY_PINNED_IDS: string[] = [];

export function usePinnedStablecoins() {
  const [pinnedIds, setPinnedIds, resetPinnedIds] = usePreference<string[]>(
    PINNED_STABLECOINS_STORAGE_KEY,
    EMPTY_PINNED_IDS,
    {
      decode: normalizePinnedStablecoinIds,
    },
  );

  const pinnedIdSet = useMemo(() => new Set(pinnedIds), [pinnedIds]);

  const togglePinned = useCallback(
    (stablecoinId: string) => {
      setPinnedIds((current) => togglePinnedStablecoinId(current, stablecoinId));
    },
    [setPinnedIds],
  );

  const unpinStablecoin = useCallback(
    (stablecoinId: string) => {
      setPinnedIds((current) => removePinnedStablecoinId(current, stablecoinId));
    },
    [setPinnedIds],
  );

  const isPinned = useCallback((stablecoinId: string) => pinnedIdSet.has(stablecoinId), [pinnedIdSet]);

  return {
    pinnedIds,
    pinnedIdSet,
    isPinned,
    togglePinned,
    unpinStablecoin,
    resetPinnedIds,
  };
}
