import type { PublicHealthAssessment } from "../public-health-assessment";
import { ACTIVE_IDS } from "@shared/lib/stablecoins/registry";
import { makeHealthyHealthResponse } from "@shared/test-utils/health-fixtures";

export function makePriceCoverageMetadata(
  nowSec: number,
  missingId: string | null,
  consecutive = 2,
  alertEligible = true,
  compact = false,
  marketCapUsd = 88_000_000,
): Record<string, unknown> {
  const activeIds = [...ACTIVE_IDS];
  const missingIds = missingId == null ? [] : [missingId];
  const eligibleIds = alertEligible ? missingIds : [];
  return {
    activePublicationCoverage: {
      complete: true, expectedActiveCount: activeIds.length, presentActiveCount: activeIds.length,
      waivedActiveCount: 0, missingActiveIds: [], waivedActiveIds: [], expiredWaiverIds: [],
    },
    activePriceCoverage: {
      complete: missingId == null, expectedActiveCount: activeIds.length, presentActiveCount: activeIds.length,
      pricedActiveCount: activeIds.length - missingIds.length, missingPriceCount: missingIds.length,
      pricedActiveIds: activeIds.filter((id) => id !== missingId), missingActiveIds: missingIds,
      affectedMarketCapUsd: missingId == null ? 0 : marketCapUsd,
      missingActiveAssets: compact || missingId == null ? [] : [{
        stablecoinId: missingId, symbol: "MISS", marketCapUsd,
        currentPrice: null, currentSource: null, currentObservedAt: null, currentConfidence: null,
        consecutiveMissingGenerations: consecutive, lastAcceptedPrice: 1.001,
        lastAcceptedSource: "pyth", lastAcceptedObservedAt: nowSec - 900 * consecutive,
        rejectionReason: "no-accepted-price", alertEligible,
      }],
      ...(compact ? { missingActiveState: [[missingId, consecutive, 0.999, "redstone", nowSec - 3_600, "no-accepted-price"]] } : {}),
      alertEligibleCount: eligibleIds.length, alertEligibleIds: eligibleIds,
      maxConsecutiveMissingGenerations: missingId == null ? 0 : consecutive,
    },
  };
}

export function makePublicHealth(
  overallStatus: PublicHealthAssessment["overallStatus"] = "healthy",
  overrides: Partial<PublicHealthAssessment> = {},
): PublicHealthAssessment {
  const healthy = makeHealthyHealthResponse();

  return {
    dbHealthy: true,
    overallStatus,
    warnings: [],
    caches: {},
    cacheImpactStatus: overallStatus,
    cacheQualityImpactStatus: "healthy",
    worstCacheRatio: 0,
    cacheFailures: [],
    cacheDiagnostics: [],
    cacheWarnings: [],
    blacklist: healthy.blacklist,
    blacklistMetrics: null,
    blacklistQueryError: null,
    mintBurn: healthy.mintBurn,
    mintBurnImpactStatus: "healthy",
    mintBurnQueryError: null,
    mintBurnLastRunStatus: "ok",
    mintBurnBootstrap: false,
    repairRunnerAutoRepairCount: null,
    circuits: {},
    openCircuitCount: 0,
    circuitImpactStatus: "healthy",
    circuitQueryError: null,
    d1Capacity: null,
    d1CapacityImpactStatus: "healthy",
    d1CapacityQueryError: null,
    stablecoinPublication: {
      status: "complete",
      expectedActiveCount: 0,
      presentActiveCount: 0,
      waivedActiveCount: 0,
      missingActiveIds: [],
      waivedActiveIds: [],
      expiredWaiverIds: [],
      observedAt: null,
    },
    stablecoinPublicationImpactStatus: "healthy",
    activePriceCoverage: {
      status: "complete",
      expectedActiveCount: 0,
      presentActiveCount: 0,
      pricedActiveCount: 0,
      missingPriceCount: 0,
      pricedActiveIds: [],
      missingActiveIds: [],
      affectedMarketCapUsd: 0,
      missingActiveAssets: [],
      alertEligibleCount: 0,
      alertEligibleIds: [],
      maxConsecutiveMissingGenerations: 0,
      observedAt: null,
    },
    activePriceCoverageImpactStatus: "healthy",
    schedulerLiveness: {
      status: "healthy", observedAt: Math.floor(Date.now() / 1000),
      lastAnyStartedAt: Math.floor(Date.now() / 1000) - 30,
      lastFiveMinuteStartedAt: Math.floor(Date.now() / 1000) - 30, ageSeconds: 30,
      warningAfterSec: 600, staleAfterSec: 1200,
      lanes: ["fiveMinuteReserveRecovery", "fiveMinuteTelegramAlerts", "digestTriggerPoll"].map((scheduleKey) => ({
        scheduleKey, lastStartedAt: Math.floor(Date.now() / 1000) - 30,
      })),
      unavailableReason: null,
      heavy: {
        scheduleKey: "v9SupplyAttributionOffset", lastStartedAt: Math.floor(Date.now() / 1000) - 30,
        ageSeconds: 30, warningAfterSec: 1800, staleAfterSec: 2700, status: "healthy", unavailableReason: null,
      },
    },
    schedulerLivenessImpactStatus: "healthy",
    ...overrides,
  };
}
