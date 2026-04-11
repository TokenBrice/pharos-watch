import type { StatusCause, StatusResponse } from "@shared/types/status";
import { assessPublicHealth } from "./public-health-assessment";
import {
  emptyDatasetFreshness,
  emptyReserveComposition,
} from "./status/derived-data";
import { emptyDataQuality, getDataQuality } from "./status/data-quality";
import {
  countDiagnosticIssues,
  deriveStatusAssessmentInputs,
  loadSupplementalStatusSections,
} from "./status/evaluation-context";
import {
  reconcileStatusState,
  type StatusLevel,
} from "./status-reliability";
import {
  deriveAvailabilityStatus,
  deriveDataQualityStatus,
  deriveReserveCompositionStatus,
  maxStatus,
  scoreStatusConfidence,
} from "./status/evaluation-state";
import {
  buildAvailabilityCauses,
  buildDataQualityCauses,
  synthesizeOverallCauses,
} from "./status/evaluation-causes";
import { loadCronHealth } from "./status/cron-health";
import type { CacheFreshnessDiagnostic } from "./api-utils";

export interface RawStatusComputation {
  dbHealthy: boolean;
  availabilityStatus: StatusResponse["availabilityStatus"];
  dataQualityStatus: StatusResponse["dataQualityStatus"];
  rawOverallStatus: StatusLevel;
  confidence: number;
  causes: StatusResponse["causes"];
  caches: StatusResponse["caches"];
  crons: StatusResponse["crons"];
  dataQuality: StatusResponse["dataQuality"];
  telegramBot: StatusResponse["telegramBot"];
  sectionErrors: StatusResponse["sectionErrors"];
  datasetFreshness: StatusResponse["datasetFreshness"];
  summary: StatusResponse["summary"]; reserveComposition: StatusResponse["reserveComposition"];
  freshnessDiagnostics: CacheFreshnessDiagnostic[];
}

function buildDbUnavailableRawStatus(): RawStatusComputation {
  const availabilityCauses: StatusCause[] = [{
    code: "db_unhealthy",
    layer: "availability",
    severity: "critical",
    message: "Primary database connectivity check failed; status is serving a degraded fallback snapshot.",
  }];
  const dataQualityCauses: StatusCause[] = [{
    code: "data_quality_skipped_db_unhealthy",
    layer: "data-quality",
    severity: "warning",
    message: "Data-quality loaders were skipped because the primary database connectivity check failed.",
  }];

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
    dataQuality: emptyDataQuality(),
    telegramBot: null,
    sectionErrors: {},
    datasetFreshness: emptyDatasetFreshness(),
    summary: {
      unhealthyCrons: 0,
      availabilityImpactingUnhealthyCrons: 0,
      watchUnhealthyCrons: 0,
      degradedCrons: 0,
      cronErrors: 0,
      availabilityImpactingCronErrors: 0,
      availabilityImpactingConsecutiveCronErrors: 0,
      diagnosticIssueCount: 0,
      worstCacheRatio: 0,
    },
    reserveComposition: emptyReserveComposition(),
    freshnessDiagnostics: [],
  };
}

export async function evaluateStatusAndPersist(db: D1Database, now: number): Promise<{
  raw: RawStatusComputation;
  effectiveStatus: StatusLevel;
  persistenceSucceeded: boolean;
}> {
  const raw = await computeRawStatus(db, now);
  const persisted = await reconcileStatusState(db, now, raw.rawOverallStatus, raw.confidence, raw.causes.overall);
  return {
    raw,
    effectiveStatus: persisted.effectiveStatus,
    persistenceSucceeded: persisted.persistenceSucceeded,
  };
}

export async function computeRawStatus(db: D1Database, now: number): Promise<RawStatusComputation> {
  const publicHealth = await assessPublicHealth(db, now, { logPrefix: "status" });
  if (!publicHealth.dbHealthy) {
    return buildDbUnavailableRawStatus();
  }

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
  } = await loadCronHealth(db, now);

  const dataQuality = await getDataQuality(db, now, {
    blacklistMetrics: publicHealth.blacklistMetrics,
  });
  const {
    sectionErrors,
    telegramBot,
    datasetFreshness,
    reserveComposition,
    reserveCompositionQueryFailed,
  } = await loadSupplementalStatusSections(db, now);
  const {
    missingPriceRatio,
    blacklistMissingRatio,
    blacklistRecentMissing,
    hasActiveOnchainMonitor,
    onchainAssessment,
  } = deriveStatusAssessmentInputs(dataQuality);
  const reserveAssessment = deriveReserveCompositionStatus(reserveComposition);
  const diagnosticIssueCount = countDiagnosticIssues({
    publicHealth,
    dataQuality,
    reserveCompositionQueryFailed,
    cronHistoryQueryFailed,
    cronProgressQueryFailed,
  });

  const availabilityStatus = deriveAvailabilityStatus({
    publicHealth,
    availabilityImpactingCronErrors,
    availabilityImpactingUnhealthyCrons,
    availabilityImpactingConsecutiveCronErrors,
  });
  const dataQualityStatus = deriveDataQualityStatus({
    dataQuality,
    missingPriceRatio,
    blacklistMissingRatio,
    blacklistRecentMissing,
    onchainAssessment,
    reserveCompositionStatus: reserveAssessment.status,
  });

  const rawOverallStatus = maxStatus(availabilityStatus, dataQualityStatus);
  const availabilityCauses = buildAvailabilityCauses({
    publicHealth,
    availabilityImpactingUnhealthyCrons,
    watchUnhealthyCrons,
    degradedCronRuns,
    cronErrorCount,
    availabilityImpactingCronErrors,
    availabilityImpactingConsecutiveCronErrors,
    cronHistoryQueryFailed,
    cronProgressQueryFailed,
  });
  const dataQualityCauses = buildDataQualityCauses({
    dataQuality,
    missingPriceRatio,
    blacklistMissingRatio,
    blacklistRecentMissing,
    onchainAssessmentCauses: onchainAssessment.causes,
    reserveCompositionQueryFailed,
    reserveComposition,
  });

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
    dataQuality,
    telegramBot,
    sectionErrors,
    datasetFreshness,
    reserveComposition,
    freshnessDiagnostics: publicHealth.cacheDiagnostics,
    summary: {
      unhealthyCrons,
      availabilityImpactingUnhealthyCrons,
      watchUnhealthyCrons,
      degradedCrons: degradedCronRuns,
      cronErrors: cronErrorCount,
      availabilityImpactingCronErrors,
      availabilityImpactingConsecutiveCronErrors,
      diagnosticIssueCount,
      worstCacheRatio: publicHealth.worstCacheRatio,
    },
  };
}
