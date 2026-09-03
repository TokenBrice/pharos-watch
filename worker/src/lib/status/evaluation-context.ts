import type {
  StatusResponse,
} from "@shared/types/status";
import { computeReserveCompositionOverview } from "../live-reserves/store";
import type { PublicHealthAssessment } from "../public-health-assessment";
import type { CronHealthSnapshot } from "./cron-health";
import {
  emptyReserveComposition,
  getDatasetFreshness,
} from "./derived-data";
import { getTelegramBotStats } from "./telegram-bot-stats";
import { deriveReserveCompositionStatus } from "./evaluation-state";
import {
  assessOnchainDataQuality,
  type OnchainDataQualityAssessment,
} from "./onchain-data-quality";
import { getStatusSectionMessage } from "./section-errors";
import { logWorkerEvent } from "../structured-log";

export interface SupplementalStatusSections {
  sectionErrors: StatusResponse["sectionErrors"];
  telegramBot: StatusResponse["telegramBot"];
  datasetFreshness: StatusResponse["datasetFreshness"];
  reserveComposition: StatusResponse["reserveComposition"];
  reserveCompositionQueryFailed: boolean;
}

export async function loadSupplementalStatusSections(
  db: D1Database,
  now: number,
): Promise<SupplementalStatusSections> {
  const sectionErrors: StatusResponse["sectionErrors"] = {};
  let telegramBot: StatusResponse["telegramBot"] = null;
  try {
    telegramBot = await getTelegramBotStats(db, now);
  } catch (err) {
    logWorkerEvent({
      scope: "status",
      level: "warn",
      event: "telegram_bot_stats_unavailable",
      route: "status",
      source: "telegram",
      message: "Telegram bot stats unavailable",
      error: err,
    });
    sectionErrors.telegramBot = {
      code: "telegram_bot_stats_query_failed",
      message: getStatusSectionMessage("telegramBot"),
    };
  }

  const datasetFreshness = await getDatasetFreshness(db);
  let reserveComposition = emptyReserveComposition();
  let reserveCompositionQueryFailed = false;
  try {
    const reserveOverview = await computeReserveCompositionOverview(db, now);
    const { historyWriteGapCheckFailed, ...reserveOverviewData } = reserveOverview;
    const reserveAssessment = deriveReserveCompositionStatus({
      ...reserveComposition,
      ...reserveOverviewData,
    });
    reserveComposition = {
      ...reserveOverviewData,
      status: reserveAssessment.status,
      freshCoverageRatio: reserveAssessment.freshCoverageRatio,
      authoritativeFreshCoverageRatio: reserveAssessment.authoritativeFreshCoverageRatio,
    };
    if (historyWriteGapCheckFailed) {
      reserveCompositionQueryFailed = true;
      sectionErrors.reserveComposition = {
        code: "reserve_history_reconciliation_query_failed",
        message: "Reserve history reconciliation unavailable.",
      };
    }
  } catch (err) {
    reserveCompositionQueryFailed = true;
    logWorkerEvent({
      scope: "status",
      level: "warn",
      event: "reserve_composition_overview_unavailable",
      route: "status",
      source: "reserve_composition",
      message: "Reserve composition overview unavailable",
      error: err,
    });
    sectionErrors.reserveComposition = {
      code: "reserve_composition_query_failed",
      message: getStatusSectionMessage("reserveComposition"),
    };
  }

  return {
    sectionErrors,
    telegramBot,
    datasetFreshness,
    reserveComposition,
    reserveCompositionQueryFailed,
  };
}

export interface StatusAssessmentInputs {
  missingPriceRatio: number;
  blacklistMissingRatio: number;
  blacklistRecentMissing: number;
  hasActiveOnchainMonitor: boolean;
  onchainAssessment: OnchainDataQualityAssessment;
}

export function deriveStatusAssessmentInputs(dataQuality: StatusResponse["dataQuality"]): StatusAssessmentInputs {
  const missingPriceRatio =
    dataQuality.totalStablecoins > 0 ? dataQuality.missingPrices / dataQuality.totalStablecoins : 0;
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

  return {
    missingPriceRatio,
    blacklistMissingRatio: dataQuality.blacklistMissingRatio,
    blacklistRecentMissing: dataQuality.blacklistRecentMissingAmounts,
    hasActiveOnchainMonitor,
    onchainAssessment,
  };
}

function countDiagnosticIssues(input: {
  publicHealth: PublicHealthAssessment;
  dataQuality: StatusResponse["dataQuality"];
  reserveCompositionQueryFailed: boolean;
  cronHistoryQueryFailed: boolean;
  cronProgressQueryFailed: boolean;
  cronLeaseQueryFailed: boolean;
  scheduledSlotRunningQueryFailed?: boolean;
  scheduledSlotEventMarkerQueryFailed?: boolean;
  cronBudgetSurfaceTelemetryQueryFailed?: boolean;
}): number {
  let count = input.publicHealth.cacheFailures.length;
  if (input.publicHealth.mintBurnQueryError) count += 1;
  if (input.publicHealth.circuitQueryError) count += 1;
  if (input.cronHistoryQueryFailed) count += 1;
  if (input.cronProgressQueryFailed) count += 1;
  if (input.cronLeaseQueryFailed) count += 1;
  if (input.scheduledSlotRunningQueryFailed) count += 1;
  if (input.scheduledSlotEventMarkerQueryFailed) count += 1;
  if (input.cronBudgetSurfaceTelemetryQueryFailed) count += 1;
  if (input.reserveCompositionQueryFailed) count += 1;
  count += input.dataQuality.sourceFailures.filter((failure) => failure.source !== "stablecoins-cache").length;
  return count;
}

export function countStatusDiagnosticIssues(input: {
  publicHealth: PublicHealthAssessment;
  dataQuality: StatusResponse["dataQuality"];
  reserveCompositionQueryFailed: boolean;
  cronHealth: CronHealthSnapshot;
  cronBudgetSurfaceTelemetryQueryFailed?: boolean;
}): number {
  return countDiagnosticIssues({
    publicHealth: input.publicHealth,
    dataQuality: input.dataQuality,
    reserveCompositionQueryFailed: input.reserveCompositionQueryFailed,
    cronHistoryQueryFailed: input.cronHealth.cronHistoryQueryFailed,
    cronProgressQueryFailed: input.cronHealth.cronProgressQueryFailed,
    cronLeaseQueryFailed: input.cronHealth.cronLeaseQueryFailed,
    scheduledSlotRunningQueryFailed: input.cronHealth.scheduledSlots.queryFailed,
    scheduledSlotEventMarkerQueryFailed: input.cronHealth.scheduledSlotEventMarkerQueryFailed,
    cronBudgetSurfaceTelemetryQueryFailed: input.cronBudgetSurfaceTelemetryQueryFailed,
  });
}

function getScheduledSlotSectionErrorCode(
  cronHealth: CronHealthSnapshot,
): string | null {
  const runningQueryFailed = cronHealth.scheduledSlots.queryFailed;
  const eventMarkerQueryFailed = cronHealth.scheduledSlotEventMarkerQueryFailed;
  if (runningQueryFailed && eventMarkerQueryFailed) return "scheduled_slot_queries_failed";
  if (runningQueryFailed) return "scheduled_slot_running_query_failed";
  if (eventMarkerQueryFailed) return "scheduled_slot_event_marker_query_failed";
  return null;
}

export function applyCronHealthSectionErrors(
  sectionErrors: StatusResponse["sectionErrors"],
  cronHealth: CronHealthSnapshot,
): void {
  const scheduledSlotErrorCode = getScheduledSlotSectionErrorCode(cronHealth);
  if (scheduledSlotErrorCode) {
    sectionErrors.scheduledSlots = {
      code: scheduledSlotErrorCode,
      message: getStatusSectionMessage("scheduledSlots"),
    };
  }
}
