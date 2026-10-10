import { unavailableReserveComposition } from "@shared/lib/status-reserve-composition";
import type { StatusCause, StatusResponse } from "@shared/types/status";
import { assessPublicHealth, capturePublicHealthRead, getPublicHealthEvidenceReadFailures, type PublicHealthReadResult } from "./public-health-assessment";
import { emptyDatasetFreshness } from "./status/derived-data";
import { getDataQuality } from "./status/data-quality";
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
import { synthesizeOverallCauses } from "./status/evaluation-causes";
import {
  evaluateAvailabilityStatus,
  evaluateDataQualityStatus,
  withRunbook,
} from "./status/evaluation-rules";
import { loadCronHealth } from "./status/cron-health";
import { buildStatusSummary, emptyStatusSummary } from "./status/summary";
import { loadBudgetOnlySurfaceStatuses } from "./budget-surface-telemetry";
import { type CacheFreshnessDiagnostic } from "./api-freshness";
import type { SchedulerLiveness } from "@shared/types/status/public-health";

export interface RawStatusComputation {
  dbHealthy: boolean;
  evidenceReadFailures?: string[];
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
  schedulerLiveness?: SchedulerLiveness;
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
    evidenceReadFailures: ["db-unavailable"],
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
    dataQuality: null,
    telegramBot: null,
    sectionErrors: {
      dataQuality: { code: "db-unavailable", message: "Data-quality evidence unavailable because the primary database could not be read." },
      summary: { code: "db-unavailable", message: "Status summary counts unavailable because the primary database could not be read." },
      reserveComposition: { code: "db-unavailable", message: "Reserve composition unavailable because the primary database could not be read." },
    },
    datasetFreshness: emptyDatasetFreshness(),
    summary: emptyStatusSummary(),
    reserveComposition: unavailableReserveComposition("db-unavailable"),
    freshnessDiagnostics: [],
  };
}

/** Diagnostic counts cannot break status, but unavailable is never observed zero. */
async function countRecentStatusTransitions(db: D1Database, now: number): Promise<PublicHealthReadResult<number>> {
  return capturePublicHealthRead(
    {
      event: "status_transitions_count_query_failed",
      source: "status-transitions",
      message: "Status transitions count unavailable.",
      reason: "status-transitions-read-failed",
    },
    async () => {
      const row = await db
        .prepare(`SELECT COUNT(*) AS cnt FROM status_transitions WHERE scope = ? AND created_at >= ?`)
        .bind("global", now - 86400)
        .first<{ cnt: number | null }>();
      if (row?.cnt == null) throw new Error("Status transitions count returned no observation");
      return row.cnt;
    },
  );
}

export async function computeRawStatus(
  db: D1Database,
  now: number,
  schedulerLiveness?: SchedulerLiveness,
) {
  const publicHealth = await assessPublicHealth(db, now, { logPrefix: "status", schedulerLiveness });
  if (!publicHealth.dbHealthy) {
    return { ...buildDbUnavailableRawStatus(), schedulerLiveness: publicHealth.schedulerLiveness };
  }

  // Independent status loads run in parallel. The repo's six-request outbound
  // budget applies to fetch phases, not these D1 reads; none is scheduled via
  // waitUntil.
  const [cronHealth, budgetOnlySurfaceResult, dataQuality, supplements, transitionsLast24h] = await Promise.all([
    loadCronHealth(db, now),
    loadBudgetOnlySurfaceStatuses(db, now),
    getDataQuality(db, now, {
      blacklistMetrics: publicHealth.blacklistMetrics,
      stablecoinPublication: publicHealth.stablecoinPublication,
      activePriceCoverage: publicHealth.activePriceCoverage,
    }),
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
  const reserveCompositionStatus = reserveComposition.status === "unavailable"
    ? "unavailable"
    : deriveReserveCompositionStatus(reserveComposition).status;
  const diagnosticIssueCount = countStatusDiagnosticIssues({
    publicHealth,
    dataQuality,
    reserveCompositionQueryFailed,
    cronHealth,
    cronBudgetSurfaceTelemetryQueryFailed: budgetOnlySurfaceResult.queryFailed,
  });
  applyCronHealthSectionErrors(sectionErrors, cronHealth);
  const evidenceReadFailures = [
    ...(!transitionsLast24h.ok ? [transitionsLast24h.error] : []),
    ...getPublicHealthEvidenceReadFailures(publicHealth),
    ...[
      ["cron-history", cronHistoryQueryFailed],
      ["cron-progress", cronProgressQueryFailed],
      ["cron-leases", cronLeaseQueryFailed],
      ["scheduled-slots", cronHealth.scheduledSlots.queryFailed],
      ["scheduled-slot-markers", cronHealth.scheduledSlotEventMarkerQueryFailed],
      ["budget-surfaces", budgetOnlySurfaceResult.queryFailed],
    ].filter(([, failed]) => failed === true).map(([source]) => `${source}:read-failed`),
    ...dataQuality.sourceFailures.map((failure) => `data-quality:${failure.source}:read-failed`),
    ...Object.values(supplements.sectionErrors).flatMap((error) => error ? [error.code] : []),
  ];
  if (!transitionsLast24h.ok) sectionErrors.statusTransitions = {
    code: transitionsLast24h.error,
    message: "Recent status transition count unavailable; this does not imply zero transitions.",
  };
  if (publicHealth.schedulerLiveness.status === "unavailable") sectionErrors.schedulerLiveness = {
    code: "scheduler_liveness_unavailable",
    message: `Scheduler delivery evidence unavailable (${publicHealth.schedulerLiveness.unavailableReason}).`,
  };
  else if (publicHealth.schedulerLiveness.heavy.status === "unavailable") sectionErrors.schedulerLiveness = {
    code: "heavy_scheduler_liveness_unavailable",
    message: `Heavy scheduler delivery evidence unavailable (${publicHealth.schedulerLiveness.heavy.unavailableReason}; warning >${publicHealth.schedulerLiveness.heavy.warningAfterSec}s; stale >${publicHealth.schedulerLiveness.heavy.staleAfterSec}s).`,
  };

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
    nowSec: now,
    dataQuality,
    missingPriceRatio,
    blacklistMissingRatio,
    blacklistRecentMissing,
    onchainAssessment,
    reserveCompositionStatus,
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
    schedulerLiveness: publicHealth.schedulerLiveness,
    availabilityStatus,
    dataQualityStatus,
    rawOverallStatus,
    confidence,
    evidenceReadFailures,
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
      transitionsLast24h: transitionsLast24h.value,
      transitionsUnavailableReason: transitionsLast24h.ok ? null : "status-transitions-read-failed",
    }),
  };
}
