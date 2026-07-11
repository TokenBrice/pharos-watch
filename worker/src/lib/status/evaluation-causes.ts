import {
  STATUS_BLACKLIST_THRESHOLDS,
  STATUS_CACHE_RATIO_THRESHOLDS,
  STATUS_MISSING_PRICE_THRESHOLDS,
} from "@shared/lib/status-thresholds";
import type {
  DataQuality,
  StatusCause,
  StatusResponse,
} from "@shared/types/status";
import type { PublicHealthAssessment } from "../public-health-assessment";
import {
  STATUS_RESERVE_HIGH_DEFERRED_RATIO,
  STATUS_RESERVE_REPEATED_TRUNCATION_COUNT,
} from "./evaluation-state";
import { formatRatio } from "./format";
import { getSourceFailureMessage } from "./section-errors";

function formatPersistentStaleIndependentFeeds(
  coins: StatusResponse["reserveComposition"]["persistentlyStaleIndependentCoins"],
): string {
  const examples = coins.slice(0, 3).map((coin) => coin.stablecoinId).join(", ");
  const suffix = coins.length > 3 ? `, +${coins.length - 3} more` : "";
  return `${coins.length} persistently stale independent feed(s)${examples ? ` (${examples}${suffix})` : ""}`;
}

/**
 * Operator-facing runbook URLs, keyed by StatusCause.code. Populated only
 * for the codes that have a documented runbook — the rest are deliberately
 * omitted so the UI can render the "Runbook →" link only when present.
 *
 * URLs point at the repo's `docs/runbooks/` folder on GitHub. These files
 * are not served by Next.js, so a relative path like `/docs/runbooks/...`
 * would 404 at `https://ops.pharos.watch/...`. The blob URL survives branch
 * renames as long as `main` is the default.
 */
const RUNBOOK_BASE = "https://github.com/TokenBrice/pharos-watch/blob/main/docs/runbooks";

export const RUNBOOK_BY_CODE: Record<string, string> = {
  db_unhealthy: `${RUNBOOK_BASE}/db-connectivity.md`,
  data_quality_skipped_db_unhealthy: `${RUNBOOK_BASE}/db-connectivity.md`,
  stablecoins_cache_unavailable: `${RUNBOOK_BASE}/stablecoins-cache.md`,
  stablecoins_cache_degraded: `${RUNBOOK_BASE}/stablecoins-cache.md`,
  stablecoin_publication_incomplete: `${RUNBOOK_BASE}/stablecoins-cache.md`,
  stablecoin_publication_unknown: `${RUNBOOK_BASE}/stablecoins-cache.md`,
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

function pushCause(bucket: StatusCause[], cause: StatusCause): void {
  bucket.push(withRunbook(cause));
}

export function synthesizeOverallCauses(
  availability: StatusCause[],
  dataQuality: StatusCause[],
): StatusCause[] {
  const sorted = [...availability, ...dataQuality].sort((a, b) => {
    const severityOrder = { critical: 0, warning: 1, info: 2 };
    return severityOrder[a.severity] - severityOrder[b.severity];
  });
  return sorted.slice(0, 12);
}

export function buildAvailabilityCauses(input: {
  publicHealth: PublicHealthAssessment;
  availabilityImpactingUnhealthyCrons: number;
  watchUnhealthyCrons: number;
  degradedCronRuns: number;
  cronErrorCount: number;
  availabilityImpactingCronErrors: number;
  availabilityImpactingConsecutiveCronErrors: number;
  cronHistoryQueryFailed: boolean;
  cronProgressQueryFailed: boolean;
  cronLeaseQueryFailed: boolean;
}): StatusCause[] {
  const availabilityCauses: StatusCause[] = [];
  const worstCacheRatio = input.publicHealth.worstCacheRatio;
  const cacheFailures = input.publicHealth.cacheFailures;
  const cacheDiagnostics = input.publicHealth.cacheDiagnostics;
  const cacheWarnings = input.publicHealth.cacheWarnings;
  const caches = input.publicHealth.caches;

  if (worstCacheRatio > STATUS_CACHE_RATIO_THRESHOLDS.stale) {
    pushCause(availabilityCauses, {
      code: "cache_ratio_stale",
      layer: "availability",
      severity: "critical",
      message:
        `Cache freshness exceeded stale threshold (${worstCacheRatio.toFixed(2)}x > ` +
        `${STATUS_CACHE_RATIO_THRESHOLDS.stale.toFixed(2)}x).`,
      metric: "worstCacheRatio",
      value: worstCacheRatio,
      threshold: STATUS_CACHE_RATIO_THRESHOLDS.stale,
    });
  } else if (worstCacheRatio > STATUS_CACHE_RATIO_THRESHOLDS.degraded) {
    pushCause(availabilityCauses, {
      code: "cache_ratio_degraded",
      layer: "availability",
      severity: "warning",
      message:
        `Cache freshness exceeded degraded threshold (${worstCacheRatio.toFixed(2)}x > ` +
        `${STATUS_CACHE_RATIO_THRESHOLDS.degraded.toFixed(2)}x).`,
      metric: "worstCacheRatio",
      value: worstCacheRatio,
      threshold: STATUS_CACHE_RATIO_THRESHOLDS.degraded,
    });
  }

  if (cacheFailures.length > 0) {
    const cacheTargets = cacheFailures.map((failure) => {
      const diagnostic = cacheDiagnostics.find((entry) => entry.key === failure.key);
      return diagnostic ? `${failure.key} via ${diagnostic.freshnessSource}` : failure.key;
    }).join(", ");
    pushCause(availabilityCauses, {
      code: "cache_freshness_query_failed",
      layer: "availability",
      severity: "info",
      message: `Cache freshness diagnostics were incomplete for: ${cacheTargets}.`,
    });
  }

  const fxCache = caches["fx-rates"];
  if (fxCache?.mode === "cached-fallback") {
    pushCause(availabilityCauses, {
      code: "fx_cached_fallback",
      layer: "availability",
      severity: fxCache.consecutiveFallbackRuns != null && fxCache.consecutiveFallbackRuns >= 4
        ? "warning"
        : "info",
      message:
        fxCache.warning ??
        `FX references are running in cached fallback mode (${fxCache.consecutiveFallbackRuns ?? 0} consecutive runs).`,
      metric: "fxFallbackRuns",
      value: fxCache.consecutiveFallbackRuns,
      threshold: 4,
    });
  }

  if (fxCache?.sourceStatus === "stale") {
    pushCause(availabilityCauses, {
      code: "fx_source_stale",
      layer: "availability",
      severity: "critical",
      message:
        fxCache.warning ??
        "Non-USD FX reference source data is stale relative to its expected source cadence even though usable FX rates still exist.",
      metric: "fxSourceAgeSeconds",
      value: fxCache.sourceAgeSeconds ?? undefined,
    });
  } else if (fxCache?.sourceStatus === "degraded") {
    pushCause(availabilityCauses, {
      code: "fx_source_degraded",
      layer: "availability",
      severity: "warning",
      message:
        fxCache.warning ??
        "Non-USD FX reference source data is behind its expected update cadence.",
      metric: "fxSourceAgeSeconds",
      value: fxCache.sourceAgeSeconds ?? undefined,
    });
  }

  if (cacheWarnings.length > 0) {
    for (const warning of cacheWarnings) {
      pushCause(availabilityCauses, {
        code: "cache_warning",
        layer: "availability",
        severity: "info",
        message: warning,
      });
    }
  }

  const dexLiquidityCache = caches["dex-liquidity"];
  const dewsCache = caches.dews;
  if (dexLiquidityCache && dewsCache && !dexLiquidityCache.healthy && !dewsCache.healthy) {
    pushCause(availabilityCauses, {
      code: "dews_downstream_of_dex_liquidity",
      layer: "availability",
      severity: dexLiquidityCache.ageSeconds != null && dexLiquidityCache.ageSeconds > dexLiquidityCache.maxAge
        ? "warning"
        : "info",
      message:
        "DEWS freshness is downstream of DEX liquidity; both lanes are unhealthy, so investigate sync-dex-liquidity first.",
      metric: "dexLiquidityAgeSeconds",
      value: dexLiquidityCache.ageSeconds ?? undefined,
      threshold: dexLiquidityCache.maxAge,
    });
  }

  if (input.publicHealth.mintBurnQueryError) {
    pushCause(availabilityCauses, {
      code: "mint_burn_health_query_failed",
      layer: "availability",
      severity: "info",
      message:
        "Mint/burn health query failed; diagnostics are temporarily unavailable. " +
        `Latest critical cron run status: ${input.publicHealth.mintBurnLastRunStatus ?? "unknown"}.`,
    });
  } else if (!input.publicHealth.mintBurnBootstrap && input.publicHealth.mintBurnImpactStatus === "stale") {
    pushCause(availabilityCauses, {
      code: "mint_burn_public_stale",
      layer: "availability",
      severity: "critical",
      message:
        input.publicHealth.mintBurn.sync.warning ??
        "Mint/burn public freshness is stale versus the critical-lane cadence.",
    });
  } else if (!input.publicHealth.mintBurnBootstrap && input.publicHealth.mintBurnImpactStatus === "degraded") {
    pushCause(availabilityCauses, {
      code: "mint_burn_public_degraded",
      layer: "availability",
      severity: "warning",
      message:
        input.publicHealth.mintBurn.sync.warning ??
        "Mint/burn public freshness is degraded versus the critical-lane cadence.",
    });
  }

  if (input.publicHealth.circuitQueryError) {
    pushCause(availabilityCauses, {
      code: "circuit_query_failed",
      layer: "availability",
      severity: "info",
      message: "Circuit breaker diagnostics failed; availability details may be incomplete.",
    });
  } else if (input.publicHealth.openCircuitCount >= 3) {
    pushCause(availabilityCauses, {
      code: "open_circuit_groups",
      layer: "availability",
      severity: "warning",
      message: `${input.publicHealth.openCircuitCount} circuit breaker groups are currently open.`,
      metric: "openCircuits",
      value: input.publicHealth.openCircuitCount,
      threshold: 3,
    });
  }

  if (input.publicHealth.d1CapacityQueryError) {
    pushCause(availabilityCauses, {
      code: "d1_capacity_query_failed",
      layer: "availability",
      severity: "info",
      message: "D1 capacity diagnostics are temporarily unavailable.",
    });
  } else if (input.publicHealth.d1Capacity?.thresholdState !== "normal" && input.publicHealth.d1Capacity) {
    const capacity = input.publicHealth.d1Capacity;
    const exhaustion = capacity.daysUntilExhaustion == null
      ? "Exhaustion forecast is not yet available."
      : `Projected exhaustion is ${capacity.daysUntilExhaustion} days away.`;
    pushCause(availabilityCauses, {
      code: `d1_capacity_${capacity.thresholdState}`,
      layer: "availability",
      severity: capacity.thresholdState === "critical" ? "critical" : "warning",
      message: `D1 database utilization is ${capacity.utilizationPercent}% (${capacity.thresholdState}). ${exhaustion}`,
      metric: "d1CapacityUtilizationPercent",
      value: capacity.utilizationPercent,
      threshold: capacity.crossedThresholdPercent ?? 60,
    });
  }

  if (input.cronHistoryQueryFailed) {
    pushCause(availabilityCauses, {
      code: "cron_history_query_failed",
      layer: "availability",
      severity: "info",
      message: "Cron history query failed; cron health is temporarily unknown rather than unhealthy.",
    });
  }

  if (input.cronProgressQueryFailed) {
    pushCause(availabilityCauses, {
      code: "cron_progress_query_failed",
      layer: "availability",
      severity: "info",
      message: "Cron progress query failed; in-flight cron telemetry is temporarily unavailable.",
    });
  }

  if (input.cronLeaseQueryFailed) {
    pushCause(availabilityCauses, {
      code: "cron_lease_query_failed",
      layer: "availability",
      severity: "info",
      message: "Cron lease query failed; orphan-progress and expired-lease detection are temporarily unavailable.",
    });
  }

  if (input.availabilityImpactingCronErrors > 0) {
    const isSustained = input.availabilityImpactingConsecutiveCronErrors > 0;
    pushCause(availabilityCauses, {
      code: "cron_error_runs",
      layer: "availability",
      severity: isSustained ? "critical" : "warning",
      message: isSustained
        ? `${input.availabilityImpactingConsecutiveCronErrors} availability-impacting cron job(s) have 2+ consecutive failed runs.`
        : `${input.availabilityImpactingCronErrors} availability-impacting cron job(s) had a single transient failed run.`,
      metric: "availabilityImpactingCronErrors",
      value: input.availabilityImpactingCronErrors,
      threshold: 1,
    });
  }

  const watchCronErrors = Math.max(0, input.cronErrorCount - input.availabilityImpactingCronErrors);
  if (watchCronErrors > 0) {
    pushCause(availabilityCauses, {
      code: "watch_cron_error_runs",
      layer: "availability",
      severity: "info",
      message: `${watchCronErrors} watch-tier cron job(s) currently have last-run status=error.`,
      metric: "watchCronErrors",
      value: watchCronErrors,
      threshold: 1,
    });
  }

  if (input.availabilityImpactingUnhealthyCrons >= 2) {
    pushCause(availabilityCauses, {
      code: "multiple_unhealthy_crons",
      layer: "availability",
      severity: "critical",
      message: `${input.availabilityImpactingUnhealthyCrons} availability-impacting cron jobs are unavailable/stale.`,
      metric: "availabilityImpactingUnhealthyCrons",
      value: input.availabilityImpactingUnhealthyCrons,
      threshold: 2,
    });
  } else if (input.availabilityImpactingUnhealthyCrons > 0) {
    pushCause(availabilityCauses, {
      code: "unhealthy_crons_present",
      layer: "availability",
      severity: "warning",
      message: `${input.availabilityImpactingUnhealthyCrons} availability-impacting cron job(s) are unavailable/stale.`,
      metric: "availabilityImpactingUnhealthyCrons",
      value: input.availabilityImpactingUnhealthyCrons,
      threshold: 1,
    });
  }

  if (input.watchUnhealthyCrons > 0) {
    pushCause(availabilityCauses, {
      code: "watch_unhealthy_crons_present",
      layer: "availability",
      severity: "info",
      message: `${input.watchUnhealthyCrons} watch-tier cron job(s) are unavailable/stale.`,
      metric: "watchUnhealthyCrons",
      value: input.watchUnhealthyCrons,
      threshold: 1,
    });
  }

  if (input.degradedCronRuns > 0) {
    pushCause(availabilityCauses, {
      code: "degraded_cron_warning",
      layer: "availability",
      severity: "info",
      message: `${input.degradedCronRuns} cron job(s) are in fallback/degraded mode (warning-only).`,
      metric: "degradedCrons",
      value: input.degradedCronRuns,
      threshold: 1,
    });
  }

  return availabilityCauses;
}

export function buildDataQualityCauses(input: {
  dataQuality: DataQuality;
  missingPriceRatio: number;
  blacklistMissingRatio: number;
  blacklistRecentMissing: number;
  onchainAssessmentCauses: StatusCause[];
  reserveCompositionQueryFailed: boolean;
  reserveComposition: StatusResponse["reserveComposition"];
}): StatusCause[] {
  const dataQualityCauses: StatusCause[] = [];

  if (input.dataQuality.stablecoinsCacheStatus === "error") {
    pushCause(dataQualityCauses, {
      code: "stablecoins_cache_unavailable",
      layer: "data-quality",
      severity: "critical",
      message: `Stablecoins cache is unavailable (${input.dataQuality.stablecoinsCacheReason ?? "unknown"}).`,
    });
  } else if (input.dataQuality.stablecoinsCacheStatus === "degraded") {
    pushCause(dataQualityCauses, {
      code: "stablecoins_cache_degraded",
      layer: "data-quality",
      severity: "warning",
      message: `Stablecoins cache is degraded (${input.dataQuality.stablecoinsCacheReason ?? "unknown"}).`,
    });
  }

  if (input.dataQuality.stablecoinPublication?.status === "incomplete") {
    const missing = input.dataQuality.stablecoinPublication.missingActiveIds;
    const examples = missing.slice(0, 12).join(", ");
    pushCause(dataQualityCauses, {
      code: "stablecoin_publication_incomplete",
      layer: "data-quality",
      severity: "warning",
      message:
        `Stablecoin publication is missing ${missing.length} unwaived active ID(s)` +
        (examples ? `: ${examples}${missing.length > 12 ? ", ..." : ""}.` : "."),
      metric: "missingActiveStablecoins",
      value: missing.length,
      threshold: 1,
    });
  } else if (input.dataQuality.stablecoinPublication?.status === "unknown") {
    pushCause(dataQualityCauses, {
      code: "stablecoin_publication_unknown",
      layer: "data-quality",
      severity: "warning",
      message: "Exact stablecoin publication coverage evidence is unavailable.",
    });
  }

  for (const failure of input.dataQuality.sourceFailures) {
    if (failure.source === "stablecoins-cache") continue;
    const code =
      failure.source === "blacklist-gaps"
        ? "blacklist_gap_query_failed"
        : failure.source === "active-depegs"
          ? "active_depeg_query_failed"
          : "onchain_supply_query_failed";
    pushCause(dataQualityCauses, {
      code,
      layer: "data-quality",
      severity: "info",
      message: getSourceFailureMessage(failure.source),
    });
  }

  if (input.reserveCompositionQueryFailed) {
    pushCause(dataQualityCauses, {
      code: "reserve_sync_query_failed",
      layer: "data-quality",
      severity: "info",
      message: "Live reserve composition overview query failed; reserve freshness status may be incomplete.",
    });
  }

  if (input.dataQuality.ddrRepairDebtStatus === "present" && input.dataQuality.ddrRepairDebtCount > 0) {
    pushCause(dataQualityCauses, {
      code: "ddr_repair_debt_present",
      layer: "data-quality",
      severity: "warning",
      message:
        `${input.dataQuality.ddrRepairDebtCount} DDR source event(s) are quarantined pending explicit repair migration.`,
      metric: "ddrRepairDebtCount",
      value: input.dataQuality.ddrRepairDebtCount,
      threshold: 1,
    });
  } else if (input.dataQuality.ddrRepairDebtStatus === "unknown") {
    pushCause(dataQualityCauses, {
      code: "ddr_repair_debt_unknown",
      layer: "data-quality",
      severity: "info",
      message: "DDR repair-debt marker could not be read; repair backlog status is unknown.",
    });
  }

  if (input.missingPriceRatio > STATUS_MISSING_PRICE_THRESHOLDS.ratioStale) {
    pushCause(dataQualityCauses, {
      code: "missing_prices_stale",
      layer: "data-quality",
      severity: "critical",
      message:
        `Missing price ratio is stale (${formatRatio(input.missingPriceRatio)} > ` +
        `${formatRatio(STATUS_MISSING_PRICE_THRESHOLDS.ratioStale)}).`,
      metric: "missingPriceRatio",
      value: input.missingPriceRatio,
      threshold: STATUS_MISSING_PRICE_THRESHOLDS.ratioStale,
    });
  } else if (input.missingPriceRatio > STATUS_MISSING_PRICE_THRESHOLDS.ratioDegraded) {
    pushCause(dataQualityCauses, {
      code: "missing_prices_degraded",
      layer: "data-quality",
      severity: "warning",
      message:
        `Missing price ratio is degraded (${formatRatio(input.missingPriceRatio)} > ` +
        `${formatRatio(STATUS_MISSING_PRICE_THRESHOLDS.ratioDegraded)}).`,
      metric: "missingPriceRatio",
      value: input.missingPriceRatio,
      threshold: STATUS_MISSING_PRICE_THRESHOLDS.ratioDegraded,
    });
  } else if (input.missingPriceRatio >= STATUS_MISSING_PRICE_THRESHOLDS.ratioElevated) {
    // Early-warning band: surfaces missing-price drift before it crosses the
    // hard degraded threshold. Info-only — does not affect dataQualityStatus.
    pushCause(dataQualityCauses, {
      code: "missing_prices_elevated",
      layer: "data-quality",
      severity: "info",
      message:
        `Missing price ratio is elevated (${formatRatio(input.missingPriceRatio)} ≥ ` +
        `${formatRatio(STATUS_MISSING_PRICE_THRESHOLDS.ratioElevated)}); not degrading status but worth watching.`,
      metric: "missingPriceRatio",
      value: input.missingPriceRatio,
      threshold: STATUS_MISSING_PRICE_THRESHOLDS.ratioElevated,
    });
  }

  if (
    input.blacklistMissingRatio >= STATUS_BLACKLIST_THRESHOLDS.missingRatioStale ||
    input.blacklistRecentMissing >= STATUS_BLACKLIST_THRESHOLDS.missingRecentStale
  ) {
    pushCause(dataQualityCauses, {
      code: "blacklist_gaps_stale",
      layer: "data-quality",
      severity: "critical",
      message:
        `Blacklist amount gaps exceed stale thresholds (ratio=${formatRatio(input.blacklistMissingRatio)}, ` +
        `recent=${input.blacklistRecentMissing}).`,
      metric: "blacklistMissingRatio",
      value: input.blacklistMissingRatio,
      threshold: STATUS_BLACKLIST_THRESHOLDS.missingRatioStale,
    });
  } else if (
    input.blacklistRecentMissing >= STATUS_BLACKLIST_THRESHOLDS.missingRecentDegraded ||
    input.blacklistMissingRatio >= STATUS_BLACKLIST_THRESHOLDS.missingRatioDegraded
  ) {
    pushCause(dataQualityCauses, {
      code: "blacklist_gaps_degraded",
      layer: "data-quality",
      severity: "warning",
      message:
        `Recent or elevated blacklist amount gaps detected (ratio=${formatRatio(input.blacklistMissingRatio)}, ` +
        `recent=${input.blacklistRecentMissing}).`,
      metric: "blacklistMissingRatio",
      value: input.blacklistMissingRatio,
      threshold: STATUS_BLACKLIST_THRESHOLDS.missingRatioDegraded,
    });
  }

  for (const cause of input.onchainAssessmentCauses) {
    pushCause(dataQualityCauses, cause);
  }

  const persistentStaleIndependentFeedText = formatPersistentStaleIndependentFeeds(
    input.reserveComposition.persistentlyStaleIndependentCoins,
  );
  const reserveDeferredRatio = input.reserveComposition.configuredCoins > 0
    ? input.reserveComposition.deferredCoins / input.reserveComposition.configuredCoins
    : 0;
  const reserveTruncationCount = input.reserveComposition.runBudgetTruncationCount;

  if (input.reserveComposition.writeTimeoutUncertain > 0) {
    pushCause(dataQualityCauses, {
      code: "reserve_sync_write_uncertain",
      layer: "data-quality",
      severity: "warning",
      message:
        `${input.reserveComposition.writeTimeoutUncertain} live reserve coin(s) have uncertain D1 write outcomes; ` +
        "operators should wait for a clean follow-up run or inspect reserve_sync_state.",
      metric: "reserveWriteTimeoutUncertain",
      value: input.reserveComposition.writeTimeoutUncertain,
      threshold: 1,
    });
  }

  if (
    input.reserveComposition.cursorTailState === "recording" ||
    input.reserveComposition.cursorTailState === "incomplete"
  ) {
    pushCause(dataQualityCauses, {
      code: "reserve_sync_tail_incomplete",
      layer: "data-quality",
      severity: "warning",
      message:
        `Live reserve deferred-tail recording is ${input.reserveComposition.cursorTailState}` +
        (input.reserveComposition.cursorTailError ? ` (${input.reserveComposition.cursorTailError}).` : "."),
      metric: "reserveCursorTailIncomplete",
      value: 1,
      threshold: 1,
    });
  }

  if (input.reserveComposition.runBudgetTruncated) {
    const pressureReasons = [
      reserveDeferredRatio >= STATUS_RESERVE_HIGH_DEFERRED_RATIO
        ? `high deferred share ${formatRatio(reserveDeferredRatio)}`
        : null,
      reserveTruncationCount >= STATUS_RESERVE_REPEATED_TRUNCATION_COUNT
        ? `${reserveTruncationCount} consecutive truncation(s)`
        : null,
    ].filter((entry): entry is string => entry != null);
    pushCause(dataQualityCauses, {
      code: "reserve_sync_budget_truncated",
      layer: "data-quality",
      severity: "warning",
      message:
        `Latest live reserve run deferred ${input.reserveComposition.deferredCoins} coin(s)` +
        (input.reserveComposition.nextCursorStablecoinId
          ? `; next cursor ${input.reserveComposition.nextCursorStablecoinId}`
          : "") +
        (pressureReasons.length > 0 ? ` (${pressureReasons.join(", ")}).` : "."),
      metric: "reserveDeferredRatio",
      value: reserveDeferredRatio,
      threshold: STATUS_RESERVE_HIGH_DEFERRED_RATIO,
    });
  }

  const historyWriteGaps = input.reserveComposition.historyWriteGaps;
  if (historyWriteGaps.length > 0) {
    const examples = historyWriteGaps.slice(0, 3).map((gap) => {
      const missing = [
        gap.compositionHistoryMissing ? "composition" : null,
        gap.attemptHistoryMissing ? "attempt" : null,
      ].filter((entry): entry is string => entry != null).join("+");
      return `${gap.stablecoinId}:${missing || "history"}`;
    }).join(", ");
    pushCause(dataQualityCauses, {
      code: "reserve_sync_history_write_gap",
      layer: "data-quality",
      severity: "warning",
      message:
        `${historyWriteGaps.length} authoritative live reserve snapshot(s) are missing history rows` +
        (examples ? ` (${examples}${historyWriteGaps.length > 3 ? ", ..." : ""}).` : "."),
      metric: "reserveHistoryWriteGaps",
      value: historyWriteGaps.length,
      threshold: 1,
    });
  }

  if (input.reserveComposition.status === "stale") {
    pushCause(dataQualityCauses, {
      code: "reserve_sync_stale",
      layer: "data-quality",
      severity: "critical",
      message:
        "All configured live reserve feeds are missing, stale, or degraded." +
        (input.reserveComposition.persistentlyStaleIndependentCoins.length > 0
          ? ` ${persistentStaleIndependentFeedText}.`
          : "") +
        (input.reserveComposition.runBudgetTruncated
          ? ` Last run was truncated by budget with ${input.reserveComposition.deferredCoins} deferred coin(s)${input.reserveComposition.nextCursorStablecoinId ? `; next cursor ${input.reserveComposition.nextCursorStablecoinId}` : ""}.`
          : "") +
        (input.reserveComposition.writeTimeoutUncertain > 0
          ? ` ${input.reserveComposition.writeTimeoutUncertain} coin(s) have uncertain D1 write outcomes.`
          : ""),
    });
  } else if (input.reserveComposition.status === "degraded") {
    pushCause(dataQualityCauses, {
      code: "reserve_sync_degraded",
      layer: "data-quality",
      severity: "warning",
      message:
        `Live reserve coverage is degraded (${formatRatio(input.reserveComposition.freshCoverageRatio)} fresh, ` +
        `${formatRatio(input.reserveComposition.authoritativeFreshCoverageRatio)} authoritative). ` +
        `${input.reserveComposition.errorCoins} error, ${input.reserveComposition.missingCoins} missing, ` +
        `${input.reserveComposition.staleCoins} stale, ${input.reserveComposition.degradedCoins} degraded, ` +
        `${input.reserveComposition.corruptCoins} corrupt live reserve feed(s).` +
        (input.reserveComposition.persistentlyStaleIndependentCoins.length > 0
          ? ` ${persistentStaleIndependentFeedText}.`
          : "") +
        (input.reserveComposition.runBudgetTruncated
          ? ` Last run was truncated by budget with ${input.reserveComposition.deferredCoins} deferred coin(s)${input.reserveComposition.nextCursorStablecoinId ? `; next cursor ${input.reserveComposition.nextCursorStablecoinId}` : ""}.`
          : "") +
        (input.reserveComposition.writeTimeoutUncertain > 0
          ? ` ${input.reserveComposition.writeTimeoutUncertain} coin(s) have uncertain D1 write outcomes.`
          : ""),
    });
  }

  return dataQualityCauses;
}
