import { logWorkerEventArgs } from "./structured-log";
import type { StatusCause, StatusResponse } from "@shared/types/status";
import { assessPublicHealth } from "./public-health-assessment";
import { emptyDatasetFreshness, emptyReserveComposition } from "./status/derived-data";
import { emptyDataQuality, getDataQuality } from "./status/data-quality";
import {
  applyCronHealthSectionErrors,
  countStatusDiagnosticIssues,
  deriveStatusAssessmentInputs,
  loadSupplementalStatusSections,
} from "./status/evaluation-context";
import type { StatusLevel } from "./status-reliability";
import {
  deriveReserveCompositionStatus,
  maxStatus,
  scoreStatusConfidence,
} from "./status/evaluation-state";
import {
  synthesizeOverallCauses,
  withRunbook,
} from "./status/evaluation-causes";
import { evaluateAvailabilityStatus, evaluateDataQualityStatus } from "./status/evaluation-rules";
import { loadCronHealth } from "./status/cron-health";
import { buildStatusSummary, emptyStatusSummary } from "./status/summary";
import { loadBudgetOnlySurfaceStatuses } from "./budget-surface-telemetry";
import { type CacheFreshnessDiagnostic } from "./api-freshness";

export interface RawStatusComputation {
  dbHealthy: boolean;
  availabilityStatus: StatusResponse["availabilityStatus"];
  dataQualityStatus: StatusResponse["dataQualityStatus"];
  rawOverallStatus: StatusLevel;
  confidence: number;
  causes: StatusResponse["causes"];
  caches: StatusResponse["caches"];
  crons: StatusResponse["crons"];
  budgetOnlySurfaces: StatusResponse["budgetOnlySurfaces"];
  dataQuality: StatusResponse["dataQuality"];
  telegramBot: StatusResponse["telegramBot"];
  sectionErrors: StatusResponse["sectionErrors"];
  datasetFreshness: StatusResponse["datasetFreshness"];
  summary: StatusResponse["summary"];
  reserveComposition: StatusResponse["reserveComposition"];
  freshnessDiagnostics: CacheFreshnessDiagnostic[];
}

function buildDbUnavailableRawStatus(): RawStatusComputation {
  const availabilityCauses: StatusCause[] = [
    withRunbook({
      code: "db_unhealthy",
      layer: "availability",
      severity: "critical",
      message: "Primary database connectivity check failed; status is serving a degraded fallback snapshot.",
    }),
  ];
  const dataQualityCauses: StatusCause[] = [
    withRunbook({
      code: "data_quality_skipped_db_unhealthy",
      layer: "data-quality",
      severity: "warning",
      message: "Data-quality loaders were skipped because the primary database connectivity check failed.",
    }),
  ];

  return {
    dbHealthy: false,
    availabilityStatus: "stale",
    dataQualityStatus: "stale",
    rawOverallStatus: "stale",
    confidence: 0.1,
    causes: {
      availability: availabilityCauses,
      dataQuality: dataQualityCauses,
      overall: synthesizeOverallCauses(availabilityCauses, dataQualityCauses),
    },
    caches: {},
    crons: {},
    budgetOnlySurfaces: [],
    dataQuality: emptyDataQuality(),
    telegramBot: null,
    sectionErrors: {},
    datasetFreshness: emptyDatasetFreshness(),
    summary: emptyStatusSummary(),
    reserveComposition: emptyReserveComposition(),
    freshnessDiagnostics: [],
  };
}

/**
 * Count `status_transitions` rows inserted in the last 24 hours. Used only
 * as an observability signal added during 2026-04-13 status-stability hardening.
 * A failed
 * count query logs a warning and returns 0 — this is diagnostic-only and
 * must not break the main status response.
 */
async function countRecentStatusTransitions(db: D1Database, now: number): Promise<number> {
  try {
    const row = await db
      .prepare(`SELECT COUNT(*) AS cnt FROM status_transitions WHERE scope = ? AND created_at >= ?`)
      .bind("global", now - 86400)
      .first<{ cnt: number | null }>();
    return row?.cnt ?? 0;
  } catch (err) {
    logWorkerEventArgs("lib", "warn", "[status] transitions count query failed:", err);
    return 0;
  }
}

export async function computeRawStatus(db: D1Database, now: number) {
  const publicHealth = await assessPublicHealth(db, now, { logPrefix: "status" });
  if (!publicHealth.dbHealthy) {
    return buildDbUnavailableRawStatus();
  }

  // Independent status loads run in parallel. The repo's six-request outbound
  // budget applies to fetch phases, not these D1 reads; none is scheduled via
  // waitUntil.
  const [cronHealth, budgetOnlySurfaceResult, dataQuality, supplements, transitionsLast24h] = await Promise.all([
    loadCronHealth(db, now),
    loadBudgetOnlySurfaceStatuses(db, now),
    getDataQuality(db, now, { blacklistMetrics: publicHealth.blacklistMetrics }),
    loadSupplementalStatusSections(db, now),
    countRecentStatusTransitions(db, now),
  ]);
  const budgetOnlySurfaces = budgetOnlySurfaceResult.surfaces;

  const {
    crons,
    unhealthyCrons,
    availabilityImpactingUnhealthyCrons,
    watchUnhealthyCrons,
    degradedCronRuns,
    cronErrorCount,
    availabilityImpactingCronErrors,
    availabilityImpactingConsecutiveCronErrors,
    cronHistoryQueryFailed,
    cronProgressQueryFailed,
    cronLeaseQueryFailed,
  } = cronHealth;
  const { sectionErrors, telegramBot, datasetFreshness, reserveComposition, reserveCompositionQueryFailed } =
    supplements;
  const {
    missingPriceRatio,
    blacklistMissingRatio,
    blacklistRecentMissing,
    hasActiveOnchainMonitor,
    onchainAssessment,
  } = deriveStatusAssessmentInputs(dataQuality);
  const reserveAssessment = deriveReserveCompositionStatus(reserveComposition);
  const diagnosticIssueCount = countStatusDiagnosticIssues({
    publicHealth,
    dataQuality,
    reserveCompositionQueryFailed,
    cronHealth,
    cronBudgetSurfaceTelemetryQueryFailed: budgetOnlySurfaceResult.queryFailed,
  });
  applyCronHealthSectionErrors(sectionErrors, cronHealth);

  const availabilityEvaluation = evaluateAvailabilityStatus({
    publicHealth,
    availabilityImpactingCronErrors,
    availabilityImpactingUnhealthyCrons,
    availabilityImpactingConsecutiveCronErrors,
    watchUnhealthyCrons,
    degradedCronRuns,
    cronErrorCount,
    cronHistoryQueryFailed,
    cronProgressQueryFailed,
    cronLeaseQueryFailed,
  });
  const dataQualityEvaluation = evaluateDataQualityStatus({
    dataQuality,
    missingPriceRatio,
    blacklistMissingRatio,
    blacklistRecentMissing,
    onchainAssessment,
    reserveCompositionStatus: reserveAssessment.status,
    activePriceCoverageImpactStatus: publicHealth.activePriceCoverageImpactStatus,
    repairRunnerAutoRepairCount: publicHealth.repairRunnerAutoRepairCount,
    activePriceCoverage: publicHealth.activePriceCoverage,
    onchainAssessmentCauses: onchainAssessment.causes,
    reserveCompositionQueryFailed,
    reserveComposition,
  });

  const availabilityStatus = availabilityEvaluation.status;
  const dataQualityStatus = dataQualityEvaluation.status;

  const rawOverallStatus = maxStatus(availabilityStatus, dataQualityStatus);
  const availabilityCauses = availabilityEvaluation.causes;
  const dataQualityCauses = dataQualityEvaluation.causes;

  const confidence = scoreStatusConfidence({
    availabilityStatus,
    dataQualityStatus,
    unhealthyCrons,
    degradedCrons: degradedCronRuns,
    diagnosticIssueCount,
    missingPriceRatio,
    onchainMonitoringActive: hasActiveOnchainMonitor,
  });

  return {
    dbHealthy: true,
    availabilityStatus,
    dataQualityStatus,
    rawOverallStatus,
    confidence,
    causes: {
      availability: availabilityCauses,
      dataQuality: dataQualityCauses,
      overall: synthesizeOverallCauses(availabilityCauses, dataQualityCauses),
    },
    caches: publicHealth.caches,
    crons,
    budgetOnlySurfaces,
    dataQuality,
    telegramBot,
    sectionErrors,
    datasetFreshness,
    reserveComposition,
    freshnessDiagnostics: publicHealth.cacheDiagnostics,
    summary: buildStatusSummary({
      cronHealth,
      budgetOnlySurfaces,
      diagnosticIssueCount,
      worstCacheRatio: publicHealth.worstCacheRatio,
      transitionsLast24h,
    }),
  };
}
