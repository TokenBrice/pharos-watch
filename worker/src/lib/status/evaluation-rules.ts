import {
  STATUS_BLACKLIST_THRESHOLDS,
  STATUS_MISSING_PRICE_THRESHOLDS,
  STATUS_RESERVE_COMPOSITION_THRESHOLDS,
  STATUS_REVIEW_EXPIRY_REMINDER_WINDOW_SEC,
  assessActivePriceGapDuration,
  getCacheRatioThresholds,
  getStablecoinPublicationImpactStatus,
} from "@shared/lib/status-thresholds";
import { getCacheFreshnessRatio, getCacheFreshnessStatus } from "@shared/lib/cache-health";
import { CACHE_FRESHNESS_LANES } from "@shared/lib/api-freshness";
import { formatPercentFromRatio } from "@shared/lib/format";
import type { DataQuality, StatusCause, StatusResponse } from "@shared/types/status";
import type { PublicHealthAssessment } from "../public-health-assessment";
import type { StatusLevel } from "../status-reliability-shared";
import type { OnchainDataQualityAssessment } from "./onchain-data-quality";
import { getSourceFailureMessage } from "./section-errors";
import { maxStatus } from "./evaluation-state";

const STATUS_SEVERITY: Record<StatusLevel, number> = {
  healthy: 0,
  degraded: 1,
  stale: 2,
};

const STATUS_RESERVE_HIGH_DEFERRED_RATIO = 0.25;

// Dataset-level publication budget for the DEX liquidity cache (one missed
// four-hour scoring runway). This is the cache's endpoint freshness budget from
// the shared lane descriptor — deliberately distinct from the per-row
// `DEX_FRESHNESS_SEC` admission window that gates individual `dex_prices`
// rows for depeg logic.
const DEX_DATASET_ENDPOINT_MAX_AGE_SEC = CACHE_FRESHNESS_LANES.dexLiquidity.endpointMaxAgeSec;

// The DEX→DEWS dependency cause fires once the DEX liquidity cache is more than this many
// availability budgets behind, with DEWS already outside its own published band.
const DEWS_DOWNSTREAM_DEX_RATIO_GATE = 2;

export interface ReserveCompositionAssessment {
  bootstrap: boolean;
  status: Exclude<StatusResponse["reserveComposition"]["status"], "unavailable">;
  freshCoverageRatio: number;
  authoritativeFreshCoverageRatio: number;
}

export function evaluateReserveCompositionStatus(
  reserveComposition: Exclude<StatusResponse["reserveComposition"], { status: "unavailable" }>,
): ReserveCompositionAssessment {
  const configured = reserveComposition.healthConfiguredCoins ?? reserveComposition.configuredCoins;
  const fresh = reserveComposition.healthFreshCoins ?? reserveComposition.freshCoins;
  const bootstrap = configured > 0 && reserveComposition.lastSuccessAt == null
    && (reserveComposition.acknowledgedFeedIds?.length ?? 0) === 0;
  const authoritativeFreshCoins = reserveComposition.healthAuthoritativeFreshCoins ??
    (reserveComposition.independentFreshEligible
      + reserveComposition.independentFreshUnverified + reserveComposition.staticValidatedFresh);
  const freshCoverageRatio = configured > 0 ? fresh / configured : reserveComposition.configuredCoins > 0 ? 1 : 0;
  const authoritativeFreshCoverageRatio = configured > 0 ? authoritativeFreshCoins / configured : reserveComposition.configuredCoins > 0 ? 1 : 0;
  const hasPersistentlyStaleIndependentFeeds = (reserveComposition.unacknowledgedPersistentlyStaleIndependentCoins
    ?? reserveComposition.persistentlyStaleIndependentCoins).length > 0;
  const deferredShare =
    reserveComposition.configuredCoins > 0 ? reserveComposition.deferredCoins / reserveComposition.configuredCoins : 0;
  const hasUncertainWrites = reserveComposition.writeTimeoutUncertain > 0;
  const hasMaterialDeferredTail =
    reserveComposition.runBudgetTruncated && deferredShare >= STATUS_RESERVE_HIGH_DEFERRED_RATIO;
  const hasReserveCapacityPressure = hasUncertainWrites || hasMaterialDeferredTail;
  const status: StatusResponse["reserveComposition"]["status"] =
    hasReserveCapacityPressure
      ? "degraded"
      : bootstrap || configured === 0
        ? "healthy"
        : fresh === 0
        ? "stale"
        : freshCoverageRatio < STATUS_RESERVE_COMPOSITION_THRESHOLDS.degradedFreshCoverageRatio
            || authoritativeFreshCoverageRatio < STATUS_RESERVE_COMPOSITION_THRESHOLDS.degradedAuthoritativeCoverageRatio
            || hasPersistentlyStaleIndependentFeeds
            || hasReserveCapacityPressure
          ? "degraded"
          : "healthy";

  return { bootstrap, status, freshCoverageRatio, authoritativeFreshCoverageRatio };
}

export interface StatusRuleEvaluation {
  status: StatusLevel;
  causes: StatusCause[];
}

export type StatusRule<Input> = (input: Input) => Partial<StatusRuleEvaluation> | null;

function evaluateStatusRuleSet<Input>(
  input: Input,
  rules: readonly StatusRule<Input>[],
  initialStatus: StatusLevel = "healthy",
): StatusRuleEvaluation {
  let status = initialStatus;
  const causes: StatusCause[] = [];

  for (const rule of rules) {
    const result = rule(input);
    if (result == null) continue;
    if (result.status != null && STATUS_SEVERITY[result.status] > STATUS_SEVERITY[status]) {
      status = result.status;
    }
    if (result.causes != null) causes.push(...result.causes);
  }

  return { status, causes };
}

type CauseDetails = Pick<StatusCause, "metric" | "value" | "threshold">;

function makeCause(
  layer: StatusCause["layer"],
  code: string,
  severity: StatusCause["severity"],
  message: string,
  details: CauseDetails = {},
): StatusCause {
  return withRunbook({ code, layer, severity, message, ...details });
}

export interface AvailabilityEvaluationInput {
  publicHealth: PublicHealthAssessment;
  availabilityImpactingCronErrors: number;
  availabilityImpactingUnhealthyCrons: number;
  availabilityImpactingConsecutiveCronErrors: number;
  watchUnhealthyCrons: number;
  degradedCronRuns: number;
  cronErrorCount: number;
  cronHistoryQueryFailed: boolean;
  cronProgressQueryFailed: boolean;
  cronLeaseQueryFailed: boolean;
}

export interface DataQualityEvaluationInput {
  nowSec: number;
  dataQuality: DataQuality;
  repairRunnerAutoRepairCount: number | null;
  reserveCompositionQueryFailed: boolean;
  missingPriceRatio: number;
  blacklistMissingRatio: number;
  blacklistRecentMissing: number;
  onchainAssessment: OnchainDataQualityAssessment;
  reserveCompositionStatus: StatusResponse["reserveComposition"]["status"];
  activePriceCoverageImpactStatus: PublicHealthAssessment["activePriceCoverageImpactStatus"];
  activePriceCoverage: PublicHealthAssessment["activePriceCoverage"];
  onchainAssessmentCauses: StatusCause[];
  reserveComposition: StatusResponse["reserveComposition"];
}

function ruleResult(status: StatusLevel, causes: StatusCause[] = []): Partial<StatusRuleEvaluation> | null {
  return status === "healthy" && causes.length === 0 ? null : { status, causes };
}

function expiringReviews(entries: readonly { id: string; expiresAt: number }[], nowSec: number) {
  return entries
    .map((entry) => ({ ...entry, remainingSec: entry.expiresAt - nowSec }))
    .filter((entry) => entry.remainingSec > 0 && entry.remainingSec <= STATUS_REVIEW_EXPIRY_REMINDER_WINDOW_SEC)
    .sort((a, b) => a.expiresAt - b.expiresAt || a.id.localeCompare(b.id));
}

function evaluateCacheDiagnostics(input: AvailabilityEvaluationInput): Partial<StatusRuleEvaluation> | null {
  if (input.publicHealth.cacheFailures.length === 0) return null;
  const cacheTargets = input.publicHealth.cacheFailures
    .map((failure) => {
      const diagnostic = input.publicHealth.cacheDiagnostics.find((entry) => entry.key === failure.key);
      return diagnostic ? `${failure.key} via ${diagnostic.freshnessSource}` : failure.key;
    })
    .join(", ");
  return ruleResult("healthy", [
    makeCause("availability", "cache_freshness_query_failed", "info", `Cache freshness diagnostics were incomplete for: ${cacheTargets}.`),
  ]);
}

function evaluateFxDiagnostics(input: AvailabilityEvaluationInput): Partial<StatusRuleEvaluation> | null {
  const fxCache = input.publicHealth.caches["fx-rates"];
  if (!fxCache) return null;
  const causes: StatusCause[] = [];
  if (fxCache.mode === "cached-fallback") {
    causes.push(
      makeCause(
        "availability",
        "fx_cached_fallback",
        fxCache.consecutiveFallbackRuns != null && fxCache.consecutiveFallbackRuns >= 4 ? "warning" : "info",
        fxCache.warning ?? `FX references are running in cached fallback mode (${fxCache.consecutiveFallbackRuns ?? 0} consecutive runs).`,
        { metric: "fxFallbackRuns", value: fxCache.consecutiveFallbackRuns, threshold: 4 },
      ),
    );
  }
  if (fxCache.sourceStatus === "stale") {
    causes.push(
      makeCause(
        "availability",
        "fx_source_stale",
        "critical",
        fxCache.warning ??
          "Non-USD FX reference source data is stale relative to its expected source cadence even though usable FX rates still exist.",
        { metric: "fxSourceAgeSeconds", value: fxCache.sourceAgeSeconds ?? undefined },
      ),
    );
  } else if (fxCache.sourceStatus === "degraded") {
    causes.push(
      makeCause(
        "availability",
        "fx_source_degraded",
        "warning",
        fxCache.warning ?? "Non-USD FX reference source data is behind its expected update cadence.",
        { metric: "fxSourceAgeSeconds", value: fxCache.sourceAgeSeconds ?? undefined },
      ),
    );
  }
  return ruleResult("healthy", causes);
}

function evaluateCacheWarnings(input: AvailabilityEvaluationInput): Partial<StatusRuleEvaluation> | null {
  if (input.publicHealth.cacheWarnings.length === 0) return null;
  return ruleResult(
    "healthy",
    input.publicHealth.cacheWarnings.map((message) => makeCause("availability", "cache_warning", "info", message)),
  );
}

function evaluateDexDiagnostics(input: AvailabilityEvaluationInput): Partial<StatusRuleEvaluation> | null {
  const dexLiquidityCache = input.publicHealth.caches["dex-liquidity"];
  const dewsCache = input.publicHealth.caches.dews;
  const causes: StatusCause[] = [];
  if (dexLiquidityCache?.ageSeconds != null && dexLiquidityCache.ageSeconds > DEX_DATASET_ENDPOINT_MAX_AGE_SEC) {
    causes.push(
      makeCause(
        "availability",
        "dex_pricing_bridge_stale",
        "warning",
        "The published DEX liquidity dataset has exceeded its endpoint freshness budget of one missed four-hour scoring runway. Individual DEX price observations use a separate trust window.",
        { metric: "dexLiquidityAgeSeconds", value: dexLiquidityCache.ageSeconds, threshold: DEX_DATASET_ENDPOINT_MAX_AGE_SEC },
      ),
    );
  }
  const dexLiquidityRatio = dexLiquidityCache != null ? getCacheFreshnessRatio(dexLiquidityCache) : null;
  if (
    dexLiquidityCache &&
    dewsCache &&
    !dewsCache.healthy &&
    dexLiquidityRatio != null &&
    dexLiquidityRatio > DEWS_DOWNSTREAM_DEX_RATIO_GATE
  ) {
    causes.push(
      makeCause(
        "availability",
        "dews_downstream_of_dex_liquidity",
        "warning",
        "DEWS freshness is downstream of DEX liquidity; the DEX liquidity dataset is more than twice its availability budget behind and DEWS is unhealthy, so investigate sync-dex-liquidity first.",
        {
          metric: "dexLiquidityAgeSeconds",
          value: dexLiquidityCache.ageSeconds ?? undefined,
          threshold: dexLiquidityCache.maxAge * DEWS_DOWNSTREAM_DEX_RATIO_GATE,
        },
      ),
    );
  }
  return ruleResult("healthy", causes);
}

function evaluateCircuitStatus(input: AvailabilityEvaluationInput): Partial<StatusRuleEvaluation> | null {
  const status = input.publicHealth.circuitQueryError == null ? input.publicHealth.circuitImpactStatus : "healthy";
  const causes: StatusCause[] = [];
  if (input.publicHealth.circuitQueryError) {
    causes.push(makeCause("availability", "circuit_query_failed", "info", "Circuit breaker diagnostics failed; availability details may be incomplete."));
  } else if (input.publicHealth.openCircuitCount >= 3) {
    causes.push(
      makeCause(
        "availability",
        "open_circuit_groups",
        "warning",
        `${input.publicHealth.openCircuitCount} circuit breaker groups are currently open.`,
        { metric: "openCircuits", value: input.publicHealth.openCircuitCount, threshold: 3 },
      ),
    );
  }
  return ruleResult(status, causes);
}

function evaluateD1Status(input: AvailabilityEvaluationInput): Partial<StatusRuleEvaluation> | null {
  const status = input.publicHealth.d1CapacityImpactStatus;
  let cause: StatusCause | null = null;
  if (input.publicHealth.d1CapacityQueryError) {
    cause = makeCause("availability", "d1_capacity_query_failed", "info", "D1 capacity diagnostics are temporarily unavailable.");
  } else {
    const capacity = input.publicHealth.d1Capacity;
    if (capacity && capacity.thresholdState !== "normal") {
      const exhaustion =
        capacity.daysUntilExhaustion == null
          ? "Exhaustion forecast is not yet available."
          : `Projected exhaustion is ${capacity.daysUntilExhaustion} days away.`;
      cause = makeCause(
        "availability",
        `d1_capacity_${capacity.thresholdState}`,
        capacity.thresholdState === "critical" ? "critical" : "warning",
        `D1 database utilization is ${capacity.utilizationPercent}% (${capacity.thresholdState}). ${exhaustion}`,
        { metric: "d1CapacityUtilizationPercent", value: capacity.utilizationPercent, threshold: capacity.crossedThresholdPercent ?? 60 },
      );
    }
  }
  return ruleResult(status, cause ? [cause] : []);
}

type CronDiagnosticsInput = Pick<
  AvailabilityEvaluationInput,
  "cronHistoryQueryFailed" | "cronProgressQueryFailed" | "cronLeaseQueryFailed"
>;
type WatchCronErrorsInput = Pick<
  AvailabilityEvaluationInput,
  "cronErrorCount" | "availabilityImpactingCronErrors"
>;
type WatchTailInput = Pick<
  AvailabilityEvaluationInput,
  "watchUnhealthyCrons" | "degradedCronRuns"
>;

function evaluateCronDiagnosticQueries(input: CronDiagnosticsInput): Partial<StatusRuleEvaluation> | null {
  const causes: StatusCause[] = [];
  if (input.cronHistoryQueryFailed) causes.push(makeCause("availability", "cron_history_query_failed", "info", "Cron history query failed; cron health is temporarily unknown rather than unhealthy."));
  if (input.cronProgressQueryFailed) causes.push(makeCause("availability", "cron_progress_query_failed", "info", "Cron progress query failed; in-flight cron telemetry is temporarily unavailable."));
  if (input.cronLeaseQueryFailed) causes.push(makeCause("availability", "cron_lease_query_failed", "info", "Cron lease query failed; orphan-progress and expired-lease detection are temporarily unavailable."));
  return ruleResult("healthy", causes);
}

function evaluateWatchCronErrors(input: WatchCronErrorsInput): Partial<StatusRuleEvaluation> | null {
  const watchCronErrors = Math.max(0, input.cronErrorCount - input.availabilityImpactingCronErrors);
  return watchCronErrors > 0
    ? ruleResult("healthy", [makeCause("availability", "watch_cron_error_runs", "info", `${watchCronErrors} watch-tier cron job(s) currently have last-run status=error.`, { metric: "watchCronErrors", value: watchCronErrors, threshold: 1 })])
    : null;
}

function evaluateWatchTailDiagnostics(input: WatchTailInput): Partial<StatusRuleEvaluation> | null {
  const causes: StatusCause[] = [];
  if (input.watchUnhealthyCrons > 0) {
    causes.push(makeCause("availability", "watch_unhealthy_crons_present", "info", `${input.watchUnhealthyCrons} watch-tier cron job(s) are unavailable/stale.`, { metric: "watchUnhealthyCrons", value: input.watchUnhealthyCrons, threshold: 1 }));
  }
  if (input.degradedCronRuns > 0) {
    causes.push(makeCause("availability", "degraded_cron_warning", "info", `${input.degradedCronRuns} cron job(s) report incomplete work or output quality warnings.`, { metric: "degradedCrons", value: input.degradedCronRuns, threshold: 1 }));
  }
  return ruleResult("healthy", causes);
}

/**
 * Informational availability causes whose numbers come straight from the cron
 * health read. `/api/status` rebuilds `crons` and `summary` from a live
 * `loadCronHealth` call while serving the cached raw assessment, so these
 * causes must be re-derived from that same read — otherwise one response can
 * claim "N cron job(s) are in fallback/degraded mode" (cached) next to
 * `summary.degradedCrons` (live) with different values (R5: one authority).
 */
const CRON_DERIVED_AVAILABILITY_CAUSE_CODES = [
  "cron_history_query_failed",
  "cron_progress_query_failed",
  "cron_lease_query_failed",
  "watch_cron_error_runs",
  "watch_unhealthy_crons_present",
  "degraded_cron_warning",
] as const;

export type CronDerivedAvailabilityCauseInputs = CronDiagnosticsInput & WatchCronErrorsInput & WatchTailInput;

export function rebuildCronDerivedAvailabilityCauses(
  availabilityCauses: StatusCause[],
  input: CronDerivedAvailabilityCauseInputs,
): StatusCause[] {
  const cronDerivedCodes: readonly string[] = CRON_DERIVED_AVAILABILITY_CAUSE_CODES;
  const liveCauses = [
    evaluateCronDiagnosticQueries(input),
    evaluateWatchCronErrors(input),
    evaluateWatchTailDiagnostics(input),
  ].flatMap((rule) => rule?.causes ?? []);
  return [
    ...availabilityCauses.filter((cause) => !cronDerivedCodes.includes(cause.code)),
    ...liveCauses,
  ];
}

export function evaluateSchedulerLiveness(scheduler: PublicHealthAssessment["schedulerLiveness"]): StatusRuleEvaluation {
  const causes: StatusCause[] = [];
  let status: StatusLevel = "healthy";
  if (scheduler.status !== "healthy") {
    const unavailable = scheduler.status === "unavailable";
    status = scheduler.status === "unavailable" ? "degraded" : scheduler.status;
    causes.push(makeCause(
      "availability", unavailable ? "scheduler_liveness_unavailable" : "scheduled_delivery_stalled",
      status === "stale" ? "critical" : "warning",
      unavailable ? `Scheduler delivery evidence unavailable (${scheduler.unavailableReason}; warning >${scheduler.warningAfterSec}s; stale >${scheduler.staleAfterSec}s).`
        : `No five-minute lane has started for ${scheduler.ageSeconds}s (warning >${scheduler.warningAfterSec}s; stale >${scheduler.staleAfterSec}s).`,
      { metric: "schedulerDeliveryAgeSeconds", value: scheduler.ageSeconds ?? undefined, threshold: scheduler.warningAfterSec },
    ));
  }
  const heavy = scheduler.heavy;
  if (heavy.status !== "healthy") {
    const unavailable = heavy.status === "unavailable";
    const heavyStatus: StatusLevel = heavy.status === "unavailable" ? "degraded" : heavy.status;
    status = maxStatus(status, heavyStatus);
    causes.push(makeCause(
      "availability", unavailable ? "heavy_scheduler_liveness_unavailable" : "heavy_scheduled_delivery_stalled",
      heavyStatus === "stale" ? "critical" : "warning",
      unavailable ? `Heavy scheduler delivery evidence unavailable (${heavy.unavailableReason}; warning >${heavy.warningAfterSec}s; stale >${heavy.staleAfterSec}s).`
        : `Heavy lane ${heavy.scheduleKey} has not started for ${heavy.ageSeconds}s (warning >${heavy.warningAfterSec}s; stale >${heavy.staleAfterSec}s).`,
      { metric: "heavySchedulerDeliveryAgeSeconds", value: heavy.ageSeconds ?? undefined, threshold: heavy.warningAfterSec },
    ));
  }
  return { status, causes };
}

const AVAILABILITY_STATUS_RULES: readonly StatusRule<AvailabilityEvaluationInput>[] = [
  (input) => input.publicHealth.schedulerLiveness ? evaluateSchedulerLiveness(input.publicHealth.schedulerLiveness) : null,
  (input) => {
      const status = input.publicHealth.cacheImpactStatus;
      const unavailableCauses: StatusCause[] = [];
      let worstCacheBreach:
        | { key: string; ratio: number; thresholds: ReturnType<typeof getCacheRatioThresholds>; tier: "degraded" | "stale" }
        | null = null;
      for (const [key, cache] of Object.entries(input.publicHealth.caches)) {
        const tier = getCacheFreshnessStatus(cache, key);
        if (tier === "healthy") continue;
        const ratio = getCacheFreshnessRatio(cache);
        if (ratio == null) {
          unavailableCauses.push(makeCause(
            "availability", "cache_freshness_unavailable", "critical",
            `Cache freshness unavailable (${key}: ${cache.timestampReason ?? cache.warning ?? "missing-timestamp"}).`,
          ));
          continue;
        }
        if (
          worstCacheBreach == null
          || (tier === "stale" && worstCacheBreach.tier === "degraded")
          || (tier === worstCacheBreach.tier && ratio > worstCacheBreach.ratio)
        ) {
          worstCacheBreach = { key, ratio, thresholds: getCacheRatioThresholds(key), tier };
        }
      }
      if (status === "healthy" && worstCacheBreach == null && unavailableCauses.length === 0) return null;
      const cause = worstCacheBreach
        ? makeCause(
            "availability",
            worstCacheBreach.tier === "stale" ? "cache_ratio_stale" : "cache_ratio_degraded",
            worstCacheBreach.tier === "stale" ? "critical" : "warning",
            `Cache freshness exceeded ${worstCacheBreach.tier} threshold (${worstCacheBreach.key} at ${worstCacheBreach.ratio.toFixed(2)}x > ` +
              `${worstCacheBreach.thresholds[worstCacheBreach.tier].toFixed(2)}x).`,
            { metric: "worstCacheRatio", value: worstCacheBreach.ratio, threshold: worstCacheBreach.thresholds[worstCacheBreach.tier] },
          )
        : null;
      return ruleResult(status, [...unavailableCauses, ...(cause ? [cause] : [])]);
  },
  evaluateCacheDiagnostics,
  evaluateFxDiagnostics,
  evaluateCacheWarnings,
  evaluateDexDiagnostics,
  (input) => {
    const status = !input.publicHealth.mintBurnQueryError && !input.publicHealth.mintBurnBootstrap
      ? input.publicHealth.mintBurnImpactStatus
      : "healthy";
    let cause: StatusCause | null = null;
    if (input.publicHealth.mintBurnQueryError) {
      cause = makeCause(
        "availability",
        "mint_burn_health_query_failed",
        "info",
        "Mint/burn health query failed; diagnostics are temporarily unavailable. " +
          `Latest critical cron run status: ${input.publicHealth.mintBurnLastRunStatus ?? "unknown"}.`,
      );
    } else if (!input.publicHealth.mintBurnBootstrap && input.publicHealth.mintBurnImpactStatus !== "healthy") {
      cause = makeCause(
        "availability",
        input.publicHealth.mintBurnImpactStatus === "stale" ? "mint_burn_public_stale" : "mint_burn_public_degraded",
        input.publicHealth.mintBurnImpactStatus === "stale" ? "critical" : "warning",
        input.publicHealth.mintBurn.sync.warning ??
          `Mint/burn public freshness is ${input.publicHealth.mintBurnImpactStatus} versus the critical-lane cadence.`,
      );
    }
    return ruleResult(status, cause ? [cause] : []);
  },
  evaluateCircuitStatus,
  evaluateD1Status,
  evaluateCronDiagnosticQueries,
  (input) => {
      const stale = input.availabilityImpactingConsecutiveCronErrors > 0;
      const degraded = input.availabilityImpactingCronErrors > 0;
      if (!stale && !degraded) return null;
      const cause = makeCause(
        "availability",
        "cron_error_runs",
        stale ? "critical" : "warning",
        stale
          ? `${input.availabilityImpactingConsecutiveCronErrors} availability-impacting cron job(s) have 2+ consecutive failed runs.`
          : `${input.availabilityImpactingCronErrors} availability-impacting cron job(s) had a single transient failed run.`,
        { metric: "availabilityImpactingCronErrors", value: input.availabilityImpactingCronErrors, threshold: 1 },
      );
      return ruleResult(stale ? "stale" : "degraded", [cause]);
  },
  evaluateWatchCronErrors,
  (input) => {
      const status = input.availabilityImpactingUnhealthyCrons >= 2 ? "stale" : input.availabilityImpactingUnhealthyCrons > 0 ? "degraded" : null;
      if (status == null) return null;
      const cause = makeCause(
        "availability",
        input.availabilityImpactingUnhealthyCrons >= 2 ? "multiple_unhealthy_crons" : "unhealthy_crons_present",
        input.availabilityImpactingUnhealthyCrons >= 2 ? "critical" : "warning",
        input.availabilityImpactingUnhealthyCrons >= 2
          ? `${input.availabilityImpactingUnhealthyCrons} availability-impacting cron jobs are unavailable/stale.`
          : `${input.availabilityImpactingUnhealthyCrons} availability-impacting cron job(s) are unavailable/stale.`,
        {
          metric: "availabilityImpactingUnhealthyCrons",
          value: input.availabilityImpactingUnhealthyCrons,
          threshold: input.availabilityImpactingUnhealthyCrons >= 2 ? 2 : 1,
        },
      );
      return ruleResult(status, cause ? [cause] : []);
  },
  evaluateWatchTailDiagnostics,
];

function evaluateDataSourceFailures(input: DataQualityEvaluationInput): Partial<StatusRuleEvaluation> | null {
  const causes = input.dataQuality.sourceFailures
    .filter((failure) => failure.source !== "stablecoins-cache")
    .map((failure) =>
      makeCause(
        "data-quality",
        failure.source === "blacklist-gaps"
          ? "blacklist_gap_query_failed"
          : failure.source === "active-depegs"
            ? "active_depeg_query_failed"
            : "onchain_supply_query_failed",
        "info",
        getSourceFailureMessage(failure.source),
      ),
    );
  return ruleResult("healthy", causes);
}

function evaluateReserveQueryFailure(input: DataQualityEvaluationInput): Partial<StatusRuleEvaluation> | null {
  if (!input.reserveCompositionQueryFailed && input.reserveComposition.status !== "unavailable") return null;
  return ruleResult("degraded", [
    makeCause(
      "data-quality",
      "reserve_sync_query_failed",
      "warning",
      "Live reserve composition overview query failed; reserve freshness status may be incomplete.",
    ),
  ]);
}

function evaluateRepairDiagnostics(input: DataQualityEvaluationInput): Partial<StatusRuleEvaluation> | null {
  const causes: StatusCause[] = [];
  if (input.repairRunnerAutoRepairCount != null && input.repairRunnerAutoRepairCount > 0) {
    causes.push(
      makeCause(
        "data-quality",
        "ddr_auto_repair_count",
        "info",
        `The most recent DDR repair runner execution auto-repaired ${input.repairRunnerAutoRepairCount} task(s).`,
        { metric: "autoRepairCount", value: input.repairRunnerAutoRepairCount },
      ),
    );
  }
  if (input.dataQuality.ddrRepairDebtStatus === "present" && input.dataQuality.ddrRepairDebtCount > 0) {
    causes.push(
      makeCause(
        "data-quality",
        "ddr_repair_debt_present",
        "warning",
        `${input.dataQuality.ddrRepairDebtCount} DDR source event(s) are quarantined pending explicit repair migration.`,
        { metric: "ddrRepairDebtCount", value: input.dataQuality.ddrRepairDebtCount, threshold: 1 },
      ),
    );
  } else if (input.dataQuality.ddrRepairDebtStatus === "unknown") {
    causes.push(makeCause("data-quality", "ddr_repair_debt_unknown", "info", "DDR repair-debt task data could not be read; repair backlog status is unknown."));
  }
  return ruleResult("healthy", causes);
}

function evaluateReserveOperationalDiagnostics(input: DataQualityEvaluationInput): Partial<StatusRuleEvaluation> | null {
  const reserve = input.reserveComposition;
  if (reserve.status === "unavailable") return null;
  const causes: StatusCause[] = [];
  if (reserve.writeTimeoutUncertain > 0) {
    causes.push(
      makeCause(
        "data-quality",
        "reserve_sync_write_uncertain",
        "warning",
        `${reserve.writeTimeoutUncertain} live reserve coin(s) have uncertain D1 write outcomes; operators should wait for a clean follow-up run or inspect reserve_sync_state.`,
        { metric: "reserveWriteTimeoutUncertain", value: reserve.writeTimeoutUncertain, threshold: 1 },
      ),
    );
  }
  if (reserve.runBudgetTruncated) {
    const deferredRatio = reserve.configuredCoins > 0 ? reserve.deferredCoins / reserve.configuredCoins : 0;
    const pressureReasons = [
      deferredRatio >= STATUS_RESERVE_HIGH_DEFERRED_RATIO ? `high deferred share ${formatPercentFromRatio(deferredRatio)}` : null,
    ].filter((entry): entry is string => entry != null);
    causes.push(
      makeCause(
        "data-quality",
        "reserve_sync_budget_truncated",
        "warning",
        `Latest live reserve run deferred ${reserve.deferredCoins} coin(s)` +
          (reserve.nextCursorStablecoinId ? `; next cursor ${reserve.nextCursorStablecoinId}` : "") +
          (pressureReasons.length > 0 ? ` (${pressureReasons.join(", ")}).` : "."),
        { metric: "reserveDeferredRatio", value: deferredRatio, threshold: STATUS_RESERVE_HIGH_DEFERRED_RATIO },
      ),
    );
  }
  return ruleResult("healthy", causes);
}

const DATA_QUALITY_STATUS_RULES_CORE: readonly StatusRule<DataQualityEvaluationInput>[] = [
  (input) => {
      const status = input.dataQuality.stablecoinsCacheStatus === "error" ? "stale" : input.dataQuality.stablecoinsCacheStatus === "degraded" ? "degraded" : "healthy";
      if (status === "healthy") return null;
      const cause = makeCause(
        "data-quality",
        status === "stale" ? "stablecoins_cache_unavailable" : "stablecoins_cache_degraded",
        status === "stale" ? "critical" : "warning",
        `Stablecoins cache is ${status === "stale" ? "unavailable" : "degraded"} (${input.dataQuality.stablecoinsCacheReason ?? "unknown"}).`,
      );
      return ruleResult(status, [cause]);
  },
  (input) => {
      const publication = input.dataQuality.stablecoinPublication;
      if (publication == null || publication.status === "complete") return null;
      const status = getStablecoinPublicationImpactStatus(publication, input.activePriceCoverage, input.nowSec);
      const cause = publication.status === "incomplete"
        ? (() => {
            const missing = publication.missingActiveIds;
            const examples = missing.slice(0, 12).join(", ");
            return makeCause(
              "data-quality",
              "stablecoin_publication_incomplete",
              status === "healthy" ? "info" : "warning",
              `Stablecoin publication is missing ${missing.length} unwaived active ID(s)` +
                (examples ? `: ${examples}${missing.length > 12 ? ", ..." : ""}.` : "."),
              { metric: "missingActiveStablecoins", value: missing.length, threshold: 1 },
            );
          })()
        : makeCause("data-quality", "stablecoin_publication_unknown", "warning", "Exact stablecoin publication coverage evidence is unavailable.");
      return ruleResult(status, [cause]);
  },
  (input) => {
      const coverage = input.activePriceCoverage;
      const causes: StatusCause[] = [];
      if (coverage.nominalReferenceCount != null && coverage.nominalReferenceCount > 0) {
        causes.push(makeCause(
          "data-quality",
          "active_price_coverage_nominal_reference",
          "info",
          `Reviewed nominal references, not observed market prices, cover: ${(coverage.nominalReferenceIds ?? []).join(", ")}. These are not missing-price gaps.`,
          { metric: "nominalReferenceCount", value: coverage.nominalReferenceCount },
        ));
      }
      if (coverage.status === "incomplete") {
        const acknowledgedIds = new Set(coverage.acknowledgedGapIds ?? []);
        const alertIds = coverage.alertEligibleIds.filter((id) => !acknowledgedIds.has(id));
        const reviewed = coverage.missingActiveAssets.flatMap((asset) => asset.acknowledgedGap
          ? [`${asset.stablecoinId} until ${new Date(asset.acknowledgedGap.expiresAt * 1000).toISOString().slice(0, 10)}`]
          : []);
        const acknowledgement = reviewed.length > 0
          ? ` ${reviewed.length} acknowledged gap(s) under review: ${reviewed.join("; ")}.`
          : "";
        const baseMessage = `Live prices are missing for ${coverage.missingPriceCount ?? "an unknown number of"} active asset(s).${acknowledgement}`;
        const notAlerting = reviewed.length > 0
          ? " Every missing gap is either acknowledged under review or below the alert-eligible persistence threshold"
          : " No gap has reached the alert-eligible persistence threshold";
        causes.push(makeCause(
          "data-quality",
          "active_price_coverage_incomplete",
          alertIds.length > 0 ? "warning" : "info",
          alertIds.length > 0
            ? `${baseMessage} Alert-eligible (unacknowledged) gaps: ${alertIds.join(", ")}.`
            : `${baseMessage}${notAlerting}; not degrading public status.`,
          { metric: "missingActivePrices", value: coverage.missingPriceCount ?? undefined, threshold: 1 },
        ));
        // A duration-driven degradation opens a public uptime incident, so it
        // gets its own allowlisted cause; the generic incomplete-coverage
        // warning above stays admin-only.
        const gapDuration = assessActivePriceGapDuration(coverage, input.nowSec);
        if (gapDuration.status !== "healthy") {
          causes.push(makeCause(
            "data-quality",
            "active_price_coverage_duration_degraded",
            "warning",
            gapDuration.worstGenerations == null
              ? `Live-price gap continuity is unavailable; conservatively retaining a warning for: ${gapDuration.degradedGapIds.join(", ")}.`
              : `Persistent live-price gap(s) have outlived the duration budget (${gapDuration.worstGenerations} consecutive missing generations, threshold ${STATUS_MISSING_PRICE_THRESHOLDS.generationsElevated}): ${gapDuration.degradedGapIds.join(", ")}. Each requires catalog review to re-source the price or retire the listing.`,
            { metric: "missingPriceDurationGenerations", value: gapDuration.worstGenerations ?? undefined, threshold: STATUS_MISSING_PRICE_THRESHOLDS.generationsElevated },
          ));
        }
      } else if (coverage.status === "unknown") {
        causes.push(makeCause("data-quality", "active_price_coverage_unknown", "warning", "Exact active stablecoin live-price coverage evidence is unavailable."));
      }
      for (const [kind, ids] of [
        ["expired", coverage.expiredGapReviewIds ?? []],
        ["invalid", coverage.invalidGapReviewIds ?? []],
      ] as const) {
        if (ids.length > 0) causes.push(makeCause(
          "data-quality",
          `price_gap_reviews_${kind}`,
          "info",
          `Ignored ${kind} price-gap review(s): ${ids.join(", ")}. Re-review before renewal; these entries cannot acknowledge a missing price.`,
          { metric: `${kind}GapReviews`, value: ids.length, threshold: 1 },
        ));
      }
      const expiring = expiringReviews(coverage.missingActiveAssets.flatMap((asset) => asset.acknowledgedGap
        ? [{ id: asset.stablecoinId, expiresAt: asset.acknowledgedGap.expiresAt }]
        : []), input.nowSec);
      if (expiring.length > 0) causes.push(makeCause(
        "data-quality",
        "price_gap_reviews_expiring",
        "info",
        `Price-gap review(s) currently acknowledging a missing price expire within 48h: ${expiring.map((review) =>
          `${review.id} (expires ${new Date(review.expiresAt * 1000).toISOString()}, ${Math.floor(review.remainingSec / 3600)}h left)`).join(", ")}. Renew with fresh evidence or let the gap re-alert; expiry re-arms alerts automatically.`,
        { metric: "priceGapReviewsExpiringSoonestSec", value: expiring[0].remainingSec, threshold: STATUS_REVIEW_EXPIRY_REMINDER_WINDOW_SEC },
      ));
      return ruleResult(input.activePriceCoverageImpactStatus, causes);
  },
  (input) => {
      if (input.missingPriceRatio > STATUS_MISSING_PRICE_THRESHOLDS.ratioStale) {
        return ruleResult("stale", [makeCause(
          "data-quality",
          "missing_prices_stale",
          "critical",
          `Missing price ratio is stale (${formatPercentFromRatio(input.missingPriceRatio)} > ${formatPercentFromRatio(STATUS_MISSING_PRICE_THRESHOLDS.ratioStale)}).`,
          { metric: "missingPriceRatio", value: input.missingPriceRatio, threshold: STATUS_MISSING_PRICE_THRESHOLDS.ratioStale },
        )]);
      }
      if (input.missingPriceRatio > STATUS_MISSING_PRICE_THRESHOLDS.ratioDegraded) {
        return ruleResult("degraded", [makeCause(
          "data-quality",
          "missing_prices_degraded",
          "warning",
          `Missing price ratio is degraded (${formatPercentFromRatio(input.missingPriceRatio)} > ${formatPercentFromRatio(STATUS_MISSING_PRICE_THRESHOLDS.ratioDegraded)}).`,
          { metric: "missingPriceRatio", value: input.missingPriceRatio, threshold: STATUS_MISSING_PRICE_THRESHOLDS.ratioDegraded },
        )]);
      }
      if (input.missingPriceRatio >= STATUS_MISSING_PRICE_THRESHOLDS.ratioElevated) {
        return ruleResult("healthy", [makeCause(
          "data-quality",
          "missing_prices_elevated",
          "info",
          `Missing price ratio is elevated (${formatPercentFromRatio(input.missingPriceRatio)} ≥ ${formatPercentFromRatio(STATUS_MISSING_PRICE_THRESHOLDS.ratioElevated)}); not degrading status but worth watching.`,
          { metric: "missingPriceRatio", value: input.missingPriceRatio, threshold: STATUS_MISSING_PRICE_THRESHOLDS.ratioElevated },
        )]);
      }
      return null;
  },
  (input) => {
      const detail = `ratio=${formatPercentFromRatio(input.blacklistMissingRatio)}, recent=${input.blacklistRecentMissing}`;
      if (input.blacklistMissingRatio >= STATUS_BLACKLIST_THRESHOLDS.missingRatioStale) {
        return ruleResult("stale", [makeCause(
          "data-quality",
          "blacklist_gaps_stale",
          "critical",
          `Blacklist amount gaps exceed stale thresholds (${detail}).`,
          { metric: "blacklistMissingRatio", value: input.blacklistMissingRatio, threshold: STATUS_BLACKLIST_THRESHOLDS.missingRatioStale },
        )]);
      }
      if (input.blacklistMissingRatio >= STATUS_BLACKLIST_THRESHOLDS.missingRatioDegraded) {
        return ruleResult("degraded", [makeCause(
          "data-quality",
          "blacklist_gaps_degraded",
          "warning",
          `Elevated blacklist amount gaps detected (${detail}).`,
          { metric: "blacklistMissingRatio", value: input.blacklistMissingRatio, threshold: STATUS_BLACKLIST_THRESHOLDS.missingRatioDegraded },
        )]);
      }
      // A recent burst below the material share is amount recovery in progress,
      // not a degraded data surface: keep it visible without degrading status.
      if (input.blacklistRecentMissing >= STATUS_BLACKLIST_THRESHOLDS.missingRecentWatch) {
        return ruleResult("healthy", [makeCause(
          "data-quality",
          "blacklist_gaps_recent",
          "info",
          `Recent blacklist events are awaiting amount recovery (${detail}); below the degrading share.`,
          { metric: "blacklistRecentMissing", value: input.blacklistRecentMissing, threshold: STATUS_BLACKLIST_THRESHOLDS.missingRecentWatch },
        )]);
      }
      return null;
  },
  (input) => {
      const status = input.onchainAssessment.status;
      const causes = input.onchainAssessmentCauses.map(withRunbook);
      return status === "healthy" && causes.length === 0 ? null : { status, causes };
  },
  (input) => {
      const reserve = input.reserveComposition;
      if (reserve.status === "unavailable") return null; // The failed-read rule supplies the degrading cause.
      const status = reserve.status;
      if (status === "healthy") return null;
      const unacknowledged = reserve.unacknowledgedPersistentlyStaleIndependentCoins
        ?? reserve.persistentlyStaleIndependentCoins;
      const persistent = unacknowledged.length > 0
        ? ` Unacknowledged: ${formatPersistentStaleIndependentFeeds(unacknowledged)}.`
        : "";
      const runTail = reserve.runBudgetTruncated
        ? ` Last run was truncated by budget with ${reserve.deferredCoins} deferred coin(s)${reserve.nextCursorStablecoinId ? `; next cursor ${reserve.nextCursorStablecoinId}` : ""}.`
        : "";
      const uncertain = reserve.writeTimeoutUncertain > 0
        ? ` ${reserve.writeTimeoutUncertain} coin(s) have uncertain D1 write outcomes.`
        : "";
      const message = status === "stale"
        ? "All configured live reserve feeds are missing, stale, or degraded." + persistent + runTail + uncertain
        : `Live reserve coverage is degraded (${formatPercentFromRatio(reserve.freshCoverageRatio)} fresh, ${formatPercentFromRatio(reserve.authoritativeFreshCoverageRatio)} authoritative). ` +
          `${reserve.errorCoins} error, ${reserve.missingCoins} missing, ${reserve.staleCoins} stale, ${reserve.degradedCoins} degraded, ${reserve.corruptCoins} corrupt live reserve feed(s).` +
          persistent + runTail + uncertain;
      return ruleResult(status, [makeCause("data-quality", status === "stale" ? "reserve_sync_stale" : "reserve_sync_degraded", status === "stale" ? "critical" : "warning", message)]);
  },
];

const DATA_QUALITY_STATUS_RULES: readonly StatusRule<DataQualityEvaluationInput>[] = [
  DATA_QUALITY_STATUS_RULES_CORE[0],
  DATA_QUALITY_STATUS_RULES_CORE[1],
  DATA_QUALITY_STATUS_RULES_CORE[2],
  evaluateDataSourceFailures,
  evaluateReserveQueryFailure,
  evaluateRepairDiagnostics,
  DATA_QUALITY_STATUS_RULES_CORE[3],
  DATA_QUALITY_STATUS_RULES_CORE[4],
  DATA_QUALITY_STATUS_RULES_CORE[5],
  evaluateReserveOperationalDiagnostics,
  (input) => {
    const reserve = input.reserveComposition;
    if (reserve.status === "unavailable") return null;
    const causes: StatusCause[] = [];
    if (reserve.acknowledgedFeeds?.length) causes.push(makeCause(
      "data-quality", "reserve_feed_reviews_acknowledged", "info",
      `Reviewed health exclusions: ${reserve.acknowledgedFeeds.map((review) =>
        `${review.stablecoinId} (expires ${new Date(review.expiresAt * 1000).toISOString()})`).join(", ")}. Raw evidence remains quarantined.`,
    ));
    for (const [ids, code, label] of [
      [reserve.expiredFeedReviewIds, "reserve_feed_reviews_expired", "Expired"],
      [reserve.invalidFeedReviewIds, "reserve_feed_reviews_invalid", "Invalid"],
    ] as const) {
      if (ids?.length) causes.push(makeCause("data-quality", code, "info", `${label} reserve feed reviews: ${ids.join(", ")}; health gates re-armed.`));
    }
    const expiring = expiringReviews((reserve.acknowledgedFeeds ?? []).map((review) => ({
      id: review.stablecoinId, expiresAt: review.expiresAt,
    })), input.nowSec);
    if (expiring.length > 0) causes.push(makeCause(
      "data-quality",
      "reserve_feed_reviews_expiring",
      "info",
      `Reserve-feed review(s) currently acknowledging a stale or erroring feed expire within 48h: ${expiring.map((review) =>
        `${review.id} (expires ${new Date(review.expiresAt * 1000).toISOString()}, ${Math.floor(review.remainingSec / 3600)}h left)`).join(", ")}. Renew with fresh evidence or let the feed re-alert; expiry re-arms health gates automatically.`,
      { metric: "reserveFeedReviewsExpiringSoonestSec", value: expiring[0].remainingSec, threshold: STATUS_REVIEW_EXPIRY_REMINDER_WINDOW_SEC },
    ));
    return ruleResult("healthy", causes);
  },
  DATA_QUALITY_STATUS_RULES_CORE[6],
];

function formatPersistentStaleIndependentFeeds(
  coins: NonNullable<StatusResponse["reserveComposition"]["persistentlyStaleIndependentCoins"]>,
): string {
  const examples = coins
    .slice(0, 3)
    .map((coin) => coin.stablecoinId)
    .join(", ");
  const suffix = coins.length > 3 ? `, +${coins.length - 3} more` : "";
  return `${coins.length} persistently stale independent feed(s)${examples ? ` (${examples}${suffix})` : ""}`;
}

const RUNBOOK_BASE = "https://github.com/TokenBrice/pharos-watch/blob/main/docs/runbooks";

const RUNBOOK_BY_CODE: Record<string, string> = {
  scheduled_delivery_stalled: `${RUNBOOK_BASE}/cron-delivery-stall.md`,
  scheduler_liveness_unavailable: `${RUNBOOK_BASE}/cron-delivery-stall.md`,
  heavy_scheduled_delivery_stalled: `${RUNBOOK_BASE}/cron-delivery-stall.md`,
  heavy_scheduler_liveness_unavailable: `${RUNBOOK_BASE}/cron-delivery-stall.md`,
  db_unhealthy: `${RUNBOOK_BASE}/db-connectivity.md`,
  data_quality_skipped_db_unhealthy: `${RUNBOOK_BASE}/db-connectivity.md`,
  stablecoins_cache_unavailable: `${RUNBOOK_BASE}/stablecoins-cache.md`,
  stablecoins_cache_degraded: `${RUNBOOK_BASE}/stablecoins-cache.md`,
  stablecoin_publication_incomplete: `${RUNBOOK_BASE}/stablecoins-cache.md`,
  stablecoin_publication_unknown: `${RUNBOOK_BASE}/stablecoins-cache.md`,
  active_price_coverage_incomplete: `${RUNBOOK_BASE}/stablecoins-cache.md`,
  active_price_coverage_duration_degraded: `${RUNBOOK_BASE}/stablecoins-cache.md`,
  active_price_coverage_unknown: `${RUNBOOK_BASE}/stablecoins-cache.md`,
  price_gap_reviews_expiring: `${RUNBOOK_BASE}/review-renewal.md`,
  price_gap_reviews_expired: `${RUNBOOK_BASE}/review-renewal.md`,
  price_gap_reviews_invalid: `${RUNBOOK_BASE}/review-renewal.md`,
  reserve_feed_reviews_expiring: `${RUNBOOK_BASE}/review-renewal.md`,
  reserve_feed_reviews_expired: `${RUNBOOK_BASE}/review-renewal.md`,
  reserve_feed_reviews_invalid: `${RUNBOOK_BASE}/review-renewal.md`,
  blacklist_gaps_degraded: `${RUNBOOK_BASE}/blacklist-sync.md`,
  blacklist_gaps_recent: `${RUNBOOK_BASE}/blacklist-sync.md`,
  blacklist_gaps_stale: `${RUNBOOK_BASE}/blacklist-sync.md`,
  onchain_integrity_degraded: `${RUNBOOK_BASE}/mint-burn-integrity.md`,
  onchain_integrity_stale: `${RUNBOOK_BASE}/mint-burn-integrity.md`,
  onchain_monitor_unavailable: `${RUNBOOK_BASE}/mint-burn-integrity.md`,
  d1_capacity_watch: `${RUNBOOK_BASE}/d1-capacity-and-runtime-experiments.md`,
  d1_capacity_warning: `${RUNBOOK_BASE}/d1-capacity-and-runtime-experiments.md`,
  d1_capacity_critical: `${RUNBOOK_BASE}/d1-capacity-and-runtime-experiments.md`,
  d1_capacity_query_failed: `${RUNBOOK_BASE}/d1-capacity-and-runtime-experiments.md`,
};

/**
 * Merges the matching runbook URL into a cause when one is documented.
 * Returns the original cause if no runbook is registered for its code.
 */
export function withRunbook(cause: StatusCause): StatusCause {
  const runbookUrl = RUNBOOK_BY_CODE[cause.code];
  return runbookUrl ? { ...cause, runbookUrl } : cause;
}

export function evaluateAvailabilityStatus(input: AvailabilityEvaluationInput): StatusRuleEvaluation {
  return evaluateStatusRuleSet(input, AVAILABILITY_STATUS_RULES);
}

export function evaluateDataQualityStatus(input: DataQualityEvaluationInput): StatusRuleEvaluation {
  return evaluateStatusRuleSet(input, DATA_QUALITY_STATUS_RULES);
}
