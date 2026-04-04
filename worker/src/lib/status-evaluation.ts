import type {
  StatusCause,
  StatusResponse,
} from "@shared/types/status";
import { computeReserveCompositionOverview } from "./live-reserves-store";
import { assessPublicHealth } from "./public-health-assessment";
import {
  emptyDatasetFreshness,
  emptyReserveComposition,
  getDatasetFreshness,
  getTelegramBotStats,
} from "./status/derived-data";
import { emptyDataQuality, getDataQuality } from "./status/data-quality";
import {
  reconcileStatusState,
  type StatusLevel,
} from "./status-reliability";
import {
  deriveAvailabilityStatus,
  deriveDataQualityStatus,
  deriveReserveCompositionFlags,
  maxStatus,
  scoreStatusConfidence,
} from "./status/evaluation-state";
import {
  buildAvailabilityCauses,
  buildDataQualityCauses,
  synthesizeOverallCauses,
} from "./status/evaluation-causes";
import { assessOnchainDataQuality } from "./status/onchain-data-quality";
import { loadCronHealth } from "./status/cron-health";
import { getStatusSectionMessage } from "./status/section-errors";

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
  summary: StatusResponse["summary"];
  reserveComposition: StatusResponse["reserveComposition"];
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
      degradedCrons: 0,
      cronErrors: 0,
      worstCacheRatio: 0,
    },
    reserveComposition: emptyReserveComposition(),
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

  const caches = publicHealth.caches;
  const worstCacheRatio = publicHealth.worstCacheRatio;
  const {
    crons,
    anyCronError,
    unhealthyCrons,
    degradedCronRuns,
    cronErrorCount,
    cronHistoryQueryFailed,
    cronProgressQueryFailed,
  } = await loadCronHealth(db, now);

  const dataQuality = await getDataQuality(db, now, {
    blacklistMetrics: publicHealth.blacklistMetrics,
  });
  const sectionErrors: StatusResponse["sectionErrors"] = {};
  let telegramBot: StatusResponse["telegramBot"] = null;
  try {
    telegramBot = await getTelegramBotStats(db, now);
  } catch (err) {
    console.warn("[status] Telegram bot stats unavailable:", err);
    sectionErrors.telegramBot = {
      code: "telegram_bot_stats_query_failed",
      message: getStatusSectionMessage("telegramBot"),
    };
  }
  const datasetFreshness = await getDatasetFreshness(db);
  let reserveComposition = emptyReserveComposition();
  let reserveCompositionQueryFailed = false;
  try {
    reserveComposition = await computeReserveCompositionOverview(db, now);
  } catch (err) {
    reserveCompositionQueryFailed = true;
    console.warn("[status] Reserve composition overview unavailable:", err);
    sectionErrors.reserveComposition = {
      code: "reserve_composition_query_failed",
      message: getStatusSectionMessage("reserveComposition"),
    };
  }
  const missingPriceRatio =
    dataQuality.totalStablecoins > 0 ? dataQuality.missingPrices / dataQuality.totalStablecoins : 0;
  const blacklistMissingRatio = dataQuality.blacklistMissingRatio;
  const blacklistRecentMissing = dataQuality.blacklistRecentMissingAmounts;
  const hasActiveOnchainMonitor = dataQuality.onchainSupplyMonitoring === "active";
  const trackedOnchainCoins = hasActiveOnchainMonitor ? dataQuality.onchainSupplyTrackedCoins : 0;
  const onchainAssessment = assessOnchainDataQuality({
    monitoring: dataQuality.onchainSupplyMonitoring,
    trackedCoins: trackedOnchainCoins,
    staleSupply: hasActiveOnchainMonitor ? dataQuality.staleOnchainSupply : 0,
    staleRatio: hasActiveOnchainMonitor ? dataQuality.onchainStaleRatio : 0,
    divergences: hasActiveOnchainMonitor ? dataQuality.onchainSupplyDivergences : 0,
    divergenceRatio: hasActiveOnchainMonitor ? dataQuality.onchainDivergenceRatio : 0,
  });
  const reserveFlags = deriveReserveCompositionFlags(reserveComposition);

  const availabilityStatus = deriveAvailabilityStatus({
    publicHealth,
    anyCronError,
    unhealthyCrons,
  });
  const dataQualityStatus = deriveDataQualityStatus({
    dataQuality,
    missingPriceRatio,
    blacklistMissingRatio,
    blacklistRecentMissing,
    onchainAssessment,
    reserveCompositionQueryFailed,
    reserveFlags,
  });

  const rawOverallStatus = maxStatus(availabilityStatus, dataQualityStatus);
  const availabilityCauses = buildAvailabilityCauses({
    publicHealth,
    unhealthyCrons,
    degradedCronRuns,
    cronErrorCount,
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
    reserveCompositionCritical: reserveFlags.critical,
    reserveCompositionWarning: reserveFlags.warning,
    reserveComposition,
  });

  const confidence = scoreStatusConfidence({
    availabilityStatus,
    dataQualityStatus,
    unhealthyCrons,
    degradedCrons: degradedCronRuns,
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
    caches,
    crons,
    dataQuality,
    telegramBot,
    sectionErrors,
    datasetFreshness,
    reserveComposition,
    summary: {
      unhealthyCrons,
      degradedCrons: degradedCronRuns,
      cronErrors: cronErrorCount,
      worstCacheRatio,
    },
  };
}
