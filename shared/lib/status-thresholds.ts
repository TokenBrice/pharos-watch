import { CRON_INTERVALS } from "./cron-jobs";
import type { ActivePriceCoverageGap, ActivePriceCoverageHealth, StablecoinPublicationHealth, PublicationSurfaceHealth, StatusHealthOrUnknown, StatusHealthValue } from "../types/status";
import type { z } from "zod";
import type { FreshnessStatusSchema } from "@pharos/contracts/api-meta";

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
export type FreshnessStatus = z.output<typeof FreshnessStatusSchema>;

/** Admin-only pending-candidate budget; never changes publication acceptance or public health. */
export const STATUS_PUBLICATION_PENDING_MAX_AGE_SEC = 2 * 3600;

/** D7: full reserve cohort (producer plus consumers), ops-only, nearest-rank p95. */
export const STATUS_RESERVE_COHORT_SLO = {
  maxAgeSec: 30 * 60,
  windowSec: 7 * 24 * 3600,
  recoveryWindowSec: 24 * 3600,
} as const;

export function classifyPublicationDiagnostic(surface: PublicationSurfaceHealth | undefined): {
  status: StatusHealthOrUnknown;
  reason: string | null;
  maxAgeSec: number | null;
  updatedAt: number | null;
} {
  if (!surface) return { status: "unknown", reason: "Publication health surface unavailable.", maxAgeSec: null, updatedAt: null };
  const published = surface.lastPublishedGeneration;
  const attempt = surface.lastAttemptedGeneration;
  if (!published) return { status: "stale", reason: "No published generation recorded.", maxAgeSec: null, updatedAt: attempt?.startedAt ?? null };
  if ((attempt?.state === "failed" || attempt?.state === "rejected") && attempt.startedAt > published.startedAt) {
    return {
      status: "degraded",
      reason: attempt.failureReason ?? surface.lastFailureReason ?? `Latest generation ${attempt.state}.`,
      maxAgeSec: null,
      updatedAt: attempt.failedAt ?? attempt.startedAt,
    };
  }
  if (surface.candidateAgeSec != null && surface.candidateAgeSec > STATUS_PUBLICATION_PENDING_MAX_AGE_SEC) {
    return {
      status: "degraded",
      reason: `Candidate generation has been pending for ${surface.candidateAgeSec}s.`,
      maxAgeSec: STATUS_PUBLICATION_PENDING_MAX_AGE_SEC,
      updatedAt: attempt?.startedAt ?? null,
    };
  }
  return { status: "healthy", reason: null, maxAgeSec: null, updatedAt: published.publishedAt ?? published.validatedAt ?? published.startedAt };
}

// --- Blacklist gap thresholds ---
/** Rolling window (seconds) used to count "recent" missing blacklist amounts when classifying blacklist gap status. */
export const BLACKLIST_RECENT_WINDOW_SEC = 24 * 3600;
/** Catch-up window (seconds) in which queued EVM freezes await proof without degrading blacklist gap status. */
export const BLACKLIST_PROOF_CATCHUP_WINDOW_SEC = 72 * 3600;
/**
 * Ratios are fractions of total events (0.01 = 1%) and are the only inputs that
 * degrade status. Internal classification excludes queued recoverable_pending EVM
 * freezes within BLACKLIST_PROOF_CATCHUP_WINDOW_SEC from that share. Its watch
 * count includes gaps within BLACKLIST_RECENT_WINDOW_SEC and those awaiting proof;
 * `missingRecentWatch` alone never degrades status. Failed attempts, older freezes,
 * Tron and destroy events retain ordinary accounting. Public gap counts and ratios
 * retain all gaps and the ordinary recent window.
 */
export const STATUS_BLACKLIST_THRESHOLDS = {
  missingRatioDegraded: 0.01,
  missingRatioStale: 0.02,
  missingRecentWatch: 5,
} as const;

/** Classify blacklist coverage gaps by missing-amount share. Stale tier wins over degraded. */
export function getBlacklistGapStatus({ missingRatio }: { missingRatio: number | null }): StatusHealthValue {
  if (missingRatio == null) return "degraded";
  if (missingRatio >= STATUS_BLACKLIST_THRESHOLDS.missingRatioStale) return "stale";
  if (missingRatio >= STATUS_BLACKLIST_THRESHOLDS.missingRatioDegraded) return "degraded";
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
// Breadth below the stale band moved to the shared active-asset breadth
// threshold on 2026-10-21 (`getActivePriceCoverageBreadthStatus`): the 0.15
// elevated and 0.18 degraded ratios were retired so listings and prices use
// one number. `ratioStale` remains the critical band.
//
// Duration dimension added 2026-09-21 (holistic review LV01-05). The ratio bands
// answer "how much of the active set is unpriceable", so a handful of
// permanently unpriceable assets never trips them: nine of 335 active assets
// (2.7%) sat below the then-15% elevated ratio, one of them with no accepted price for 5,957
// consecutive generations (~62 days) while its market cap kept publishing.
// `generations*` therefore count consecutive missing `sync-stablecoins`
// generations and escalate independently of the ratio. `generationsElevated` is
// one day at the current cadence, where a gap stops looking like a fetch hiccup;
// `generationsCritical` is a week, where re-pricing an asset is a catalog
// decision rather than a fetch gap to wait out. Since 2026-10-21 duration only
// names gaps (warnings, Watch); it no longer degrades status for a single
// asset of any size: the owner retired the $1B materiality rule, so only the
// shared breadth threshold below degrades listings and prices.
/** One day of consecutive missing active-price generations at the live `sync-stablecoins` cadence (96 at 15 minutes). */
const MISSING_PRICE_GENERATIONS_PER_DAY = Math.round((24 * 3600) / CRON_INTERVALS["sync-stablecoins"]);

export const STATUS_MISSING_PRICE_THRESHOLDS = {
  ratioStale: 0.45,
  generationsElevated: MISSING_PRICE_GENERATIONS_PER_DAY,
  generationsCritical: 7 * MISSING_PRICE_GENERATIONS_PER_DAY,
} as const;

/**
 * Owner rule (2026-10-21): with ~400 tracked active assets, missing listings
 * and unavailable live prices stay asset-scoped notices until a material share
 * of the cohort is affected: 5% of the expected active cohort (the low end of
 * the owner's 5-10% guidance; 20 of 396). A pure share keeps a small cohort
 * from hiding broad loss behind an absolute floor. Below it, gaps of any
 * market cap stay named, operational Watch notices; the single-asset $1B
 * materiality rule was retired the same day, so this is the only count rule.
 */
export const STATUS_ACTIVE_ASSET_SERVICE_BREADTH_SHARE = 0.05;

/** Affected-asset count at which a listing or price gap becomes service-wide; null when the cohort size is unknown. */
export function getActiveAssetServiceBreadthThreshold(expectedActiveCount: number | null | undefined): number | null {
  if (expectedActiveCount == null || !Number.isFinite(expectedActiveCount) || expectedActiveCount <= 0) return null;
  return Math.ceil(expectedActiveCount * STATUS_ACTIVE_ASSET_SERVICE_BREADTH_SHARE);
}

function reachesActiveAssetServiceBreadth(affectedCount: number | null | undefined, expectedActiveCount: number | null | undefined): boolean {
  const threshold = getActiveAssetServiceBreadthThreshold(expectedActiveCount);
  return threshold == null || affectedCount == null || affectedCount >= threshold;
}

function exceedsPublicationServiceBreadth(
  publication: Pick<StablecoinPublicationHealth, "missingActiveIds" | "expectedActiveCount">,
): boolean {
  return reachesActiveAssetServiceBreadth(publication.missingActiveIds.length, publication.expectedActiveCount);
}

/**
 * Consecutive missing `sync-stablecoins` generations before an unpriced asset
 * counts toward price-coverage breadth (2026-10-23). Single-generation fetch
 * misses (5 of 12 gaps in the 2026-10-23 sample) flapped breadth across its
 * threshold every hour; a gap that persists into a second generation counts.
 */
export const STATUS_ACTIVE_PRICE_BREADTH_MIN_GENERATIONS = 2;

/**
 * Unpriced active assets that count toward breadth: gaps that persisted for
 * `STATUS_ACTIVE_PRICE_BREADTH_MIN_GENERATIONS`, or whose streak or detail
 * row is unknown (fail closed). Assets missing from the publication itself are excluded:
 * publication coverage already reports them (`publication-incomplete`), so one
 * gap is not counted twice. Null when the count is unavailable.
 */
type ActivePriceBreadthCoverage = Pick<ActivePriceCoverageHealth, "status" | "expectedActiveCount" | "missingPriceCount"> & {
  missingActiveAssets: readonly Pick<ActivePriceCoverageGap, "stablecoinId" | "consecutiveMissingGenerations">[];
};

export function countActivePriceBreadthGaps(
  coverage: Pick<ActivePriceBreadthCoverage, "missingPriceCount" | "missingActiveAssets">,
  publicationMissingIds: readonly string[] = [],
): number | null {
  if (coverage.missingPriceCount == null) return null;
  const publicationMissing = new Set(publicationMissingIds);
  const withoutDetail = Math.max(0, coverage.missingPriceCount - coverage.missingActiveAssets.length);
  return withoutDetail + coverage.missingActiveAssets.filter((asset) => !publicationMissing.has(asset.stablecoinId)
    && (asset.consecutiveMissingGenerations == null
      || asset.consecutiveMissingGenerations >= STATUS_ACTIVE_PRICE_BREADTH_MIN_GENERATIONS)).length;
}

/**
 * Unavailable live prices (every missing active price, reviewed or not: each is
 * unavailable to readers) degrade the service at the shared breadth threshold,
 * counted by `countActivePriceBreadthGaps`. Unknown coverage has its own
 * fail-closed path; only an incomplete payload is graded here, and missing
 * counts fail closed.
 */
export function getActivePriceCoverageBreadthStatus(
  coverage: ActivePriceBreadthCoverage,
  publicationMissingIds: readonly string[] = [],
): StatusHealthValue {
  if (coverage.status !== "incomplete") return "healthy";
  return reachesActiveAssetServiceBreadth(countActivePriceBreadthGaps(coverage, publicationMissingIds), coverage.expectedActiveCount)
    ? "degraded" : "healthy";
}

/** Producer evidence window for an absent row's retained market cap. The cap is
 * diagnostic payload only; since 2026-10-21 no status verdict reads it. */
export const STATUS_LAST_KNOWN_MARKET_CAP_MAX_AGE_SEC = 30 * 24 * 3600;

/** Whether a gap already carries a current cap or dated, in-window retained cap evidence. */
export function hasActivePriceGapMarketCapEvidence(
  asset: Pick<ActivePriceCoverageGap, "marketCapUsd" | "lastKnownMarketCapUsd" | "lastKnownMarketCapObservedAt">,
  nowSec: number,
): boolean {
  if (asset.marketCapUsd != null && Number.isFinite(asset.marketCapUsd) && asset.marketCapUsd >= 0) return true;
  const cap = asset.lastKnownMarketCapUsd;
  const observedAt = asset.lastKnownMarketCapObservedAt;
  return cap != null && Number.isFinite(cap) && cap >= 0
    && observedAt != null && Number.isFinite(observedAt) && observedAt > 0
    && observedAt <= nowSec && nowSec - observedAt <= STATUS_LAST_KNOWN_MARKET_CAP_MAX_AGE_SEC;
}

/**
 * Listing omissions degrade the service only when unverifiable (unknown
 * coverage or an unnamed count mismatch) or at the shared breadth threshold.
 * Named omissions below it are operational notices of any market cap. The
 * listings component and service-wide verdict share this one result.
 */
export function getStablecoinPublicationImpactStatus(
  publication: Pick<StablecoinPublicationHealth, "status" | "missingActiveIds" | "expectedActiveCount">,
): StatusHealthValue {
  if (publication.status === "complete") return "healthy";
  return publication.status === "unknown" || publication.missingActiveIds.length === 0
    || exceedsPublicationServiceBreadth(publication) ? "degraded" : "healthy";
}

/**
 * Gap *duration* for a single missing active price, in consecutive missing
 * generations. Deliberately independent of coverage breadth: gap persistence is
 * a different question, and a small number of permanent gaps never moves it.
 * Duration names gaps for catalog follow-up; it never degrades status.
 */
export function getMissingPriceDurationStatus(consecutiveMissingGenerations: number | null): StatusHealthValue {
  // Unknown continuity cannot establish a critical duration, but must not clear a warning.
  if (consecutiveMissingGenerations == null) return "degraded";
  if (consecutiveMissingGenerations >= STATUS_MISSING_PRICE_THRESHOLDS.generationsCritical) {
    return "stale";
  }
  if (consecutiveMissingGenerations >= STATUS_MISSING_PRICE_THRESHOLDS.generationsElevated) {
    return "degraded";
  }
  return "healthy";
}

/** Unacknowledged alert-eligible gaps at the `critical` duration band (named in `/api/health` warnings). */
export function getCriticalDurationActivePriceGapIds(
  coverage: Pick<ActivePriceCoverageHealth, "missingActiveAssets" | "acknowledgedGapIds">,
): string[] {
  const acknowledgedGapIds = new Set(coverage.acknowledgedGapIds ?? []);
  return coverage.missingActiveAssets
    .filter((asset) => asset.alertEligible && !asset.acknowledgedGap && !acknowledgedGapIds.has(asset.stablecoinId)
      && getMissingPriceDurationStatus(asset.consecutiveMissingGenerations) === "stale")
    .map((asset) => asset.stablecoinId);
}

// --- Public producer grace (owner rule 2026-10-23) ---
/**
 * One public grace rule for producer-graded components (yield, Safety Scores,
 * mint/burn): age is graded against the producer interval, `delayed` past 3×,
 * `degraded` past 6×, and an outage past 12× (the degraded band times
 * `PUBLIC_COMPONENT_OUTAGE_GRACE_MULTIPLIER`). Two missed runs stay
 * operational. Every verdict publishes its budget (R3); this is the single
 * authority for those multiples (R5).
 */
export const STATUS_PUBLIC_PRODUCER_GRACE_RATIOS = {
  delayed: 3,
  degraded: 6,
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
 * `yield-data`: two-hourly producer (`sync-yield-data`, 7200s availability
 * budget, equal to the producer interval). Under the global bands a lane can serve
 * ~16h-stale rankings while public health still reads "healthy", even though the
 * admin endpoint-budget lane already flags it at 1×. Since 2026-10-23 it follows
 * the one public producer grace rule (`STATUS_PUBLIC_PRODUCER_GRACE_RATIOS`):
 * public-unhealthy (Delayed) past 3× and stale (Degraded) past 6×, so a single
 * missed or abandoned two-hourly run stays healthy. The 2026-07-19 2×/4× bands let
 * one abandoned run read Delayed. See docs/architecture.md ADR-9 and
 * docs/status-dashboard.md.
 */
export const STATUS_CACHE_RATIO_OVERRIDES: Record<string, { degraded: number; stale: number }> = {
  "yield-data": {
    degraded: STATUS_PUBLIC_PRODUCER_GRACE_RATIOS.delayed,
    stale: STATUS_PUBLIC_PRODUCER_GRACE_RATIOS.degraded,
  },
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

// --- Probe classification thresholds (self-check probe runs) ---
// Self-check judges the second-slowest connectivity sample (the only sample when
// just one ran), so one cold probe cannot breach a band. The reported p95 is a
// separate diagnostic and is not what these bands classify.
export const STATUS_PROBE_THRESHOLDS = {
  /** Judged latency (ms) at or below which probes are classified healthy (given fail cap). */
  healthyLatencyMaxMs: 5000,
  /** Judged latency (ms) at or below which probes are classified degraded (given fail ratio cap). */
  degradedLatencyMaxMs: 8000,
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

/** Reviews suppress only matched operational health gates, never evidence admission. */
export const RESERVE_FEED_REVIEW_MAX_AGE_SEC = 14 * 24 * 3600;

// --- Reserve adapter alert thresholds ---
/**
 * Single authority for the reserve post-sync alert predicates. One cycle is one
 * `sync-live-reserves` attempt for a configured coin.
 * - `failureSustainedCycles`: consecutive failed cycles (`error`, or a
 *   `circuit-open` skip that withheld the attempt) before
 *   `reserve-adapter-failure-sustained` raises. A success resets the streak.
 * - `sourceClockStalledCycles`: consecutive successful (`ok`/`degraded`)
 *   verified attempts that must report the same `sourceTimestamp` before the
 *   stall is judged. The age of that frozen clock is then compared with the
 *   coin/adapter source-age budget from `resolveLiveReserveSourceAgeBudget`,
 *   never with a second copy of that budget.
 * Both alerts are transition-only: raise once at the threshold, recover once
 * when the condition clears. A matching `reserve-feed-reviews` acknowledgement
 * suppresses a new raise for the exact failure only.
 */
export const STATUS_RESERVE_ADAPTER_ALERT_THRESHOLDS = {
  failureSustainedCycles: 3,
  sourceClockStalledCycles: 2,
} as const;

/** Reminder lead time before a currently acknowledging review lapses (price-gap and reserve-feed lanes). */
export const STATUS_REVIEW_EXPIRY_REMINDER_WINDOW_SEC = 48 * 3600;

export const STATUS_SCHEDULER_LIVENESS_THRESHOLDS = {
  warningAfterSec: 600,
  staleAfterSec: 1200,
} as const;

/** Heavy delivery: warn after two missed 15-minute slots; stale after three. */
export const STATUS_HEAVY_SCHEDULER_LIVENESS_THRESHOLDS = {
  warningAfterSec: 1800,
  staleAfterSec: 2700,
} as const;

/** Reserve-sync fields the score-input hold predicate needs; structurally compatible with `StatusResponse["reserveComposition"]`. */
export interface ReserveScoreInputHoldInput {
  status: string;
  deferredCoins: number | null;
  runBudgetTruncated: boolean | null;
  writeTimeoutUncertain: number | null;
  authoritativeFreshCoverageRatio: number | null;
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
    || reserve.deferredCoins == null
    || reserve.deferredCoins > 0
    || reserve.runBudgetTruncated == null
    || reserve.runBudgetTruncated
    || reserve.writeTimeoutUncertain == null
    || reserve.writeTimeoutUncertain > 0
    || reserve.authoritativeFreshCoverageRatio == null
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
 * Source of truth for the producer (worker/src/telegram/store/usage-analytics.ts) and the
 * status UI's "snapshot stale" badge, so the threshold cannot drift between the two.
 */
export const TELEGRAM_LIFECYCLE_SNAPSHOT_REFRESH_SECONDS = 15 * 60;

// --- Discovery scan ---
