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

function formatRatio(value: number): string {
  return `${(value * 100).toFixed(2)}%`;
}

function pushCause(bucket: StatusCause[], cause: StatusCause): void {
  bucket.push(cause);
}

function sourceFailureMessage(source: DataQuality["sourceFailures"][number]["source"]): string {
  switch (source) {
    case "active-depegs":
      return "Active depeg metrics unavailable.";
    case "blacklist-gaps":
      return "Blacklist gap metrics unavailable.";
    case "onchain-supply":
      return "Onchain supply diagnostics unavailable.";
    case "stablecoins-cache":
      return "Stablecoins cache unavailable.";
  }
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
  cronHistoryQueryFailed: boolean;
  cronProgressQueryFailed: boolean;
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

  if (input.publicHealth.mintBurnQueryError) {
    pushCause(availabilityCauses, {
      code: "mint_burn_health_query_failed",
      layer: "availability",
      severity: "info",
      message: "Mint/burn health query failed; diagnostics are temporarily unavailable.",
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

  if (input.availabilityImpactingCronErrors > 0) {
    pushCause(availabilityCauses, {
      code: "cron_error_runs",
      layer: "availability",
      severity: "critical",
      message: `${input.availabilityImpactingCronErrors} availability-impacting cron job(s) currently have last-run status=error.`,
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
      message: sourceFailureMessage(failure.source),
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
    input.blacklistRecentMissing > 0 ||
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

  if (input.reserveComposition.status === "stale") {
    pushCause(dataQualityCauses, {
      code: "reserve_sync_stale",
      layer: "data-quality",
      severity: "critical",
      message: "All configured live reserve feeds are missing, stale, or degraded.",
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
        `${input.reserveComposition.corruptCoins} corrupt live reserve feed(s).`,
    });
  }

  return dataQualityCauses;
}
