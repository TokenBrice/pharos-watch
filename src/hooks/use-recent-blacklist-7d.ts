"use client";

import { BLACKLIST_STABLECOINS } from "@shared/types/market";
import type { BlacklistStablecoin, BlacklistSummaryResponse } from "@shared/types";
import { isBlacklistBannerEnabled } from "@/lib/feature-flags";
import { useRegisteredApiQueryWithMeta } from "./api-hooks";
import { FRONTEND_API_QUERY_DESCRIPTORS } from "@/lib/api-query-descriptors";

export interface RecentBlacklistAggregate {
  freezes: number;
  destroys: number;
  releases: number;
}

export function useRecentBlacklist7d(symbol: string): RecentBlacklistAggregate | null {
  const isSupported = (BLACKLIST_STABLECOINS as readonly string[]).includes(symbol);
  const isEnabled = isBlacklistBannerEnabled() && isSupported;
  const descriptor = FRONTEND_API_QUERY_DESCRIPTORS.blacklistSummary;

  // Share the summary query key with `useBlacklistSummary` so the request is
  // de-duplicated when both hooks mount on the same page.
  const { data } = useRegisteredApiQueryWithMeta<BlacklistSummaryResponse>(
    descriptor,
    { enabled: isEnabled, retry: 1 },
  );

  if (!isEnabled || !data) return null;
  return data.stats.perCoinRecentEventTypes[symbol as BlacklistStablecoin] ?? { freezes: 0, destroys: 0, releases: 0 };
}
