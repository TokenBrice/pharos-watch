// --- Data freshness ratio boundaries ---
// Canonical thresholds for age/interval ratio. Used by worker buildFreshnessMeta
// and frontend data-health.ts to classify cache freshness consistently.
export const FRESHNESS_RATIOS = {
  /** Data is fresh if age <= interval * FRESH (tolerates several missed cycles) */
  FRESH: 8.0,
  /** Data is degraded if age <= interval * DEGRADED (seriously behind schedule) */
  DEGRADED: 12.0,
  // Anything beyond DEGRADED is stale
} as const;

// --- Blacklist gap thresholds ---
export const BLACKLIST_RECENT_WINDOW_SEC = 24 * 3600;
export const STATUS_BLACKLIST_THRESHOLDS = {
  missingRatioDegraded: 0.01,
  missingRatioStale: 0.02,
  missingRecentStale: 25,
} as const;

export function getBlacklistGapStatus({
  missingRatio,
  recentMissingAmounts,
}: {
  missingRatio: number;
  recentMissingAmounts: number;
}): "healthy" | "degraded" | "stale" {
  if (
    missingRatio >= STATUS_BLACKLIST_THRESHOLDS.missingRatioStale
    || recentMissingAmounts >= STATUS_BLACKLIST_THRESHOLDS.missingRecentStale
  ) {
    return "stale";
  }
  if (
    recentMissingAmounts > 0
    || missingRatio >= STATUS_BLACKLIST_THRESHOLDS.missingRatioDegraded
  ) {
    return "degraded";
  }
  return "healthy";
}

// --- On-chain supply thresholds ---
export const STATUS_ONCHAIN_THRESHOLDS = {
  ratioDegraded: 0.1,
  ratioStale: 0.25,
  staleAbsoluteStale: 10,
  divergenceAbsoluteStale: 25,
  ratioMinTrackedCoins: 10,
} as const;
export const STATUS_ONCHAIN_MONITORING_ACTIVE_WINDOW_SEC = 3 * 24 * 3600;
export const STATUS_ONCHAIN_FRESH_WINDOW_SEC = 2 * 3600;
export const STATUS_ONCHAIN_DIVERGENCE_PER_COIN_THRESHOLD = 0.05;

export function hasRepresentativeOnchainRatioSample(trackedCoins: number): boolean {
  return trackedCoins >= STATUS_ONCHAIN_THRESHOLDS.ratioMinTrackedCoins;
}

// --- Missing price thresholds ---
// Raised 2026-04-13 (see agents/plans/2026-04-13-status-stability-hardening-plan.md).
// Prior values 0.15/0.40 were too tight for the current ~194-stablecoin tracked
// set: the normal operating point hovers at ~15% (~29-30 persistently missing
// prices), which produced 2-3 visible healthy↔degraded transitions per day
// driven entirely by coin-counting noise. New values 0.18/0.45 give ≈ 6 coins
// of slack above normal; the elevated band 0.15-0.18 is surfaced as an
// info-severity cause for observability without driving status.
export const STATUS_MISSING_PRICE_THRESHOLDS = {
  ratioElevated: 0.15,
  ratioDegraded: 0.18,
  ratioStale: 0.45,
} as const;

// --- Cache ratio thresholds (availability status) ---
export const STATUS_CACHE_RATIO_THRESHOLDS = {
  degraded: 8,
  stale: 12,
} as const;

// --- Price source confidence severity bands (UI visual indicators) ---
export const STATUS_PRICE_CONFIDENCE_BANDS = {
  highPctGreen: 85,
  highPctAmber: 70,
  missingCountAmber: 3,
  lowCountAmber: 5,
  lowCountRed: 10,
} as const;

// --- CoinGecko comparison thresholds ---
export const STATUS_COINGECKO_PRICE_DIFF_THRESHOLD_PCT = 5;

// --- Mint/burn reconciliation thresholds ---
export const STATUS_RECONCILIATION_THRESHOLDS = {
  criticalAbsoluteUsd: 100_000_000,
  criticalRatio: 0.3,
  warnAbsoluteUsd: 25_000_000,
  warnRatio: 0.12,
} as const;

// --- Reserve metadata drift thresholds ---
export const STATUS_RESERVE_DRIFT_THRESHOLD_POINTS = 15;

export function isReserveDriftThresholdExceeded(delta: number): boolean {
  return delta > STATUS_RESERVE_DRIFT_THRESHOLD_POINTS;
}

// --- Reserve sync coverage thresholds ---
export const STATUS_RESERVE_COMPOSITION_THRESHOLDS = {
  degradedFreshCoverageRatio: 0.75,
  degradedAuthoritativeCoverageRatio: 0.5,
} as const;

// --- Discovery scan ---
export const DISCOVERY_MIN_MCAP = 5_000_000;
