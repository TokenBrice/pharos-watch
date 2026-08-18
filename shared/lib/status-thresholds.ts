import type { StatusHealthValue } from "../types/status";

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
 * Canonical freshness status tier emitted by API freshness helpers across the
 * worker, shared, and worker test suites. Endpoint-specific extensions
 * (e.g. chains' `"unavailable"` dependency state) compose this union rather
 * than redeclaring the base literal in each module.
 */
export type FreshnessStatus = "fresh" | "degraded" | "stale";

/**
 * Classify an age/interval ratio into the canonical freshness status tier.
 * Shared between worker buildFreshnessMeta and the frontend X-Data-Age fallback
 * so threshold changes propagate in one place.
 */
export function classifyFreshnessRatio(ratio: number): FreshnessStatus {
  if (ratio <= FRESHNESS_RATIOS.FRESH) return "fresh";
  if (ratio <= FRESHNESS_RATIOS.DEGRADED) return "degraded";
  return "stale";
}

// --- Blacklist gap thresholds ---
/** Rolling window (seconds) used to count "recent" missing blacklist amounts when classifying blacklist gap status. */
export const BLACKLIST_RECENT_WINDOW_SEC = 24 * 3600;
/** Ratios are fractions of total events (0.01 = 1%); recent counts are absolute amounts within BLACKLIST_RECENT_WINDOW_SEC. */
export const STATUS_BLACKLIST_THRESHOLDS = {
  missingRatioDegraded: 0.01,
  missingRatioStale: 0.02,
  missingRecentDegraded: 5,
  missingRecentStale: 25,
} as const;

/** Classify blacklist coverage gaps. Stale tier wins over degraded when either condition triggers. */
export function getBlacklistGapStatus({
  missingRatio,
  recentMissingAmounts,
}: {
  missingRatio: number;
  recentMissingAmounts: number;
}): StatusHealthValue {
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
/** ratio* fields are fractions of monitored coins; *AbsoluteStale fields are raw coin counts. ratioMinTrackedCoins gates whether the ratio is statistically meaningful. */
export const STATUS_ONCHAIN_THRESHOLDS = {
  ratioDegraded: 0.1,
  ratioStale: 0.25,
  staleAbsoluteStale: 10,
  divergenceAbsoluteStale: 25,
  ratioMinTrackedCoins: 10,
} as const;
/** Window for treating an on-chain monitoring source as actively reporting. Sources silent longer than this are excluded from health rollups. */
export const STATUS_ONCHAIN_MONITORING_ACTIVE_WINDOW_SEC = 3 * 24 * 3600;
/** Per-coin on-chain snapshot freshness ceiling. Snapshots older than this contribute to the stale-snapshot count. */
export const STATUS_ONCHAIN_FRESH_WINDOW_SEC = 2 * 3600;
/** Per-coin divergence ceiling (fraction). Above this, on-chain supply is considered to disagree with DefiLlama materially. */
export const STATUS_ONCHAIN_DIVERGENCE_PER_COIN_THRESHOLD = 0.05;

/** Returns true when the tracked-coin count is large enough for ratio-based thresholds to be applied (avoids 1/3 == "33% degraded" noise). */
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
/** Age/interval ratio bands for cached endpoint availability. Distinct from FRESHNESS_RATIOS: applied at the endpoint-availability layer, not the per-record freshness layer. */
export const STATUS_CACHE_RATIO_THRESHOLDS = {
  degraded: FRESHNESS_RATIOS.FRESH,
  stale: FRESHNESS_RATIOS.DEGRADED,
} as const;

/**
 * Per-cache overrides of the global availability ratio bands, keyed by cache key.
 * Tightens the default 8×/12× tolerance for caches whose slow stale window would
 * otherwise under-report real user impact on the public status surface.
 *
 * `yield-data`: post-V9 producer (`sync-yield-data`, 1800s availability budget).
 * Under the global bands a lane can serve multi-hour-stale rankings while public health
 * still reads "healthy", even though the admin endpoint-budget lane already flags
 * it at 1×. Ruling R3 (2026-07-19) tightens it to degrade after two missed post-V9
 * publishes (2×) and go stale after four (4×); one missed publish stays healthy.
 * See docs/architecture.md ADR-9 and docs/status-dashboard.md.
 */
export const STATUS_CACHE_RATIO_OVERRIDES: Record<string, { degraded: number; stale: number }> = {
  "yield-data": { degraded: 2.0, stale: 4.0 },
};

/** Resolve the availability ratio bands for a cache key, applying any per-cache override. */
export function getCacheRatioThresholds(cacheKey?: string): { degraded: number; stale: number } {
  return (cacheKey ? STATUS_CACHE_RATIO_OVERRIDES[cacheKey] : undefined) ?? STATUS_CACHE_RATIO_THRESHOLDS;
}

/**
 * Ratio ceiling for a cache's per-record `healthy` boolean. Overridden caches flip
 * to `healthy:false` once they enter their degraded band (public-unhealthy on real
 * staleness); every other cache keeps the historical "not stale" ceiling.
 */
export function getCacheHealthyMaxRatio(cacheKey?: string): number {
  const override = cacheKey ? STATUS_CACHE_RATIO_OVERRIDES[cacheKey] : undefined;
  return override ? override.degraded : FRESHNESS_RATIOS.DEGRADED;
}

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
/** Percent gap (Pharos vs CoinGecko) above which a coin's cross-source price is flagged as divergent. */
export const STATUS_COINGECKO_PRICE_DIFF_THRESHOLD_PCT = 5;

// --- Mint/burn reconciliation thresholds ---
/** USD amounts are absolute; ratios are fractions of expected change. Critical tier wins over warn when either trips. */
export const STATUS_RECONCILIATION_THRESHOLDS = {
  criticalAbsoluteUsd: 100_000_000,
  criticalRatio: 0.3,
  warnAbsoluteUsd: 25_000_000,
  warnRatio: 0.12,
} as const;

// --- Reserve metadata drift thresholds ---
/** Drift threshold expressed in raw delta points of the reserve composition score (NOT percentage). */
export const STATUS_RESERVE_DRIFT_THRESHOLD_POINTS = 15;

/** True when the reserve composition score delta exceeds the curated drift budget, signalling stale or revised reserve metadata. */
export function isReserveDriftThresholdExceeded(delta: number): boolean {
  return delta > STATUS_RESERVE_DRIFT_THRESHOLD_POINTS;
}

// --- Reserve sync coverage thresholds ---
export const STATUS_RESERVE_COMPOSITION_THRESHOLDS = {
  degradedFreshCoverageRatio: 0.75,
  degradedAuthoritativeCoverageRatio: 0.5,
} as const;

// --- Yield health summary ---
export const STATUS_YIELD_HEALTH_THRESHOLDS = {
  safetyCoverageRatio: 0.75,
  supplementalMaxAgeSec: 6 * 3600,
  benchmarkMaxAgeSec: 48 * 3600,
  coverageAuditMaxAgeSec: 45 * 24 * 3600,
  sourceRiskCoverageRatio: 0.75,
} as const;

// --- Telegram lifecycle snapshot cadence ---
/**
 * Worker cadence (seconds) for refreshing the Telegram current-lifecycle snapshot.
 * Source of truth for the producer (worker/src/lib/telegram-usage-analytics.ts) and the
 * status UI's "snapshot stale" badge, so the threshold cannot drift between the two.
 */
export const TELEGRAM_LIFECYCLE_SNAPSHOT_REFRESH_SECONDS = 15 * 60;

// --- Discovery scan ---
