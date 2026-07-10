import {
  STATUS_BLACKLIST_THRESHOLDS,
  STATUS_MISSING_PRICE_THRESHOLDS,
  STATUS_RESERVE_COMPOSITION_THRESHOLDS,
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

export const STATUS_RESERVE_HIGH_DEFERRED_RATIO = 0.25;
export const STATUS_RESERVE_REPEATED_TRUNCATION_COUNT = 2;

export function maxStatus(a: StatusLevel, b: StatusLevel): StatusLevel {
  return STATUS_SEVERITY[a] >= STATUS_SEVERITY[b] ? a : b;
}

export interface ReserveCompositionAssessment {
  bootstrap: boolean;
  status: StatusResponse["reserveComposition"]["status"];
  freshCoverageRatio: number;
  authoritativeFreshCoverageRatio: number;
}

export function deriveReserveCompositionStatus(
  reserveComposition: StatusResponse["reserveComposition"],
): ReserveCompositionAssessment {
  const bootstrap =
    reserveComposition.configuredCoins > 0 && reserveComposition.lastSuccessAt == null;
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

  return {
    bootstrap,
    status,
    freshCoverageRatio,
    authoritativeFreshCoverageRatio,
  };
}

export function deriveAvailabilityStatus(input: {
  publicHealth: PublicHealthAssessment;
  availabilityImpactingCronErrors: number;
  availabilityImpactingUnhealthyCrons: number;
  availabilityImpactingConsecutiveCronErrors: number;
}): StatusResponse["availabilityStatus"] {
  const baseAvailabilityStatus: StatusResponse["availabilityStatus"] =
    input.publicHealth.cacheImpactStatus === "stale"
    || input.availabilityImpactingConsecutiveCronErrors > 0
    || input.availabilityImpactingUnhealthyCrons >= 2
      ? "stale"
      : input.publicHealth.cacheImpactStatus === "degraded"
        || input.availabilityImpactingCronErrors > 0
        || input.availabilityImpactingUnhealthyCrons > 0
        ? "degraded"
        : "healthy";
  const publicAvailabilityFloor = maxPublicStatus(
    input.publicHealth.circuitQueryError == null ? input.publicHealth.circuitImpactStatus : "healthy",
    input.publicHealth.mintBurnQueryError == null && !input.publicHealth.mintBurnBootstrap
      ? input.publicHealth.mintBurnImpactStatus
      : "healthy",
    input.publicHealth.alertBrokerImpactStatus,
    input.publicHealth.d1CapacityImpactStatus,
  );
  return maxStatus(baseAvailabilityStatus, publicAvailabilityFloor);
}

export function deriveDataQualityStatus(input: {
  dataQuality: DataQuality;
  missingPriceRatio: number;
  blacklistMissingRatio: number;
  blacklistRecentMissing: number;
  onchainAssessment: OnchainDataQualityAssessment;
  reserveCompositionStatus: StatusResponse["reserveComposition"]["status"];
}): StatusResponse["dataQualityStatus"] {
  return input.dataQuality.stablecoinsCacheStatus === "error" ||
    input.missingPriceRatio > STATUS_MISSING_PRICE_THRESHOLDS.ratioStale ||
    input.blacklistMissingRatio >= STATUS_BLACKLIST_THRESHOLDS.missingRatioStale ||
    input.blacklistRecentMissing >= STATUS_BLACKLIST_THRESHOLDS.missingRecentStale ||
    input.onchainAssessment.status === "stale" ||
    input.reserveCompositionStatus === "stale"
    ? "stale"
    : input.dataQuality.stablecoinsCacheStatus === "degraded" ||
        (input.dataQuality.stablecoinPublication != null &&
          input.dataQuality.stablecoinPublication.status !== "complete") ||
        input.missingPriceRatio > STATUS_MISSING_PRICE_THRESHOLDS.ratioDegraded ||
        input.blacklistRecentMissing >= STATUS_BLACKLIST_THRESHOLDS.missingRecentDegraded ||
        input.blacklistMissingRatio >= STATUS_BLACKLIST_THRESHOLDS.missingRatioDegraded ||
        input.onchainAssessment.status === "degraded" ||
        input.reserveCompositionStatus === "degraded"
      ? "degraded"
      : "healthy";
}

export function scoreStatusConfidence(input: {
  availabilityStatus: StatusLevel;
  dataQualityStatus: StatusLevel;
  unhealthyCrons: number;
  degradedCrons: number;
  diagnosticIssueCount: number;
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
  confidence -= Math.min(0.09, input.diagnosticIssueCount * 0.03);
  confidence -= Math.min(0.18, input.missingPriceRatio * 0.35);
  if (!input.onchainMonitoringActive) confidence -= 0.03;

  return Math.round(clampConfidence(confidence) * 1000) / 1000;
}
