import {
  STATUS_BLACKLIST_THRESHOLDS,
  STATUS_MISSING_PRICE_THRESHOLDS,
  STATUS_RESERVE_COMPOSITION_THRESHOLDS,
  getCacheRatioThresholds,
} from "@shared/lib/status-thresholds";
import { getCacheFreshnessRatio, getCacheFreshnessStatus } from "@shared/lib/cache-health";
import { DEX_FRESHNESS_SEC } from "@shared/lib/depeg-config";
import { formatPercentFromRatio } from "@shared/lib/format";
import type { DataQuality, StatusCause, StatusResponse } from "@shared/types/status";
import type { PublicHealthAssessment } from "../public-health-assessment";
import type { StatusLevel } from "../status-reliability";
import type { OnchainDataQualityAssessment } from "./onchain-data-quality";
import { getSourceFailureMessage } from "./section-errors";

const STATUS_SEVERITY: Record<StatusLevel, number> = {
  healthy: 0,
  degraded: 1,
  stale: 2,
};

export const STATUS_RESERVE_HIGH_DEFERRED_RATIO = 0.25;
export const STATUS_RESERVE_REPEATED_TRUNCATION_COUNT = 2;

export interface ReserveCompositionAssessment {
  bootstrap: boolean;
  status: StatusResponse["reserveComposition"]["status"];
  freshCoverageRatio: number;
  authoritativeFreshCoverageRatio: number;
}

export function evaluateReserveCompositionStatus(
  reserveComposition: StatusResponse["reserveComposition"],
): ReserveCompositionAssessment {
  const bootstrap = reserveComposition.configuredCoins > 0 && reserveComposition.lastSuccessAt == null;
  const authoritativeFreshCoins =
    reserveComposition.independentFreshEligible
    + reserveComposition.independentFreshUnverified
    + reserveComposition.staticValidatedFresh;
  const freshCoverageRatio =
    reserveComposition.configuredCoins > 0 ? reserveComposition.freshCoins / reserveComposition.configuredCoins : 0;
  const authoritativeFreshCoverageRatio =
    reserveComposition.configuredCoins > 0 ? authoritativeFreshCoins / reserveComposition.configuredCoins : 0;
  const hasPersistentlyStaleIndependentFeeds = reserveComposition.persistentlyStaleIndependentCoins.length > 0;
  const deferredShare =
    reserveComposition.configuredCoins > 0 ? reserveComposition.deferredCoins / reserveComposition.configuredCoins : 0;
  const hasUncertainWrites = reserveComposition.writeTimeoutUncertain > 0;
  const hasIncompleteCursorTail =
    reserveComposition.cursorTailState === "recording" || reserveComposition.cursorTailState === "incomplete";
  const hasRepeatedTruncation =
    reserveComposition.runBudgetTruncationCount >= STATUS_RESERVE_REPEATED_TRUNCATION_COUNT;
  const hasMaterialDeferredTail =
    reserveComposition.runBudgetTruncated && deferredShare >= STATUS_RESERVE_HIGH_DEFERRED_RATIO;
  const hasReserveCapacityPressure =
    hasUncertainWrites || hasIncompleteCursorTail || hasRepeatedTruncation || hasMaterialDeferredTail;
  const status: StatusResponse["reserveComposition"]["status"] =
    bootstrap || reserveComposition.configuredCoins === 0
      ? "healthy"
      : reserveComposition.freshCoins === 0
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

export function evaluateStatusRuleSet<Input>(
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

export interface AvailabilityStatusInput {
  publicHealth: PublicHealthAssessment;
  availabilityImpactingCronErrors: number;
  availabilityImpactingUnhealthyCrons: number;
  availabilityImpactingConsecutiveCronErrors: number;
}

export interface AvailabilityEvaluationInput extends AvailabilityStatusInput {
  watchUnhealthyCrons: number;
  degradedCronRuns: number;
  cronErrorCount: number;
  cronHistoryQueryFailed: boolean;
  cronProgressQueryFailed: boolean;
  cronLeaseQueryFailed: boolean;
}

type AvailabilityRuleInput = AvailabilityStatusInput | AvailabilityEvaluationInput;

interface DataQualityRuleInput {
  dataQuality: DataQuality;
  repairRunnerAutoRepairCount?: number | null;
  reserveCompositionQueryFailed?: boolean;
  missingPriceRatio: number;
  blacklistMissingRatio: number;
  blacklistRecentMissing: number;
  onchainAssessment: OnchainDataQualityAssessment;
  reserveCompositionStatus: StatusResponse["reserveComposition"]["status"];
  activePriceCoverageImpactStatus: PublicHealthAssessment["activePriceCoverageImpactStatus"];
  activePriceCoverage?: PublicHealthAssessment["activePriceCoverage"];
  onchainAssessmentCauses?: StatusCause[];
  reserveComposition?: StatusResponse["reserveComposition"];
}

export type DataQualityStatusInput = DataQualityRuleInput;

export interface DataQualityCauseInput {
  dataQuality: DataQuality;
  onchainAssessment?: OnchainDataQualityAssessment;
  repairRunnerAutoRepairCount?: number | null;
  activePriceCoverage: PublicHealthAssessment["activePriceCoverage"];
  missingPriceRatio: number;
  blacklistMissingRatio: number;
  blacklistRecentMissing: number;
  onchainAssessmentCauses: StatusCause[];
  reserveCompositionQueryFailed: boolean;
  reserveComposition: StatusResponse["reserveComposition"];
}

export interface DataQualityEvaluationInput extends DataQualityCauseInput {
  onchainAssessment: OnchainDataQualityAssessment;
  reserveCompositionStatus: StatusResponse["reserveComposition"]["status"];
  activePriceCoverageImpactStatus: PublicHealthAssessment["activePriceCoverageImpactStatus"];
}

type FullDataQualityRuleInput = DataQualityRuleInput &
  Required<Pick<DataQualityRuleInput, "activePriceCoverage" | "onchainAssessmentCauses" | "reserveComposition">>;

function isFullDataQualityRuleInput(input: DataQualityRuleInput): input is FullDataQualityRuleInput {
  return input.activePriceCoverage != null && input.onchainAssessmentCauses != null && input.reserveComposition != null;
}

function isAvailabilityEvaluationInput(input: AvailabilityRuleInput): input is AvailabilityEvaluationInput {
  return "watchUnhealthyCrons" in input;
}

function ruleResult(status: StatusLevel, causes: StatusCause[] = []): Partial<StatusRuleEvaluation> | null {
  return status === "healthy" && causes.length === 0 ? null : { status, causes };
}

function evaluateCacheDiagnostics(input: AvailabilityRuleInput): Partial<StatusRuleEvaluation> | null {
  if (!isAvailabilityEvaluationInput(input) || input.publicHealth.cacheFailures.length === 0) return null;
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

function evaluateFxDiagnostics(input: AvailabilityRuleInput): Partial<StatusRuleEvaluation> | null {
  if (!isAvailabilityEvaluationInput(input)) return null;
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

function evaluateCacheWarnings(input: AvailabilityRuleInput): Partial<StatusRuleEvaluation> | null {
  if (!isAvailabilityEvaluationInput(input) || input.publicHealth.cacheWarnings.length === 0) return null;
  return ruleResult(
    "healthy",
    input.publicHealth.cacheWarnings.map((message) => makeCause("availability", "cache_warning", "info", message)),
  );
}

function evaluateDexDiagnostics(input: AvailabilityRuleInput): Partial<StatusRuleEvaluation> | null {
  if (!isAvailabilityEvaluationInput(input)) return null;
  const dexLiquidityCache = input.publicHealth.caches["dex-liquidity"];
  const dewsCache = input.publicHealth.caches.dews;
  const causes: StatusCause[] = [];
  if (dexLiquidityCache?.ageSeconds != null && dexLiquidityCache.ageSeconds > DEX_FRESHNESS_SEC) {
    causes.push(
      makeCause(
        "availability",
        "dex_pricing_bridge_stale",
        "warning",
        "DEX liquidity remains available for public display, but DEX prices exceed the 75-minute live-pricing admission window; promoted DEX sources and pool challenges are no longer receiving fresh observations.",
        { metric: "dexPriceAgeSeconds", value: dexLiquidityCache.ageSeconds, threshold: DEX_FRESHNESS_SEC },
      ),
    );
  }
  if (dexLiquidityCache && dewsCache && !dexLiquidityCache.healthy && !dewsCache.healthy) {
    causes.push(
      makeCause(
        "availability",
        "dews_downstream_of_dex_liquidity",
        dexLiquidityCache.ageSeconds != null && dexLiquidityCache.ageSeconds > dexLiquidityCache.maxAge ? "warning" : "info",
        "DEWS freshness is downstream of DEX liquidity; both lanes are unhealthy, so investigate sync-dex-liquidity first.",
        { metric: "dexLiquidityAgeSeconds", value: dexLiquidityCache.ageSeconds ?? undefined, threshold: dexLiquidityCache.maxAge },
      ),
    );
  }
  return ruleResult("healthy", causes);
}

function evaluateCircuitStatus(input: AvailabilityRuleInput): Partial<StatusRuleEvaluation> | null {
  const status = input.publicHealth.circuitQueryError == null ? input.publicHealth.circuitImpactStatus : "healthy";
  const causes: StatusCause[] = [];
  if (isAvailabilityEvaluationInput(input)) {
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
  }
  return ruleResult(status, causes);
}

function evaluateD1Status(input: AvailabilityRuleInput): Partial<StatusRuleEvaluation> | null {
  const status = input.publicHealth.d1CapacityImpactStatus;
  let cause: StatusCause | null = null;
  if (isAvailabilityEvaluationInput(input)) {
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
  }
  return ruleResult(status, cause ? [cause] : []);
}

function evaluateCronDiagnosticQueries(input: AvailabilityRuleInput): Partial<StatusRuleEvaluation> | null {
  if (!isAvailabilityEvaluationInput(input)) return null;
  const causes: StatusCause[] = [];
  if (input.cronHistoryQueryFailed) causes.push(makeCause("availability", "cron_history_query_failed", "info", "Cron history query failed; cron health is temporarily unknown rather than unhealthy."));
  if (input.cronProgressQueryFailed) causes.push(makeCause("availability", "cron_progress_query_failed", "info", "Cron progress query failed; in-flight cron telemetry is temporarily unavailable."));
  if (input.cronLeaseQueryFailed) causes.push(makeCause("availability", "cron_lease_query_failed", "info", "Cron lease query failed; orphan-progress and expired-lease detection are temporarily unavailable."));
  return ruleResult("healthy", causes);
}

function evaluateWatchCronErrors(input: AvailabilityRuleInput): Partial<StatusRuleEvaluation> | null {
  if (!isAvailabilityEvaluationInput(input)) return null;
  const watchCronErrors = Math.max(0, input.cronErrorCount - input.availabilityImpactingCronErrors);
  return watchCronErrors > 0
    ? ruleResult("healthy", [makeCause("availability", "watch_cron_error_runs", "info", `${watchCronErrors} watch-tier cron job(s) currently have last-run status=error.`, { metric: "watchCronErrors", value: watchCronErrors, threshold: 1 })])
    : null;
}

function evaluateWatchTailDiagnostics(input: AvailabilityRuleInput): Partial<StatusRuleEvaluation> | null {
  if (!isAvailabilityEvaluationInput(input)) return null;
  const causes: StatusCause[] = [];
  if (input.watchUnhealthyCrons > 0) {
    causes.push(makeCause("availability", "watch_unhealthy_crons_present", "info", `${input.watchUnhealthyCrons} watch-tier cron job(s) are unavailable/stale.`, { metric: "watchUnhealthyCrons", value: input.watchUnhealthyCrons, threshold: 1 }));
  }
  if (input.degradedCronRuns > 0) {
    causes.push(makeCause("availability", "degraded_cron_warning", "info", `${input.degradedCronRuns} cron job(s) are in fallback/degraded mode (warning-only).`, { metric: "degradedCrons", value: input.degradedCronRuns, threshold: 1 }));
  }
  return ruleResult("healthy", causes);
}

const AVAILABILITY_STATUS_RULES: readonly StatusRule<AvailabilityRuleInput>[] = [
  (input) => {
      const status = input.publicHealth.cacheImpactStatus;
      const worstCacheRatio = input.publicHealth.worstCacheRatio;
      let worstCacheBreach:
        | { key: string; ratio: number; thresholds: ReturnType<typeof getCacheRatioThresholds>; tier: "degraded" | "stale" }
        | null = null;
      for (const [key, cache] of Object.entries(input.publicHealth.caches)) {
        const tier = getCacheFreshnessStatus(cache, key);
        if (tier === "healthy") continue;
        const ratio = getCacheFreshnessRatio(cache) ?? worstCacheRatio;
        if (worstCacheBreach == null || (tier === "stale" && worstCacheBreach.tier === "degraded")) {
          worstCacheBreach = { key, ratio, thresholds: getCacheRatioThresholds(key), tier };
        }
      }
      if (status === "healthy" && worstCacheBreach == null) return null;
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
      return ruleResult(status, cause ? [cause] : []);
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
    if (isAvailabilityEvaluationInput(input)) {
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
    }
    return ruleResult(status, cause ? [cause] : []);
  },
  evaluateCircuitStatus,
  (input) => ruleResult(input.publicHealth.alertBrokerImpactStatus),
  evaluateD1Status,
  evaluateCronDiagnosticQueries,
  (input) => {
      const stale = input.availabilityImpactingConsecutiveCronErrors > 0;
      const degraded = input.availabilityImpactingCronErrors > 0;
      if (!stale && !degraded) return null;
      const cause =
        isAvailabilityEvaluationInput(input) && input.availabilityImpactingCronErrors > 0
          ? makeCause(
              "availability",
              "cron_error_runs",
              stale ? "critical" : "warning",
              stale
                ? `${input.availabilityImpactingConsecutiveCronErrors} availability-impacting cron job(s) have 2+ consecutive failed runs.`
                : `${input.availabilityImpactingCronErrors} availability-impacting cron job(s) had a single transient failed run.`,
              { metric: "availabilityImpactingCronErrors", value: input.availabilityImpactingCronErrors, threshold: 1 },
            )
          : null;
      return ruleResult(stale ? "stale" : "degraded", cause ? [cause] : []);
  },
  evaluateWatchCronErrors,
  (input) => {
      const status = input.availabilityImpactingUnhealthyCrons >= 2 ? "stale" : input.availabilityImpactingUnhealthyCrons > 0 ? "degraded" : null;
      if (status == null) return null;
      const cause = isAvailabilityEvaluationInput(input)
        ? makeCause(
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
          )
        : null;
      return ruleResult(status, cause ? [cause] : []);
  },
  evaluateWatchTailDiagnostics,
];

function evaluateDataSourceFailures(input: DataQualityRuleInput): Partial<StatusRuleEvaluation> | null {
  if (!isFullDataQualityRuleInput(input)) return null;
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

function evaluateReserveQueryFailure(input: DataQualityRuleInput): Partial<StatusRuleEvaluation> | null {
  if (!isFullDataQualityRuleInput(input) || !input.reserveCompositionQueryFailed) return null;
  return ruleResult("healthy", [
    makeCause(
      "data-quality",
      "reserve_sync_query_failed",
      "info",
      "Live reserve composition overview query failed; reserve freshness status may be incomplete.",
    ),
  ]);
}

function evaluateRepairDiagnostics(input: DataQualityRuleInput): Partial<StatusRuleEvaluation> | null {
  if (!isFullDataQualityRuleInput(input)) return null;
  const causes: StatusCause[] = [];
  if (input.repairRunnerAutoRepairCount != null) {
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

function evaluateReserveOperationalDiagnostics(input: DataQualityRuleInput): Partial<StatusRuleEvaluation> | null {
  if (!isFullDataQualityRuleInput(input)) return null;
  const reserve = input.reserveComposition;
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
  if (reserve.cursorTailState === "recording" || reserve.cursorTailState === "incomplete") {
    causes.push(
      makeCause(
        "data-quality",
        "reserve_sync_tail_incomplete",
        "warning",
        `Live reserve deferred-tail recording is ${reserve.cursorTailState}` + (reserve.cursorTailError ? ` (${reserve.cursorTailError}).` : "."),
        { metric: "reserveCursorTailIncomplete", value: 1, threshold: 1 },
      ),
    );
  }
  if (reserve.runBudgetTruncated) {
    const deferredRatio = reserve.configuredCoins > 0 ? reserve.deferredCoins / reserve.configuredCoins : 0;
    const pressureReasons = [
      deferredRatio >= STATUS_RESERVE_HIGH_DEFERRED_RATIO ? `high deferred share ${formatPercentFromRatio(deferredRatio)}` : null,
      reserve.runBudgetTruncationCount >= STATUS_RESERVE_REPEATED_TRUNCATION_COUNT
        ? `${reserve.runBudgetTruncationCount} consecutive truncation(s)`
        : null,
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
  if (reserve.historyWriteGaps.length > 0) {
    const examples = reserve.historyWriteGaps
      .slice(0, 3)
      .map((gap) => {
        const missing = [gap.compositionHistoryMissing ? "composition" : null, gap.attemptHistoryMissing ? "attempt" : null]
          .filter((entry): entry is string => entry != null)
          .join("+");
        return `${gap.stablecoinId}:${missing || "history"}`;
      })
      .join(", ");
    causes.push(
      makeCause(
        "data-quality",
        "reserve_sync_history_write_gap",
        "warning",
        `${reserve.historyWriteGaps.length} authoritative live reserve snapshot(s) are missing history rows` +
          (examples ? ` (${examples}${reserve.historyWriteGaps.length > 3 ? ", ..." : ""}).` : "."),
        { metric: "reserveHistoryWriteGaps", value: reserve.historyWriteGaps.length, threshold: 1 },
      ),
    );
  }
  return ruleResult("healthy", causes);
}

const DATA_QUALITY_STATUS_RULES_CORE: readonly StatusRule<DataQualityRuleInput>[] = [
  (input) => {
      const status = input.dataQuality.stablecoinsCacheStatus === "error" ? "stale" : input.dataQuality.stablecoinsCacheStatus === "degraded" ? "degraded" : "healthy";
      if (status === "healthy") return null;
      const cause = isFullDataQualityRuleInput(input)
        ? makeCause(
            "data-quality",
            status === "stale" ? "stablecoins_cache_unavailable" : "stablecoins_cache_degraded",
            status === "stale" ? "critical" : "warning",
            `Stablecoins cache is ${status === "stale" ? "unavailable" : "degraded"} (${input.dataQuality.stablecoinsCacheReason ?? "unknown"}).`,
          )
        : null;
      return ruleResult(status, cause ? [cause] : []);
  },
  (input) => {
      const publication = input.dataQuality.stablecoinPublication;
      if (publication == null || publication.status === "complete") return null;
      const cause = isFullDataQualityRuleInput(input)
        ? publication.status === "incomplete"
          ? (() => {
              const missing = publication.missingActiveIds;
              const examples = missing.slice(0, 12).join(", ");
              return makeCause(
                "data-quality",
                "stablecoin_publication_incomplete",
                "warning",
                `Stablecoin publication is missing ${missing.length} unwaived active ID(s)` +
                  (examples ? `: ${examples}${missing.length > 12 ? ", ..." : ""}.` : "."),
                { metric: "missingActiveStablecoins", value: missing.length, threshold: 1 },
              );
            })()
          : makeCause("data-quality", "stablecoin_publication_unknown", "warning", "Exact stablecoin publication coverage evidence is unavailable.")
        : null;
      return ruleResult("degraded", cause ? [cause] : []);
  },
  (input) => {
      const status = input.activePriceCoverageImpactStatus;
      const cause =
        isFullDataQualityRuleInput(input) && input.activePriceCoverage.status === "incomplete"
            ? (() => {
                const missing = input.activePriceCoverage.missingActiveIds;
                const examples = missing.slice(0, 12).join(", ");
                const alertEligible = input.activePriceCoverage.alertEligibleCount > 0;
                const baseMessage =
                  `Live prices are missing for ${input.activePriceCoverage.missingPriceCount} active asset(s)` +
                  (examples ? `: ${examples}${missing.length > 12 ? ", ..." : ""}.` : ".");
                return makeCause(
                  "data-quality",
                  "active_price_coverage_incomplete",
                  alertEligible ? "warning" : "info",
                  alertEligible
                    ? baseMessage
                    : `${baseMessage} No gap has reached the alert-eligible persistence threshold; not degrading public status.`,
                  { metric: "missingActivePrices", value: input.activePriceCoverage.missingPriceCount, threshold: 1 },
                );
              })()
            : isFullDataQualityRuleInput(input) && input.activePriceCoverage.status === "unknown"
              ? makeCause("data-quality", "active_price_coverage_unknown", "warning", "Exact active stablecoin live-price coverage evidence is unavailable.")
              : null;
      return ruleResult(status, cause ? [cause] : []);
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
      if (
        input.blacklistMissingRatio >= STATUS_BLACKLIST_THRESHOLDS.missingRatioStale ||
        input.blacklistRecentMissing >= STATUS_BLACKLIST_THRESHOLDS.missingRecentStale
      ) {
        return ruleResult("stale", [makeCause(
          "data-quality",
          "blacklist_gaps_stale",
          "critical",
          `Blacklist amount gaps exceed stale thresholds (ratio=${formatPercentFromRatio(input.blacklistMissingRatio)}, recent=${input.blacklistRecentMissing}).`,
          { metric: "blacklistMissingRatio", value: input.blacklistMissingRatio, threshold: STATUS_BLACKLIST_THRESHOLDS.missingRatioStale },
        )]);
      }
      if (
        input.blacklistRecentMissing >= STATUS_BLACKLIST_THRESHOLDS.missingRecentDegraded ||
        input.blacklistMissingRatio >= STATUS_BLACKLIST_THRESHOLDS.missingRatioDegraded
      ) {
        return ruleResult("degraded", [makeCause(
          "data-quality",
          "blacklist_gaps_degraded",
          "warning",
          `Recent or elevated blacklist amount gaps detected (ratio=${formatPercentFromRatio(input.blacklistMissingRatio)}, recent=${input.blacklistRecentMissing}).`,
          { metric: "blacklistMissingRatio", value: input.blacklistMissingRatio, threshold: STATUS_BLACKLIST_THRESHOLDS.missingRatioDegraded },
        )]);
      }
      return null;
  },
  (input) => {
      const status = input.onchainAssessment.status;
      const causes = isFullDataQualityRuleInput(input) ? input.onchainAssessmentCauses.map(withRunbook) : [];
      return status === "healthy" && causes.length === 0 ? null : { status, causes };
  },
  (input) => {
      const status = isFullDataQualityRuleInput(input) ? input.reserveComposition.status : input.reserveCompositionStatus;
      if (!isFullDataQualityRuleInput(input) || status === "healthy") return ruleResult(status);
      const reserve = input.reserveComposition;
      const persistent = reserve.persistentlyStaleIndependentCoins.length > 0
        ? ` ${formatPersistentStaleIndependentFeeds(reserve.persistentlyStaleIndependentCoins)}.`
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

const DATA_QUALITY_STATUS_RULES: readonly StatusRule<DataQualityRuleInput>[] = [
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
  DATA_QUALITY_STATUS_RULES_CORE[6],
];

function formatPersistentStaleIndependentFeeds(
  coins: StatusResponse["reserveComposition"]["persistentlyStaleIndependentCoins"],
): string {
  const examples = coins
    .slice(0, 3)
    .map((coin) => coin.stablecoinId)
    .join(", ");
  const suffix = coins.length > 3 ? `, +${coins.length - 3} more` : "";
  return `${coins.length} persistently stale independent feed(s)${examples ? ` (${examples}${suffix})` : ""}`;
}

const RUNBOOK_BASE = "https://github.com/TokenBrice/pharos-watch/blob/main/docs/runbooks";

export const RUNBOOK_BY_CODE: Record<string, string> = {
  db_unhealthy: `${RUNBOOK_BASE}/db-connectivity.md`,
  data_quality_skipped_db_unhealthy: `${RUNBOOK_BASE}/db-connectivity.md`,
  stablecoins_cache_unavailable: `${RUNBOOK_BASE}/stablecoins-cache.md`,
  stablecoins_cache_degraded: `${RUNBOOK_BASE}/stablecoins-cache.md`,
  stablecoin_publication_incomplete: `${RUNBOOK_BASE}/stablecoins-cache.md`,
  stablecoin_publication_unknown: `${RUNBOOK_BASE}/stablecoins-cache.md`,
  active_price_coverage_incomplete: `${RUNBOOK_BASE}/stablecoins-cache.md`,
  active_price_coverage_unknown: `${RUNBOOK_BASE}/stablecoins-cache.md`,
  blacklist_gaps_degraded: `${RUNBOOK_BASE}/blacklist-sync.md`,
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

export function evaluateAvailabilityStatus(input: AvailabilityEvaluationInput | AvailabilityStatusInput): StatusRuleEvaluation {
  return evaluateStatusRuleSet(input, AVAILABILITY_STATUS_RULES);
}

export function evaluateDataQualityStatus(
  input: DataQualityEvaluationInput | DataQualityStatusInput | DataQualityCauseInput,
): StatusRuleEvaluation {
  const statusInput: DataQualityRuleInput = {
    dataQuality: input.dataQuality,
    repairRunnerAutoRepairCount: "repairRunnerAutoRepairCount" in input ? input.repairRunnerAutoRepairCount : undefined,
    reserveCompositionQueryFailed: "reserveCompositionQueryFailed" in input ? input.reserveCompositionQueryFailed : undefined,
    missingPriceRatio: input.missingPriceRatio,
    blacklistMissingRatio: input.blacklistMissingRatio,
    blacklistRecentMissing: input.blacklistRecentMissing,
    onchainAssessment: input.onchainAssessment ?? { causes: [], representative: false, status: "healthy" },
    reserveCompositionStatus: "reserveCompositionStatus" in input ? input.reserveCompositionStatus : "healthy",
    activePriceCoverageImpactStatus:
      "activePriceCoverageImpactStatus" in input ? input.activePriceCoverageImpactStatus : "healthy",
    ...(input.activePriceCoverage != null
      ? {
          activePriceCoverage: input.activePriceCoverage,
          onchainAssessmentCauses: input.onchainAssessmentCauses,
          reserveComposition: input.reserveComposition,
        }
      : {}),
  };
  return evaluateStatusRuleSet(statusInput, DATA_QUALITY_STATUS_RULES);
}
