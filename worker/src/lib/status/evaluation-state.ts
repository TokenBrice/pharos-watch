import {
  STATUS_BLACKLIST_THRESHOLDS,
  STATUS_MISSING_PRICE_THRESHOLDS,
} from "@shared/lib/status-thresholds";
import { maxPublicStatus } from "@shared/lib/public-health";
import type { DataQuality, StatusResponse } from "@shared/types/status";
import type { PublicHealthAssessment } from "../public-health-assessment";
import type { StatusLevel } from "../status-reliability";
import { clampConfidence } from "../status-reliability";
import type { OnchainDataQualityAssessment } from "./onchain-data-quality";

const STATUS_SEVERITY: Record<StatusLevel, number> = {
  healthy: 0,
  degraded: 1,
  stale: 2,
};

export function maxStatus(a: StatusLevel, b: StatusLevel): StatusLevel {
  return STATUS_SEVERITY[a] >= STATUS_SEVERITY[b] ? a : b;
}

export interface ReserveCompositionFlags {
  bootstrap: boolean;
  critical: boolean;
  warning: boolean;
}

export function deriveReserveCompositionFlags(
  reserveComposition: StatusResponse["reserveComposition"],
): ReserveCompositionFlags {
  const reserveCompositionBootstrap =
    reserveComposition.configuredCoins > 0 && reserveComposition.lastSuccessAt == null;
  const reserveIssueCount =
    reserveComposition.missingCoins
    + reserveComposition.staleCoins
    + reserveComposition.degradedCoins
    + reserveComposition.errorCoins
    + reserveComposition.corruptCoins;
  const reserveCompositionCritical =
    !reserveCompositionBootstrap
    && reserveComposition.configuredCoins > 0
    && reserveComposition.freshCoins === 0
    && reserveIssueCount > 0;
  const reserveWarningFloor = Math.max(3, Math.ceil(reserveComposition.configuredCoins * 0.1));
  const reserveCompositionWarning =
    !reserveCompositionBootstrap && reserveIssueCount >= reserveWarningFloor;

  return {
    bootstrap: reserveCompositionBootstrap,
    critical: reserveCompositionCritical,
    warning: reserveCompositionWarning,
  };
}

export function deriveAvailabilityStatus(input: {
  publicHealth: PublicHealthAssessment;
  anyCronError: boolean;
  unhealthyCrons: number;
}): StatusResponse["availabilityStatus"] {
  const baseAvailabilityStatus: StatusResponse["availabilityStatus"] =
    input.publicHealth.cacheImpactStatus === "stale" || input.anyCronError || input.unhealthyCrons >= 3
      ? "stale"
      : input.publicHealth.cacheImpactStatus === "degraded" || input.unhealthyCrons > 0
        ? "degraded"
        : "healthy";
  const publicAvailabilityFloor = maxPublicStatus(
    input.publicHealth.circuitImpactStatus,
    input.publicHealth.mintBurnQueryError == null && !input.publicHealth.mintBurnBootstrap
      ? input.publicHealth.mintBurnImpactStatus
      : "healthy",
  );
  return maxStatus(baseAvailabilityStatus, publicAvailabilityFloor);
}

export function deriveDataQualityStatus(input: {
  dataQuality: DataQuality;
  missingPriceRatio: number;
  blacklistMissingRatio: number;
  blacklistRecentMissing: number;
  onchainAssessment: OnchainDataQualityAssessment;
  reserveCompositionQueryFailed: boolean;
  reserveFlags: ReserveCompositionFlags;
}): StatusResponse["dataQualityStatus"] {
  return input.dataQuality.stablecoinsCacheStatus === "error" ||
    input.missingPriceRatio > STATUS_MISSING_PRICE_THRESHOLDS.ratioStale ||
    input.blacklistMissingRatio >= STATUS_BLACKLIST_THRESHOLDS.missingRatioStale ||
    input.blacklistRecentMissing >= STATUS_BLACKLIST_THRESHOLDS.missingRecentStale ||
    input.onchainAssessment.status === "stale" ||
    input.reserveFlags.critical
    ? "stale"
    : input.dataQuality.stablecoinsCacheStatus === "degraded" ||
        input.dataQuality.sourceFailures.length > 0 ||
        input.missingPriceRatio > STATUS_MISSING_PRICE_THRESHOLDS.ratioDegraded ||
        input.blacklistRecentMissing > 0 ||
        input.blacklistMissingRatio >= STATUS_BLACKLIST_THRESHOLDS.missingRatioDegraded ||
        input.onchainAssessment.status === "degraded" ||
        input.reserveFlags.warning ||
        input.reserveCompositionQueryFailed
      ? "degraded"
      : "healthy";
}

export function scoreStatusConfidence(input: {
  availabilityStatus: StatusLevel;
  dataQualityStatus: StatusLevel;
  unhealthyCrons: number;
  degradedCrons: number;
  missingPriceRatio: number;
  onchainMonitoringActive: boolean;
}): number {
  let confidence = 1;

  if (input.availabilityStatus === "degraded") confidence -= 0.12;
  if (input.availabilityStatus === "stale") confidence -= 0.28;
  if (input.dataQualityStatus === "degraded") confidence -= 0.12;
  if (input.dataQualityStatus === "stale") confidence -= 0.28;

  confidence -= Math.min(0.2, input.unhealthyCrons * 0.03);
  confidence -= Math.min(0.08, input.degradedCrons * 0.01);
  confidence -= Math.min(0.18, input.missingPriceRatio * 0.35);
  if (!input.onchainMonitoringActive) confidence -= 0.03;

  return Math.round(clampConfidence(confidence) * 1000) / 1000;
}
