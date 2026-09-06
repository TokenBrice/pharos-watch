import { describe, expect, it } from "vitest";
import { PublicStatusHistoryResponseSchema, StatusHistoryResponseSchema, StatusResponseSchema } from "../status";

function reserveComposition() {
  return {
    configuredCoins: 267,
    freshCoins: 250,
    staleCoins: 4,
    missingCoins: 3,
    degradedCoins: 5,
    errorCoins: 2,
    corruptCoins: 1,
    independentFreshEligible: 140,
    independentFreshUnverified: 8,
    staticValidatedFresh: 60,
    weakProbeFresh: 42,
    writeTimeoutUncertain: 1,
    deferredCoins: 12,
    runBudgetTruncated: true,
    deferredAt: 1_780_000_000,
    nextCursorStablecoinId: "usdc-circle",
    cursorTailState: "incomplete",
    cursorTailError: "cursor write failed",
    cursorRecordedAt: 1_780_000_010,
    cursorTailCompletedAt: null,
    cursorTailFailedAt: 1_780_000_020,
    runBudgetTruncationCount: 2,
    historyWriteGaps: [
      {
        stablecoinId: "usdc-circle",
        fetchedAt: 1_780_000_030,
        attemptId: "attempt-1",
        compositionHistoryMissing: true,
        attemptHistoryMissing: false,
      },
    ],
    persistentlyStaleIndependentCoins: [
      { stablecoinId: "hbusdt-hyperbeat", ageSec: 1_300_000 },
    ],
    lastSuccessAt: 1_780_000_030,
    oldestFreshAgeSec: 3_600,
    status: "degraded",
    freshCoverageRatio: 0.93,
    authoritativeFreshCoverageRatio: 0.74,
  };
}

function statusResponse() {
  return {
    timestamp: 1_780_000_100,
    dbHealthy: true,
    availabilityStatus: "healthy",
    dataQualityStatus: "degraded",
    rawOverallStatus: "degraded",
    overallStatus: "degraded",
    confidence: 0.95,
    causes: { availability: [], dataQuality: [], overall: [] },
    state: {
      scope: "global",
      currentStatus: "degraded",
      rawStatus: "degraded",
      lastEvaluatedAt: 1_780_000_100,
      lastChangedAt: 1_780_000_000,
      minDwellSec: 120,
      staleMinDwellSec: 180,
      consecutiveRaw: { healthy: 0, degraded: 2, stale: 0 },
      thresholds: {
        escalateToDegraded: 2,
        escalateToStale: 1,
        recoverToDegraded: 2,
        recoverToHealthy: 3,
      },
    },
    staleness: { ageSeconds: 10, maxAgeSec: 60, isStale: false },
    probe: {
      timestamp: 1_780_000_090,
      status: "healthy",
      sampleCount: 1,
      passCount: 1,
      failCount: 0,
      p95LatencyMs: 100,
    },
    discrepancy: {
      hasDivergence: false,
      severityDelta: 0,
      statusSeverity: 1,
      probeSeverity: 0,
      details: null,
      probeAgeSeconds: 10,
      consecutiveDivergent: 0,
      discrepancyReason: "in-sync",
    },
    timeline: [],
    caches: {},
    crons: {},
    budgetOnlySurfaces: [],
    dataQuality: {
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
      totalStablecoins: 0,
      missingPrices: 0,
      blacklistMissingAmounts: 0,
      blacklistRecentMissingAmounts: 0,
      blacklistRecentWindowSec: 0,
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
    },
    telegramBot: null,
    sectionErrors: {},
    datasetFreshness: {
      stablecoins: null,
      blacklist: null,
      mintBurn: null,
      supply: null,
      safetyGrades: null,
      yield: null,
      depegs: null,
      dews: null,
      digest: null,
    },
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
      transitionsLast24h: 0,
    },
    liquidityHealth: null,
    yieldHealth: null,
    publicationHealth: null,
    dependencyHealth: null,
    providerCircuitHealth: null,
    canaries: null,
    priceSourceHealth: null,
    coingeckoPriceDiff: null,
    d1Usage: null,
    mintBurnReconciliation: null,
    reserveComposition: reserveComposition(),
  };
}

describe("StatusResponseSchema reserve composition contract", () => {
  it("parses reserve sync cursor and history observability fields", () => {
    const parsed = StatusResponseSchema.parse(statusResponse());

    expect(parsed.reserveComposition).toMatchObject({
      cursorTailState: "incomplete",
      cursorTailError: "cursor write failed",
      runBudgetTruncationCount: 2,
      historyWriteGaps: [
        expect.objectContaining({
          stablecoinId: "usdc-circle",
          attemptId: "attempt-1",
        }),
      ],
    });
  });

  it.each([
    ["crons", { "sync-stablecoins": {} }],
    ["budgetOnlySurfaces", [{}]],
    ["dataQuality", {}],
    ["telegramBot", {}],
    ["datasetFreshness", {}],
    ["summary", {}],
    ["liquidityHealth", {}],
    ["yieldHealth", {}],
    ["publicationHealth", {}],
    ["dependencyHealth", {}],
    ["providerCircuitHealth", {}],
    ["canaries", {}],
    ["telegramSummary", {}],
    ["producerHeads", [{}]],
    ["priceSourceHealth", {}],
    ["coingeckoPriceDiff", {}],
    ["d1Usage", {}],
    ["mintBurnReconciliation", {}],
    ["reserveDrift", [{}]],
    ["classificationWarnings", [{}]],
  ] as const)("rejects malformed %s section", (section, value) => {
    const result = StatusResponseSchema.safeParse({
      ...statusResponse(),
      [section]: value,
    });
    expect(result.success, `${section} should fail closed`).toBe(false);
  });


  it("accepts older status payloads without hardening supplements", () => {
    const legacyPayload: Record<string, unknown> = { ...statusResponse() };
    for (const key of ["publicationHealth", "dependencyHealth", "providerCircuitHealth", "canaries"]) {
      delete legacyPayload[key];
    }

    const parsed = StatusResponseSchema.parse(legacyPayload);

    expect(parsed.publicationHealth).toBeNull();
    expect(parsed.dependencyHealth).toBeNull();
    expect(parsed.providerCircuitHealth).toBeNull();
    expect(parsed.canaries).toBeNull();
  });

  it("accepts additive publication-health failed surface metadata", () => {
    const parsed = StatusResponseSchema.parse({
      ...statusResponse(),
      publicationHealth: {
        checkedAt: 1_780_000_100,
        surfaces: {},
        failedSurfaces: [
          {
            surface: "yield-rankings",
            code: "publication_surface_query_failed",
            message: "Publication surface query failed.",
          },
        ],
      },
      sectionErrors: {
        publicationHealth: {
          code: "publication_health_partial_failure",
          message: "Publication health partially unavailable.",
        },
      },
    });

    expect(parsed.publicationHealth?.failedSurfaces).toEqual([
      {
        surface: "yield-rankings",
        code: "publication_surface_query_failed",
        message: "Publication surface query failed.",
      },
    ]);
  });

  it("rejects reserve composition payloads missing cursor observability fields", () => {
    const payload = statusResponse();
    const { cursorTailState: _cursorTailState, ...reserveWithoutCursorState } = payload.reserveComposition;

    const result = StatusResponseSchema.safeParse({
      ...payload,
      reserveComposition: reserveWithoutCursorState,
    });

    expect(result.success).toBe(false);
  });

  it("uses the same reserve composition contract for status history", () => {
    const result = StatusHistoryResponseSchema.safeParse({
      timestamp: 1_780_000_100,
      state: null,
      staleness: null,
      probe: statusResponse().probe,
      discrepancy: statusResponse().discrepancy,
      transitions: [],
      hasMore: false,
      reserveComposition: reserveComposition(),
    });

    expect(result.success).toBe(true);
  });

  it("validates public status history payloads", () => {
    const result = PublicStatusHistoryResponseSchema.safeParse({
      timestamp: 1_780_000_100,
      currentStatus: "degraded",
      lastChangedAt: 1_780_000_000,
      transitions: [
        {
          id: 1,
          from: "healthy",
          to: "degraded",
          transitionType: "degrade",
          reason: "cache stale",
          at: 1_780_000_000,
        },
      ],
    });

    expect(result.success).toBe(true);
  });

  it("rejects malformed public status history status values", () => {
    const result = PublicStatusHistoryResponseSchema.safeParse({
      timestamp: 1_780_000_100,
      currentStatus: "unknown",
      lastChangedAt: null,
      transitions: [],
    });

    expect(result.success).toBe(false);
  });

  it("rejects malformed public status history transition types", () => {
    const result = PublicStatusHistoryResponseSchema.safeParse({
      timestamp: 1_780_000_100,
      currentStatus: "healthy",
      lastChangedAt: null,
      transitions: [
        {
          id: 1,
          from: "healthy",
          to: "degraded",
          transitionType: "pause",
          reason: "cache stale",
          at: 1_780_000_000,
        },
      ],
    });

    expect(result.success).toBe(false);
  });
});
