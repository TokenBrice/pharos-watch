"use client";

import { API_PATHS } from "@shared/lib/api-endpoints";
import { API_FRESHNESS_MAX_AGE_SEC } from "@shared/lib/api-freshness";
import { BLACKLIST_STABLECOINS, BlacklistSummaryResponseSchema } from "@shared/types/market";
import type { BlacklistStablecoin, BlacklistSummaryResponse } from "@shared/types";
import { CRON_BLACKLIST } from "@/lib/cron-intervals";
import { isBlacklistBannerEnabled } from "@/lib/feature-flags";
import { useApiQueryWithMeta } from "./use-api-query";

export interface RecentBlacklistAggregate {
  freezes: number;
  destroys: number;
  releases: number;
}

export function useRecentBlacklist7d(symbol: string): RecentBlacklistAggregate | null {
  const isSupported = (BLACKLIST_STABLECOINS as readonly string[]).includes(symbol);
  const isEnabled = isBlacklistBannerEnabled() && isSupported;

  // Share the summary query key with `useBlacklistSummary` so the request is
  // de-duplicated when both hooks mount on the same page.
  const { data } = useApiQueryWithMeta<BlacklistSummaryResponse>(
    ["blacklist-summary"],
    API_PATHS.blacklistSummary(),
    CRON_BLACKLIST,
    {
      enabled: isEnabled,
      retry: 1,
      schema: BlacklistSummaryResponseSchema,
      metaMaxAgeSec: API_FRESHNESS_MAX_AGE_SEC.blacklistSummary,
    },
  );

  if (!isEnabled || !data) return null;
  return data.stats.perCoinRecentEventTypes[symbol as BlacklistStablecoin] ?? { freezes: 0, destroys: 0, releases: 0 };
}
