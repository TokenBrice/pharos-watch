import { describe, expect, it } from "vitest";
import type { DataQuality, StatusResponse } from "@shared/types/status";
import type { PublicHealthAssessment } from "../public-health-assessment";
import { buildAvailabilityCauses, buildDataQualityCauses } from "../status/evaluation-causes";
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
    runBudgetTruncated: false,
    deferredAt: null,
    nextCursorStablecoinId: null,
    cursorTailState: null,
    cursorTailError: null,
    cursorRecordedAt: null,
    cursorTailCompletedAt: null,
    cursorTailFailedAt: null,
    runBudgetTruncationCount: 0,
    historyWriteGaps: [],
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
    ...overrides,
  };
}

function makeDataQuality(overrides?: Partial<DataQuality>): DataQuality {
  return {
    stablecoinsCacheStatus: "ok",
    stablecoinsCacheReason: null,
    blacklistGapStatus: "ok",
    activeDepegStatus: "ok",
    onchainSupplyQueryStatus: "ok",
    repairDebt: {
      status: "ok",
      openCount: 0,
      oldestAgeSec: null,
      byKind: {},
      availabilityEscalated: false,
      nextRunnerDueAt: null,
      source: "worker-repair-tasks",
    },
    ddrRepairDebtStatus: "ok",
    ddrRepairDebtCount: 0,
    ddrRepairDebtCheckedAt: null,
    ddrRepairDebtEvents: [],
    ddrRepairDebtEventsTruncated: false,
    sourceFailures: [],
    totalStablecoins: 10,
    missingPrices: 0,
    blacklistMissingAmounts: 0,
    blacklistRecentMissingAmounts: 0,
    blacklistRecentWindowSec: 86400,
    blacklistMissingRatio: 0,
    blacklistTotal: 0,
    blacklistOldestRecoverableAgeSec: null,
    blacklistNeverAttemptedCount: 0,
    blacklistRepeatedFailureCount: 0,
    onchainSupplyDivergences: 0,
    onchainDivergenceRatio: 0,
    onchainSupplyMonitoring: "active",
    onchainSupplyLatestAt: null,
    onchainSupplyTrackedCoins: 0,
    activeDepegs: 0,
    staleOnchainSupply: 0,
    onchainStaleRatio: 0,
    ...overrides,
  };
}

function makeAvailabilityCauseInput(publicHealth: PublicHealthAssessment) {
  return {
    publicHealth,
    availabilityImpactingUnhealthyCrons: 0,
    watchUnhealthyCrons: 0,
    degradedCronRuns: 0,
    cronErrorCount: 0,
    availabilityImpactingCronErrors: 0,
    availabilityImpactingConsecutiveCronErrors: 0,
    cronHistoryQueryFailed: false,
    cronProgressQueryFailed: false,
    cronLeaseQueryFailed: false,
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

  it("degrades reserve status when independent feeds are persistently stale despite high coverage", () => {
    const assessment = deriveReserveCompositionStatus(makeReserveComposition({
      persistentlyStaleIndependentCoins: [
        { stablecoinId: "coin-a", ageSec: 1_300_000 },
      ],
    }));

    expect(assessment.status).toBe("degraded");
    expect(assessment.freshCoverageRatio).toBe(1);
    expect(assessment.authoritativeFreshCoverageRatio).toBe(0.8);
  });

  it("keeps one-off low-share reserve truncation healthy while surfacing it as a cause", () => {
    const assessment = deriveReserveCompositionStatus({
      ...makeReserveComposition({
        runBudgetTruncated: true,
        deferredCoins: 1,
        nextCursorStablecoinId: "coin-a",
      }),
      runBudgetTruncationCount: 1,
      cursorTailState: "complete",
    } as StatusResponse["reserveComposition"]);

    expect(assessment.status).toBe("healthy");
  });

  it("degrades reserve status for repeated or high-share truncation pressure", () => {
    const repeated = deriveReserveCompositionStatus({
      ...makeReserveComposition({
        runBudgetTruncated: true,
        deferredCoins: 1,
      }),
      runBudgetTruncationCount: 2,
      cursorTailState: "complete",
    } as StatusResponse["reserveComposition"]);
    const highShare = deriveReserveCompositionStatus({
      ...makeReserveComposition({
        runBudgetTruncated: true,
        deferredCoins: 3,
      }),
      runBudgetTruncationCount: 1,
      cursorTailState: "complete",
    } as StatusResponse["reserveComposition"]);

    expect(repeated.status).toBe("degraded");
    expect(highShare.status).toBe("degraded");
  });

  it("degrades reserve status for incomplete deferred-tail state or uncertain writes", () => {
    const incompleteTail = deriveReserveCompositionStatus({
      ...makeReserveComposition({
        runBudgetTruncated: true,
        deferredCoins: 1,
      }),
      cursorTailState: "incomplete",
    } as StatusResponse["reserveComposition"]);
    const uncertainWrite = deriveReserveCompositionStatus(makeReserveComposition({
      writeTimeoutUncertain: 1,
    }));

    expect(incompleteTail.status).toBe("degraded");
    expect(uncertainWrite.status).toBe("degraded");
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

  it("uses the same durable alert floor for admin availability", () => {
    const availability = deriveAvailabilityStatus({
      publicHealth: makePublicHealth({
        alertBrokerImpactStatus: "degraded",
        alertBroker: {
          ...makePublicHealth().alertBroker,
          activeCount: 1,
          criticalActiveCount: 1,
          activeConditionKeys: ["cron:sync-live-reserves"],
        },
      }),
      availabilityImpactingCronErrors: 0,
      availabilityImpactingUnhealthyCrons: 0,
      availabilityImpactingConsecutiveCronErrors: 0,
    });

    expect(availability).toBe("degraded");
  });

  it("uses the D1 capacity floor for admin availability", () => {
    const availability = deriveAvailabilityStatus({
      publicHealth: makePublicHealth({
        d1CapacityImpactStatus: "stale",
      }),
      availabilityImpactingCronErrors: 0,
      availabilityImpactingUnhealthyCrons: 0,
      availabilityImpactingConsecutiveCronErrors: 0,
    });

    expect(availability).toBe("stale");
  });
});

describe("status cause text", () => {
  it("groups DEWS stale health downstream of DEX liquidity", () => {
    const causes = buildAvailabilityCauses({
      publicHealth: makePublicHealth({
        caches: {
          "dex-liquidity": {
            ageSeconds: 8_000,
            maxAge: 7_200,
            healthy: false,
          },
          dews: {
            ageSeconds: 8_100,
            maxAge: 7_200,
            healthy: false,
          },
        },
        worstCacheRatio: 1.2,
      }),
      availabilityImpactingUnhealthyCrons: 0,
      watchUnhealthyCrons: 0,
      degradedCronRuns: 0,
      cronErrorCount: 0,
      availabilityImpactingCronErrors: 0,
      availabilityImpactingConsecutiveCronErrors: 0,
      cronHistoryQueryFailed: false,
      cronProgressQueryFailed: false,
      cronLeaseQueryFailed: false,
    });

    expect(causes).toContainEqual(expect.objectContaining({
      code: "dews_downstream_of_dex_liquidity",
      severity: "warning",
      metric: "dexLiquidityAgeSeconds",
      value: 8_000,
    }));
  });

  it("gives mint/burn query failure precedence over stale public classification", () => {
    const causes = buildAvailabilityCauses(makeAvailabilityCauseInput(makePublicHealth({
      mintBurnImpactStatus: "stale",
      mintBurnQueryError: "Mint/burn health data unavailable.",
      mintBurnLastRunStatus: "error",
      mintBurn: {
        ...makePublicHealth().mintBurn,
        sync: {
          lastSuccessfulSyncAt: null,
          freshnessStatus: "stale",
          warning: "Mint/burn sync freshness is stale versus the 30-minute cron cadence.",
          criticalLaneHealthy: false,
        },
      },
    })));

    expect(causes).toContainEqual(expect.objectContaining({
      code: "mint_burn_health_query_failed",
      severity: "info",
      message:
        "Mint/burn health query failed; diagnostics are temporarily unavailable. " +
        "Latest critical cron run status: error.",
    }));
    expect(causes.some((cause) => cause.code === "mint_burn_public_stale")).toBe(false);
  });

  it("emits stale mint/burn cause when the timestamp query succeeds with no recent sync", () => {
    const causes = buildAvailabilityCauses(makeAvailabilityCauseInput(makePublicHealth({
      mintBurnImpactStatus: "stale",
      mintBurnQueryError: null,
      mintBurnLastRunStatus: "error",
      mintBurn: {
        ...makePublicHealth().mintBurn,
        sync: {
          lastSuccessfulSyncAt: null,
          freshnessStatus: "stale",
          warning: "Mint/burn sync freshness is stale versus the 30-minute cron cadence.",
          criticalLaneHealthy: false,
        },
      },
    })));

    expect(causes).toContainEqual(expect.objectContaining({
      code: "mint_burn_public_stale",
      severity: "critical",
    }));
    expect(causes.some((cause) => cause.code === "mint_burn_health_query_failed")).toBe(false);
  });

  it("includes persistent stale independent feed details in degraded reserve sync causes", () => {
    const reserveComposition = makeReserveComposition({
      status: "degraded",
      persistentlyStaleIndependentCoins: [
        { stablecoinId: "coin-a", ageSec: 1_500_000 },
        { stablecoinId: "coin-b", ageSec: 1_400_000 },
        { stablecoinId: "coin-c", ageSec: 1_300_000 },
        { stablecoinId: "coin-d", ageSec: 1_200_000 },
      ],
    });

    const causes = buildDataQualityCauses({
      dataQuality: makeDataQuality(),
      missingPriceRatio: 0,
      blacklistMissingRatio: 0,
      blacklistRecentMissing: 0,
      onchainAssessmentCauses: [],
      reserveCompositionQueryFailed: false,
      reserveComposition,
    });

    expect(causes).toContainEqual(expect.objectContaining({
      code: "reserve_sync_degraded",
      message: expect.stringContaining("4 persistently stale independent feed(s) (coin-a, coin-b, coin-c, +1 more)."),
    }));
  });

  it("emits a warning cause for one-off low-share reserve truncation", () => {
    const reserveComposition = {
      ...makeReserveComposition({
        status: "healthy",
        runBudgetTruncated: true,
        deferredCoins: 1,
        nextCursorStablecoinId: "coin-a",
      }),
      cursorTailState: "complete",
      runBudgetTruncationCount: 1,
    } as StatusResponse["reserveComposition"];

    const causes = buildDataQualityCauses({
      dataQuality: makeDataQuality(),
      missingPriceRatio: 0,
      blacklistMissingRatio: 0,
      blacklistRecentMissing: 0,
      onchainAssessmentCauses: [],
      reserveCompositionQueryFailed: false,
      reserveComposition,
    });

    expect(causes).toContainEqual(expect.objectContaining({
      code: "reserve_sync_budget_truncated",
      severity: "warning",
      message: expect.stringContaining("deferred 1 coin(s)"),
    }));
  });

  it("emits a distinct warning cause for DDR repair debt", () => {
    const causes = buildDataQualityCauses({
      dataQuality: makeDataQuality({
        ddrRepairDebtStatus: "present",
        ddrRepairDebtCount: 2,
        ddrRepairDebtCheckedAt: 1_700_000_000,
        ddrRepairDebtEvents: [
          { eventId: 42, reason: "incident-conflict" },
          { eventId: 43, reason: "incident-conflict" },
        ],
      }),
      missingPriceRatio: 0,
      blacklistMissingRatio: 0,
      blacklistRecentMissing: 0,
      onchainAssessmentCauses: [],
      reserveCompositionQueryFailed: false,
      reserveComposition: makeReserveComposition(),
    });

    expect(causes).toContainEqual(expect.objectContaining({
      code: "ddr_repair_debt_present",
      severity: "warning",
      metric: "ddrRepairDebtCount",
      value: 2,
    }));
  });

  it("emits reserve causes for truncation, incomplete tail state, and uncertain writes", () => {
    const reserveComposition = {
      ...makeReserveComposition({
        status: "degraded",
        runBudgetTruncated: true,
        deferredCoins: 3,
        nextCursorStablecoinId: "coin-tail",
      writeTimeoutUncertain: 1,
      }),
      cursorTailState: "incomplete",
      cursorTailError: "batch unavailable",
      runBudgetTruncationCount: 2,
      historyWriteGaps: [
        {
          stablecoinId: "coin-history",
          fetchedAt: 1_700_000_000,
          attemptId: "coin-history:attempt",
          compositionHistoryMissing: true,
          attemptHistoryMissing: true,
        },
      ],
    } as StatusResponse["reserveComposition"];

    const causes = buildDataQualityCauses({
      dataQuality: makeDataQuality(),
      missingPriceRatio: 0,
      blacklistMissingRatio: 0,
      blacklistRecentMissing: 0,
      onchainAssessmentCauses: [],
      reserveCompositionQueryFailed: false,
      reserveComposition,
    });

    expect(causes).toContainEqual(expect.objectContaining({
      code: "reserve_sync_write_uncertain",
      severity: "warning",
    }));
    expect(causes).toContainEqual(expect.objectContaining({
      code: "reserve_sync_tail_incomplete",
      message: expect.stringContaining("batch unavailable"),
    }));
    expect(causes).toContainEqual(expect.objectContaining({
      code: "reserve_sync_budget_truncated",
      message: expect.stringContaining("next cursor coin-tail"),
    }));
    expect(causes).toContainEqual(expect.objectContaining({
      code: "reserve_sync_history_write_gap",
      message: expect.stringContaining("coin-history:composition+attempt"),
    }));
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

  it("excludes mintBurnImpactStatus from availability when mintBurnQueryError is set", () => {
    expect(
      deriveAvailabilityStatus({
        ...baseInput,
        publicHealth: makePublicHealth({
          mintBurnImpactStatus: "stale",
          mintBurnQueryError: "Mint/burn health data unavailable.",
          mintBurnLastRunStatus: "error",
        }),
      }),
    ).toBe("healthy");
  });
});
