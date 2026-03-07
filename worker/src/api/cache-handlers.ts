import { createCacheHandler } from "../lib/api-utils";
import { CACHE_PROFILES } from "../lib/constants";

export const handleStablecoins = createCacheHandler("stablecoins", "stablecoins", CACHE_PROFILES.realtime, 600);

export const handleStablecoinCharts = createCacheHandler("stablecoin-charts", "stablecoin-charts", CACHE_PROFILES.standard, 600);

export const handleBluechipRatings = createCacheHandler("bluechip-ratings", "bluechip-ratings", CACHE_PROFILES.slow, 43200);

export const handleUsdsStatus = createCacheHandler("usds-status", "usds-status", CACHE_PROFILES.standard, 86400);

/**
 * GET /api/yield-rankings
 * Returns pre-computed yield rankings from cache (written by sync-yield-data cron).
 */
export const handleYieldRankings = createCacheHandler(
  "yield-rankings",
  "yield-rankings",
  CACHE_PROFILES.standard,
  3600,
);
