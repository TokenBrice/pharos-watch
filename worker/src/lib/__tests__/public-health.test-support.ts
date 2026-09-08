import type { PublicHealthAssessment } from "../public-health-assessment";
import { ACTIVE_IDS } from "@shared/lib/stablecoins/registry";

export function makePriceCoverageMetadata(
  nowSec: number,
  missingId: string | null,
  consecutive = 2,
  alertEligible = true,
  compact = false,
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
      affectedMarketCapUsd: missingId == null ? 0 : 88_000_000,
      missingActiveAssets: compact || missingId == null ? [] : [{
        stablecoinId: missingId, symbol: "MISS", marketCapUsd: 88_000_000,
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
  return {
    dbHealthy: true,
    overallStatus,
    warnings: [],
    caches: {},
    cacheImpactStatus: overallStatus,
    worstCacheRatio: 0,
    cacheFailures: [],
    cacheDiagnostics: [],
    cacheWarnings: [],
    blacklist: {
      totalEvents: 0,
      missingAmounts: 0,
      recentMissingAmounts: 0,
      recentWindowSec: 86_400,
      missingRatio: 0,
    },
    blacklistMetrics: null,
    blacklistQueryError: null,
    mintBurn: {
      totalEvents: 0,
      latestEventTs: null,
      latestHourlyTs: null,
      freshnessAgeSec: null,
      majorStaleCount: 0,
      staleMajorSymbols: [],
      sync: {
        lastSuccessfulSyncAt: null,
        freshnessStatus: "fresh",
        warning: null,
        criticalLaneHealthy: true,
      },
    },
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
    alertBroker: {
      activeCount: 0,
      pendingCount: 0,
      criticalActiveCount: 0,
      failedDeliveryCount: 0,
      missingTargetCount: 0,
      oldestActiveAt: null,
      activeConditionKeys: [],
      queryFailed: false,
    },
    alertBrokerImpactStatus: "healthy",
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
    ...overrides,
  };
}
