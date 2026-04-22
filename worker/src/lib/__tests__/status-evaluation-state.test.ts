import { describe, expect, it } from "vitest";
import type { StatusResponse } from "@shared/types/status";
import type { PublicHealthAssessment } from "../public-health-assessment";
import { deriveAvailabilityStatus, deriveReserveCompositionStatus } from "../status/evaluation-state";

function makeReserveComposition(
  overrides?: Partial<StatusResponse["reserveComposition"]>,
): StatusResponse["reserveComposition"] {
  return {
    configuredCoins: 10,
    freshCoins: 10,
    staleCoins: 0,
    missingCoins: 0,
    degradedCoins: 0,
    errorCoins: 0,
    corruptCoins: 0,
    independentFreshEligible: 4,
    independentFreshUnverified: 2,
    staticValidatedFresh: 2,
    weakProbeFresh: 2,
    writeTimeoutUncertain: 0,
    deferredCoins: 0,
    nextCursorStablecoinId: null,
    persistentlyStaleIndependentCoins: [],
    lastSuccessAt: 1_700_000_000,
    oldestFreshAgeSec: 3600,
    status: "healthy",
    freshCoverageRatio: 1,
    authoritativeFreshCoverageRatio: 0.8,
    ...overrides,
  };
}

function makePublicHealth(
  overrides?: Partial<PublicHealthAssessment>,
): PublicHealthAssessment {
  return {
    dbHealthy: true,
    overallStatus: "healthy",
    warnings: [],
    caches: {},
    cacheImpactStatus: "healthy",
    worstCacheRatio: 0,
    cacheFailures: [],
    cacheDiagnostics: [],
    cacheWarnings: [],
    blacklist: {
      totalEvents: 0,
      missingAmounts: 0,
      recentMissingAmounts: 0,
      recentWindowSec: 86400,
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
    circuits: {},
    openCircuitCount: 0,
    circuitImpactStatus: "healthy",
    circuitQueryError: null,
    ...overrides,
  };
}

describe("status evaluation policy", () => {
  it("keeps reserve status healthy for low-count issues when fresh coverage remains high", () => {
    const assessment = deriveReserveCompositionStatus(makeReserveComposition({
      freshCoins: 8,
      staleCoins: 1,
      errorCoins: 1,
      independentFreshEligible: 3,
      independentFreshUnverified: 2,
      staticValidatedFresh: 2,
      weakProbeFresh: 1,
    }));

    expect(assessment.status).toBe("healthy");
    expect(assessment.freshCoverageRatio).toBe(0.8);
    expect(assessment.authoritativeFreshCoverageRatio).toBe(0.7);
  });

  it("degrades reserve status when fresh or authoritative coverage drops below policy thresholds", () => {
    const assessment = deriveReserveCompositionStatus(makeReserveComposition({
      freshCoins: 7,
      staleCoins: 2,
      errorCoins: 1,
      independentFreshEligible: 2,
      independentFreshUnverified: 1,
      staticValidatedFresh: 1,
      weakProbeFresh: 3,
    }));

    expect(assessment.status).toBe("degraded");
    expect(assessment.freshCoverageRatio).toBe(0.7);
    expect(assessment.authoritativeFreshCoverageRatio).toBe(0.4);
  });

  it("marks reserve status stale only when no fresh coverage remains", () => {
    const assessment = deriveReserveCompositionStatus(makeReserveComposition({
      freshCoins: 0,
      staleCoins: 4,
      missingCoins: 4,
      errorCoins: 2,
      independentFreshEligible: 0,
      independentFreshUnverified: 0,
      staticValidatedFresh: 0,
      weakProbeFresh: 0,
    }));

    expect(assessment.status).toBe("stale");
  });

  it("does not let circuit diagnostics failure degrade availability on its own", () => {
    const availability = deriveAvailabilityStatus({
      publicHealth: makePublicHealth({
        circuitImpactStatus: "degraded",
        circuitQueryError: "Circuit breaker diagnostics unavailable.",
      }),
      availabilityImpactingCronErrors: 0,
      availabilityImpactingUnhealthyCrons: 0,
      availabilityImpactingConsecutiveCronErrors: 0,
    });

    expect(availability).toBe("healthy");
  });
});

describe("deriveAvailabilityStatus cron-error semantic", () => {
  const baseInput = {
    publicHealth: makePublicHealth(),
    availabilityImpactingCronErrors: 0,
    availabilityImpactingUnhealthyCrons: 0,
    availabilityImpactingConsecutiveCronErrors: 0,
  };

  it("stays healthy when nothing is wrong", () => {
    expect(deriveAvailabilityStatus(baseInput)).toBe("healthy");
  });

  it("degrades on a single critical cron error without escalating to stale", () => {
    expect(
      deriveAvailabilityStatus({
        ...baseInput,
        availabilityImpactingCronErrors: 1,
        availabilityImpactingUnhealthyCrons: 1,
      }),
    ).toBe("degraded");
  });

  it("escalates to stale on 2+ consecutive errors on the same critical cron", () => {
    expect(
      deriveAvailabilityStatus({
        ...baseInput,
        availabilityImpactingCronErrors: 1,
        availabilityImpactingUnhealthyCrons: 1,
        availabilityImpactingConsecutiveCronErrors: 1,
      }),
    ).toBe("stale");
  });

  it("escalates to stale when 2+ critical crons are simultaneously unhealthy", () => {
    expect(
      deriveAvailabilityStatus({
        ...baseInput,
        availabilityImpactingCronErrors: 2,
        availabilityImpactingUnhealthyCrons: 2,
      }),
    ).toBe("stale");
  });

  it("preserves cacheImpactStatus=stale escalation independent of cron health", () => {
    expect(
      deriveAvailabilityStatus({
        ...baseInput,
        publicHealth: makePublicHealth({ cacheImpactStatus: "stale" }),
      }),
    ).toBe("stale");
  });

  it("respects publicAvailabilityFloor via mintBurnImpactStatus=stale", () => {
    expect(
      deriveAvailabilityStatus({
        ...baseInput,
        publicHealth: makePublicHealth({
          mintBurnImpactStatus: "stale",
          mintBurnLastRunStatus: "error",
        }),
      }),
    ).toBe("stale");
  });
});
