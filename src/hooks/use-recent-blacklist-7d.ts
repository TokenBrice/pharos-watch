"use client";

import { BLACKLIST_STABLECOINS } from "@shared/types/market";
import type { BlacklistStablecoin } from "@shared/types";
import { isBlacklistBannerEnabled } from "@/lib/feature-flags";
import { useBlacklistSummary } from "./use-blacklist-events";

export interface RecentBlacklistAggregate {
  freezes: number;
  destroys: number;
  releases: number;
}

export function useRecentBlacklist7d(symbol: string): RecentBlacklistAggregate | null {
  const isSupported = (BLACKLIST_STABLECOINS as readonly string[]).includes(symbol);
  const isEnabled = isBlacklistBannerEnabled() && isSupported;
  const { data } = useBlacklistSummary({ enabled: isEnabled });

  if (!isEnabled || !data) return null;
  return data.stats.perCoinRecentEventTypes[symbol as BlacklistStablecoin] ?? { freezes: 0, destroys: 0, releases: 0 };
}
