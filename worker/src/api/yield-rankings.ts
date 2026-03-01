import { createCacheHandler } from "../lib/api-utils";
import { CACHE_PROFILES } from "../lib/constants";

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
