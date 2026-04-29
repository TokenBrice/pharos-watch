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

/**
 * Classify an age/interval ratio into the canonical freshness status tier.
 * Shared between worker buildFreshnessMeta and the frontend X-Data-Age fallback
 * so threshold changes propagate in one place.
 */
export function classifyFreshnessRatio(ratio: number): "fresh" | "degraded" | "stale" {
  if (ratio <= FRESHNESS_RATIOS.FRESH) return "fresh";
  if (ratio <= FRESHNESS_RATIOS.DEGRADED) return "degraded";
  return "stale";
}

// --- Blacklist gap thresholds ---
export const BLACKLIST_RECENT_WINDOW_SEC = 24 * 3600;
export const STATUS_BLACKLIST_THRESHOLDS = {
  missingRatioDegraded: 0.01,
  missingRatioStale: 0.02,
  missingRecentDegraded: 5,
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
    recentMissingAmounts >= STATUS_BLACKLIST_THRESHOLDS.missingRecentDegraded
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
// Raised 2026-04-13 after status-stability hardening.
// Prior values 0.15/0.40 were too tight for the then-current 181-active-coin
// tracked set: the normal operating point hovered near 15% (~26-27 persistently
// missing prices), producing 2-3 visible healthy↔degraded transitions per day
// driven entirely by coin-counting noise. New values 0.18/0.45 gave roughly 5 coins
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

// --- Probe classification thresholds (browser & self-check probe runs) ---
export const STATUS_PROBE_THRESHOLDS = {
  /** p95 latency (ms) at or below which probes are classified healthy (given fail cap). */
  healthyP95MaxMs: 5000,
  /** p95 latency (ms) at or below which probes are classified degraded (given fail ratio cap). */
  degradedP95MaxMs: 8000,
  /** Max failures tolerated for "healthy" classification (absolute). */
  healthyMaxFailCount: 1,
  /** Max fail ratio tolerated for "degraded" classification (fraction of sample). */
  degradedMaxFailRatio: 0.1,
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
