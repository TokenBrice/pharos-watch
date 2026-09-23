import { CRON_INTERVALS } from "./cron-jobs";
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
/** Per-coin on-chain snapshot freshness ceiling. Two missed producer cycles contribute to the stale-snapshot count. */
export const STATUS_ONCHAIN_FRESH_WINDOW_SEC = 8 * 3600;
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
//
// Duration dimension added 2026-09-21 (holistic review LV01-05). The ratio bands
// answer "how much of the active set is unpriceable", so a handful of
// permanently unpriceable assets never trips them: nine of 335 active assets
// (2.7%) sat below `ratioElevated`, one of them with no accepted price for 5,957
// consecutive generations (~62 days) while its market cap kept publishing.
// `generations*` therefore count consecutive missing `sync-stablecoins`
// generations and escalate independently of the ratio. `generationsElevated` is
// one day at the current cadence, where a gap stops looking like a fetch hiccup;
// `generationsCritical` is a week, where re-pricing an asset is a catalog
// decision rather than a fetch gap to wait out.
/** One day of consecutive missing active-price generations at the live `sync-stablecoins` cadence (96 at 15 minutes). */
const MISSING_PRICE_GENERATIONS_PER_DAY = Math.round((24 * 3600) / CRON_INTERVALS["sync-stablecoins"]);

export const STATUS_MISSING_PRICE_THRESHOLDS = {
  ratioElevated: 0.15,
  ratioDegraded: 0.18,
  ratioStale: 0.45,
  generationsElevated: MISSING_PRICE_GENERATIONS_PER_DAY,
  generationsCritical: 7 * MISSING_PRICE_GENERATIONS_PER_DAY,
} as const;

/**
 * Gap *duration* for a single missing active price, in consecutive missing
 * generations. Deliberately independent of `missingPriceRatio`: coverage breadth
 * and gap persistence are different questions, and a small number of permanent
 * gaps never moves the ratio.
 */
export function getMissingPriceDurationStatus(consecutiveMissingGenerations: number): StatusHealthValue {
  if (consecutiveMissingGenerations >= STATUS_MISSING_PRICE_THRESHOLDS.generationsCritical) {
    return "stale";
  }
  if (consecutiveMissingGenerations >= STATUS_MISSING_PRICE_THRESHOLDS.generationsElevated) {
    return "degraded";
  }
  return "healthy";
}

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
 * `yield-data`: hourly producer (`sync-yield-data`, 3600s availability budget).
 * Under the global bands a lane can serve ~8h-stale rankings while public health
 * still reads "healthy", even though the admin endpoint-budget lane already flags
 * it at 1×. Ruling R3 (2026-07-19) tightens it to degrade after two missed hourly
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
 *
 * The ceiling is published beside the verdict as `healthyMaxRatio`/`healthyMaxAge`
 * on every cache-status object, so a boolean is never read without its band.
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
// Value-share bands, reviewed 2026-09-23: single-source long-tail rows are
// legitimate, not failed corroboration. The live all-peg-bucket snapshot had
// 40% of active rows at `high` but 96.95% of priced circulating USD value.
// 90/80% high-coverage floors and 1/5% low-exposure ceilings flag economically
// material confidence loss without catalog-size noise. Counts stay visible.
// See docs/status-dashboard.md#price-source-health-card for evidence and limits.
export const STATUS_PRICE_CONFIDENCE_BANDS = {
  /** Green when `high`-confidence rows carry at least this share of priced circulating value. */
  highMcapShareGreenPct: 90,
  /** Amber floor for the same share; below this the tile is red. */
  highMcapShareAmberPct: 80,
  /** `low`-confidence share of priced circulating value at or above which the tile is amber. */
  lowMcapShareAmberPct: 1,
  /** `low`-confidence share of priced circulating value at or above which the tile is red. */
  lowMcapShareRedPct: 5,
  /** Unacknowledged active missing-price count: 0 is green, up to this amber, above red. */
  missingCountAmber: 3,
} as const;

/** Visual severity for a Price Source Health metric tile. `neutral` = unknown/monitor-only. */
export type PriceConfidenceTileSeverity = "green" | "amber" | "red" | "neutral";

/** Classify the High-confidence tile from the `high` share of priced circulating value (percent). `null` when the payload lacks market-cap sums. */
export function getHighConfidenceTileSeverity(highMcapSharePct: number | null): PriceConfidenceTileSeverity {
  if (highMcapSharePct == null || !Number.isFinite(highMcapSharePct)) return "neutral";
  return highMcapSharePct >= STATUS_PRICE_CONFIDENCE_BANDS.highMcapShareGreenPct
    ? "green"
    : highMcapSharePct >= STATUS_PRICE_CONFIDENCE_BANDS.highMcapShareAmberPct
      ? "amber"
      : "red";
}

/** Classify the Low-confidence tile from the `low` share of priced circulating value (percent). `null` when the payload lacks market-cap sums. */
export function getLowConfidenceTileSeverity(lowMcapSharePct: number | null): PriceConfidenceTileSeverity {
  if (lowMcapSharePct == null || !Number.isFinite(lowMcapSharePct)) return "neutral";
  return lowMcapSharePct >= STATUS_PRICE_CONFIDENCE_BANDS.lowMcapShareRedPct
    ? "red"
    : lowMcapSharePct >= STATUS_PRICE_CONFIDENCE_BANDS.lowMcapShareAmberPct
      ? "amber"
      : "neutral";
}

/** Classify the Missing tile from the count of active missing prices that carry no valid, unexpired price-gap acknowledgement. */
export function getMissingPriceTileSeverity(unacknowledgedMissingCount: number): PriceConfidenceTileSeverity {
  if (!Number.isFinite(unacknowledgedMissingCount)) return "neutral";
  return unacknowledgedMissingCount === 0
    ? "green"
    : unacknowledgedMissingCount <= STATUS_PRICE_CONFIDENCE_BANDS.missingCountAmber
      ? "amber"
      : "red";
}

// --- CoinGecko comparison thresholds ---
/** Percent gap (Pharos vs CoinGecko) above which a coin's cross-source price is flagged as divergent. */
export const STATUS_COINGECKO_PRICE_DIFF_THRESHOLD_PCT = 5;

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

/** Reserve-sync fields the score-input hold predicate needs; structurally compatible with `StatusResponse["reserveComposition"]`. */
export interface ReserveScoreInputHoldInput {
  status: string;
  deferredCoins: number;
  runBudgetTruncated: boolean;
  writeTimeoutUncertain: number;
  authoritativeFreshCoverageRatio: number;
}

/**
 * Single shared predicate for "reserve evidence is forcing conservative score
 * inputs" — used by the Live Reserve Sync banner, the triage reserve notice,
 * and the Score impact monitor so one payload can never render contradictory
 * states. A hold exists only when the worker already deems the lane unhealthy
 * (`status !== "healthy"`, which itself covers fresh coverage below
 * `degradedFreshCoverageRatio`), when score-grade coverage drops below the
 * documented `degradedAuthoritativeCoverageRatio`, or when a deferred /
 * budget-truncated / write-uncertain tail is present. Coverage strictly below
 * 1.0 is NOT a hold: the documented thresholds tolerate partially conservative
 * inputs while the lane still reports healthy.
 */
export function hasReserveScoreInputHold(reserve: ReserveScoreInputHoldInput): boolean {
  return (
    reserve.status !== "healthy"
    || reserve.deferredCoins > 0
    || reserve.runBudgetTruncated
    || reserve.writeTimeoutUncertain > 0
    || reserve.authoritativeFreshCoverageRatio < STATUS_RESERVE_COMPOSITION_THRESHOLDS.degradedAuthoritativeCoverageRatio
  );
}

// --- Yield health summary ---
/**
 * Hard benchmark scoring TTL: a benchmark whose *fetch* age exceeds this bound
 * is stale and every row keyed to it publishes NR. Authoritative definition —
 * `worker/src/cron/yield-sync/benchmarks.ts` re-exports it as
 * `YIELD_BENCHMARK_SCORE_TTL_SEC` so the registry classifier and this legacy
 * health threshold cannot drift apart.
 */
export const YIELD_BENCHMARK_SCORE_TTL_SEC = 48 * 3600;
export const STATUS_YIELD_HEALTH_THRESHOLDS = {
  safetyCoverageRatio: 0.75,
  // 1.5x the supplemental producer cadence: tolerates one missed 4h run before
  // the retained family markers read stale.
  supplementalMaxAgeSec: CRON_INTERVALS["sync-yield-supplemental"] * 1.5,
  benchmarkMaxAgeSec: YIELD_BENCHMARK_SCORE_TTL_SEC,
  coverageAuditMaxAgeSec: 45 * 24 * 3600,
  sourceRiskCoverageRatio: 0.75,
} as const;

// --- Telegram lifecycle snapshot cadence ---
/**
 * Worker cadence (seconds) for refreshing the Telegram current-lifecycle snapshot.
 * Source of truth for the producer (worker/src/lib/telegram/usage-analytics.ts) and the
 * status UI's "snapshot stale" badge, so the threshold cannot drift between the two.
 */
export const TELEGRAM_LIFECYCLE_SNAPSHOT_REFRESH_SECONDS = 15 * 60;

// --- Discovery scan ---
