import { CRON_INTERVALS } from "./cron-jobs";
import {
  CACHE_FRESHNESS_LANES,
  DATA_SURFACE_DESCRIPTORS,
  type CacheFreshnessLaneConfig,
} from "./data-surface-descriptors";
import { DAY_SECONDS } from "./time-constants";

// The lanes are declared beside the data-surface descriptors that project them,
// so the descriptors can derive their freshness fields without an import cycle.
// Re-exported here because this module is the established import path for them.
export { CACHE_FRESHNESS_LANES } from "./data-surface-descriptors";
export type { CacheFreshnessLaneConfig, CacheFreshnessLaneKey } from "./data-surface-descriptors";

const CACHE_FRESHNESS_LANES_BY_CACHE_KEY = Object.freeze(
  Object.fromEntries(
    Object.values(CACHE_FRESHNESS_LANES).map((lane) => [lane.cacheKey, lane]),
  ) as Record<string, CacheFreshnessLaneConfig>,
);

export const CACHE_AVAILABILITY_MAX_AGE_SEC = Object.freeze(
  Object.fromEntries(
    Object.values(CACHE_FRESHNESS_LANES).map((lane) => [lane.cacheKey, lane.availabilityMaxAgeSec]),
  ) as Record<string, number>,
);

export const FRESHNESS_SENTINEL_CACHE_KEYS = [
  "dex-liquidity",
  "yield-data",
  "dews",
] as const;

export function getCacheFreshnessLane(cacheKey: string): CacheFreshnessLaneConfig | null {
  return CACHE_FRESHNESS_LANES_BY_CACHE_KEY[cacheKey] ?? null;
}

// Shared endpoint freshness budgets used by HTTP freshness headers and the UI
// warning layer. Keep these aligned with the worker handlers that emit
// X-Data-Age / Warning headers.
export const API_FRESHNESS_MAX_AGE_SEC = {
  stablecoins: DATA_SURFACE_DESCRIPTORS.stablecoins.endpointMaxAgeSec,
  stablecoinCharts: CACHE_FRESHNESS_LANES.stablecoinCharts.endpointMaxAgeSec,
  // 2x `sync-stablecoins` (900 s): /api/chains aggregates the stablecoins cache that job writes.
  chains: 1800,
  // `sync-stablecoins` interval: peg summary is derived from the same cache generation.
  pegSummary: 900,
  // `sync-stablecoins` interval: depeg detection runs inside that job (cron/sync-stablecoins/post-enrichment.ts).
  depegEvents: 900,
  stressSignals: DATA_SURFACE_DESCRIPTORS.stressSignals.endpointMaxAgeSec,
  reportCards: DATA_SURFACE_DESCRIPTORS.reportCards.endpointMaxAgeSec,
  // `compute-depeg-resolver` interval (fenced +8 D1-only follow-up lane).
  depegResolver: 900,
  depegResolverReview: 900,
  redemptionBackstops: CRON_INTERVALS["sync-redemption-backstops"] * 2,
  // `snapshot-supply` writes one row per day (explicit `intervalSec: DAY_SECONDS`).
  supplyHistory: DAY_SECONDS,
  mintBurnFlows: CRON_INTERVALS["sync-mint-burn"] * 2,
  // Tighter than its producer (`sync-mint-burn`, 1800 s): the events feed warns after one missed run.
  mintBurnEvents: 900,
  blacklist: CRON_INTERVALS["sync-blacklist"],
  blacklistSummary: CRON_INTERVALS["sync-blacklist"],
  dexLiquidity: DATA_SURFACE_DESCRIPTORS.dexLiquidity.endpointMaxAgeSec,
  yieldRankings: DATA_SURFACE_DESCRIPTORS.yieldRankings.endpointMaxAgeSec,
  yieldHistory: DATA_SURFACE_DESCRIPTORS.yieldHistory.endpointMaxAgeSec,
  // 2x `stability-index` (half-hourly PSI compute, which writes a sample every run).
  stabilityIndex: CRON_INTERVALS["stability-index"] * 2,
  // `daily-digest` runs once per day (05:08 UTC lane).
  dailyDigest: DAY_SECONDS,
  digestArchive: DAY_SECONDS,
  bluechip: CACHE_FRESHNESS_LANES.bluechipRatings.endpointMaxAgeSec,
  usdsStatus: CACHE_FRESHNESS_LANES.usdsStatus.endpointMaxAgeSec,
  // Reads `supply_history`, written daily by `snapshot-supply`.
  nonUsdShare: DAY_SECONDS,
} as const;

/**
 * Does a `Warning` response header signal degraded/stale freshness?
 *
 * Matches RFC 7234 warn-code 110 (revalidation failed) at the start of any
 * comma-separated element, plus the Pharos-authored "Response is degraded/stale"
 * texts. Shared so the API client and the endpoint prober cannot drift.
 */
export function isFreshnessWarningHeader(warningHeader: string): boolean {
  return /(?:^|,\s*)110\b/.test(warningHeader) || /Response is (?:degraded|stale)/i.test(warningHeader);
}
