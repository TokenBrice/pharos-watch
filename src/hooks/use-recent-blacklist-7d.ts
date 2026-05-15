"use client";

import { useMemo } from "react";
import { API_FRESHNESS_MAX_AGE_SEC } from "@shared/lib/api-freshness";
import { BLACKLIST_STABLECOINS, BlacklistResponseSchema } from "@shared/types/market";
import type { BlacklistResponse, BlacklistStablecoin } from "@shared/types";
import { buildBlacklistEventsPath } from "@/lib/blacklist-api";
import { CRON_BLACKLIST } from "@/lib/cron-intervals";
import { isBlacklistBannerEnabled } from "@/lib/feature-flags";
import { useApiQueryWithMeta } from "./use-api-query";

const SEVEN_DAYS_SEC = 7 * 24 * 60 * 60;
// Cap to 250 events to avoid hammering the API while still covering 7d on the
// most-active coins (USDT/USDC peak at ~30 events/day).
const EVENT_PAGE_LIMIT = 250;

export interface RecentBlacklistAggregate {
  freezes: number;
  destroys: number;
  releases: number;
}

export function useRecentBlacklist7d(symbol: string): RecentBlacklistAggregate | null {
  const isSupported = (BLACKLIST_STABLECOINS as readonly string[]).includes(symbol);
  const isEnabled = isBlacklistBannerEnabled() && isSupported;

  // Match the query key shape of `useBlacklistEventsPage` so we share cache.
  const path = buildBlacklistEventsPath({
    stablecoin: isEnabled ? (symbol as BlacklistStablecoin) : undefined,
    limit: EVENT_PAGE_LIMIT,
    offset: 0,
  });
  const { data } = useApiQueryWithMeta<BlacklistResponse>(
    [
      "blacklist-events",
      isEnabled ? symbol : "all",
      "all",
      "all",
      "",
      "date",
      "desc",
      EVENT_PAGE_LIMIT,
      0,
    ],
    path,
    CRON_BLACKLIST,
    {
      enabled: isEnabled,
      retry: 1,
      schema: BlacklistResponseSchema,
      metaMaxAgeSec: API_FRESHNESS_MAX_AGE_SEC.blacklist,
    },
  );

  return useMemo(() => {
    if (!isEnabled || !data?.events) return null;
    // Date.now() is intentional: the cutoff slides as the 30-min refetch
    // window advances, so the banner reflects the actual last 7 days.
    // eslint-disable-next-line react-hooks/purity
    const cutoffSec = Math.floor(Date.now() / 1000) - SEVEN_DAYS_SEC;
    let freezes = 0;
    let destroys = 0;
    let releases = 0;
    for (const ev of data.events) {
      if (!Number.isFinite(ev.timestamp) || ev.timestamp < cutoffSec) continue;
      if (ev.eventType === "blacklist") freezes++;
      else if (ev.eventType === "destroy") destroys++;
      else if (ev.eventType === "unblacklist") releases++;
    }
    return { freezes, destroys, releases };
  }, [isEnabled, data]);
}
