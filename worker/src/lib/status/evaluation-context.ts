import type {
  StatusResponse,
} from "@shared/types/status";
import { computeReserveCompositionOverview } from "../live-reserves-store";
import type { PublicHealthAssessment } from "../public-health-assessment";
import {
  emptyReserveComposition,
  getDatasetFreshness,
  getTelegramBotStats,
} from "./derived-data";
import { deriveReserveCompositionStatus } from "./evaluation-state";
import {
  assessOnchainDataQuality,
  type OnchainDataQualityAssessment,
} from "./onchain-data-quality";
import { getStatusSectionMessage } from "./section-errors";

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
    const reserveOverview = await computeReserveCompositionOverview(db, now);
    const reserveAssessment = deriveReserveCompositionStatus({
      ...reserveComposition,
      ...reserveOverview,
    });
    reserveComposition = {
      ...reserveOverview,
      status: reserveAssessment.status,
      freshCoverageRatio: reserveAssessment.freshCoverageRatio,
      authoritativeFreshCoverageRatio: reserveAssessment.authoritativeFreshCoverageRatio,
    };
  } catch (err) {
    reserveCompositionQueryFailed = true;
    console.warn("[status] Reserve composition overview unavailable:", err);
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

export function countDiagnosticIssues(input: {
  publicHealth: PublicHealthAssessment;
  dataQuality: StatusResponse["dataQuality"];
  reserveCompositionQueryFailed: boolean;
  cronHistoryQueryFailed: boolean;
  cronProgressQueryFailed: boolean;
}): number {
  let count = input.publicHealth.cacheFailures.length;
  if (input.publicHealth.mintBurnQueryError) count += 1;
  if (input.publicHealth.circuitQueryError) count += 1;
  if (input.cronHistoryQueryFailed) count += 1;
  if (input.cronProgressQueryFailed) count += 1;
  if (input.reserveCompositionQueryFailed) count += 1;
  count += input.dataQuality.sourceFailures.filter((failure) => failure.source !== "stablecoins-cache").length;
  return count;
}
