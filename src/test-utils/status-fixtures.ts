import type { HealthResponse, StatusResponse } from "@shared/types";

/**
 * Healthy baseline `StatusResponse` fixture used by admin section tests.
 * Mutate via the {@link degraded} helper instead of editing inline so each
 * test describes its intent via a minimal patch.
 */
export function makeHealthyStatusResponse(): StatusResponse {
  return {
    timestamp: 1_700_000_000,
    dbHealthy: true,
    availabilityStatus: "healthy",
    dataQualityStatus: "healthy",
    rawOverallStatus: "healthy",
    overallStatus: "healthy",
    confidence: 1,
    causes: {
      availability: [],
      dataQuality: [],
      overall: [],
    },
    state: {
      scope: "global",
      currentStatus: "healthy",
      rawStatus: "healthy",
      lastEvaluatedAt: 1_700_000_000,
      lastChangedAt: 1_699_990_000,
      minDwellSec: 120,
      staleMinDwellSec: 180,
      consecutiveRaw: {
        healthy: 10,
        degraded: 0,
        stale: 0,
      },
      thresholds: {
        escalateToDegraded: 2,
        escalateToStale: 1,
        recoverToDegraded: 2,
        recoverToHealthy: 3,
      },
    },
    staleness: {
      ageSeconds: 5,
      maxAgeSec: 60,
      isStale: false,
    },
    probe: {
      timestamp: 1_700_000_000,
      status: "healthy",
      sampleCount: 4,
      passCount: 4,
      failCount: 0,
      p95LatencyMs: 80,
    },
    discrepancy: {
      hasDivergence: false,
      severityDelta: 0,
      statusSeverity: 0,
      probeSeverity: 0,
      details: null,
      probeAgeSeconds: 5,
      consecutiveDivergent: 0,
      discrepancyReason: "in-sync",
    },
    timeline: [],
    caches: {},
    crons: {
      "dispatch-telegram-alerts": {
        lastRun: {
          startedAt: 1_699_999_940,
          durationMs: 200,
          status: "ok",
        },
        recentRuns: [
          { startedAt: 1_699_999_940, durationMs: 200, status: "ok" },
        ],
        expectedIntervalSec: 60,
        healthy: true,
      },
    },
    budgetOnlySurfaces: [],
    dataQuality: {
      stablecoinsCacheStatus: "ok",
      stablecoinsCacheReason: null,
      blacklistGapStatus: "ok",
      activeDepegStatus: "ok",
      ddrRepairDebtStatus: "ok",
      repairDebt: {
        status: "ok",
        openCount: 0,
        oldestAgeSec: null,
        byKind: {},
        availabilityEscalated: false,
        nextRunnerDueAt: null,
        source: "worker-repair-tasks",
      },
      ddrRepairDebtCount: 0,
      ddrRepairDebtCheckedAt: null,
      ddrRepairDebtEvents: [],
      ddrRepairDebtEventsTruncated: false,
      onchainSupplyQueryStatus: "ok",
      sourceFailures: [],
      totalStablecoins: 190,
      missingPrices: 0,
      blacklistMissingAmounts: 0,
      blacklistRecentMissingAmounts: 0,
      blacklistRecentWindowSec: 86_400,
      blacklistMissingRatio: 0,
      blacklistTotal: 0,
      blacklistOldestRecoverableAgeSec: null,
      blacklistNeverAttemptedCount: 0,
      blacklistRepeatedFailureCount: 0,
      onchainSupplyDivergences: 0,
      onchainDivergenceRatio: 0,
      onchainSupplyMonitoring: "active",
      onchainSupplyLatestAt: 1_699_999_000,
      onchainSupplyTrackedCoins: 50,
      activeDepegs: 0,
      staleOnchainSupply: 0,
      onchainStaleRatio: 0,
    },
    telegramBot: {
      totalChats: 10,
      alertEnabledChats: 8,
      deliverableChats: 8,
      subscribedChats: 6,
      emptyAlertChats: 0,
      mutedChatsWithSubscriptions: 0,
      totalSubscriptions: 15,
      avgSubscriptionsPerSubscribedChat: 2.5,
      pendingDisambiguations: 0,
      pendingDeliveries: 0,
      lastSubscriberActivityAt: 1_699_999_000,
      customPreferenceChats: 1,
      quietHoursEnabledChats: 2,
      alertTypeChats: {
        dews: 3,
        depeg: 4,
        safety: 2,
        launch: 1,
        reserve: 1,
        allTypes: 2,
      },
      topStablecoins: [],
    },
    sectionErrors: {},
    datasetFreshness: {
      stablecoins: 1_699_999_000,
      blacklist: 1_699_999_000,
      mintBurn: 1_699_999_000,
      supply: 1_699_999_000,
      safetyGrades: 1_699_999_000,
      yield: 1_699_999_000,
      depegs: 1_699_999_000,
      dews: 1_699_999_000,
      digest: 1_699_999_000,
      discoveryCandidates: 1_699_999_000,
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
      worstCacheRatio: 0.5,
      transitionsLast24h: 0,
    },
    liquidityHealth: null,
    yieldHealth: null,
    publicationHealth: null,
    dependencyHealth: null,
    providerCircuitHealth: null,
    canaries: null,
    priceSourceHealth: null,
    priceProviderDiagnostics: null,
    gtProbe: null,
    coingeckoPriceDiff: null,
    d1Usage: null,
    discoveryCandidates: null,
    mintBurnReconciliation: null,
    reserveComposition: {
      configuredCoins: 100,
      freshCoins: 100,
      staleCoins: 0,
      missingCoins: 0,
      degradedCoins: 0,
      errorCoins: 0,
      corruptCoins: 0,
      independentFreshEligible: 60,
      independentFreshUnverified: 0,
      staticValidatedFresh: 30,
      weakProbeFresh: 10,
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
      lastSuccessAt: 1_699_999_000,
      oldestFreshAgeSec: 1_000,
      status: "healthy",
      freshCoverageRatio: 1,
      authoritativeFreshCoverageRatio: 1,
    },
    reserveDrift: [],
    classificationWarnings: [],
  };
}

/**
 * Returns a new StatusResponse derived from `base` with the given top-level
 * mutations shallow-merged. Used to shape degraded test states without
 * repeating the healthy baseline.
 */
export function degraded(base: StatusResponse, mutations: Partial<StatusResponse>): StatusResponse {
  return { ...base, ...mutations };
}

export function makePublicationFailureStatusResponse(base = makeHealthyStatusResponse()): StatusResponse {
  return degraded(base, {
    publicationHealth: {
      checkedAt: base.timestamp,
      surfaces: {
        "dex-liquidity": {
          surface: "dex-liquidity",
          label: "DEX Liquidity",
          sourceOfTruth: "dex_liquidity_publications",
          lastPublishedGeneration: null,
          lastAttemptedGeneration: null,
          lastFailureReason: "publication_query_failed",
          candidateAgeSec: null,
          dependencyWatermarks: null,
        },
      },
      failedSurfaces: [
        {
          surface: "dex-liquidity",
          code: "publication_query_failed",
          message: "Publication ledger latest-generation query failed.",
        },
      ],
    },
  });
}

export function makeScheduledSlotRunningQueryFailedStatusResponse(base = makeHealthyStatusResponse()): StatusResponse {
  return degraded(base, {
    summary: {
      ...base.summary,
      scheduledSlotRunningQueryFailed: true,
    },
  });
}

export function makeScheduledSlotEventMarkerQueryFailedStatusResponse(base = makeHealthyStatusResponse()): StatusResponse {
  return degraded(base, {
    summary: {
      ...base.summary,
      scheduledSlotEventMarkerQueryFailed: true,
    },
  });
}

export function makeHealthyHealthResponse(): HealthResponse {
  return {
    status: "healthy",
    timestamp: 1_700_000_000,
    warnings: [],
    caches: {},
    blacklist: {
      totalEvents: 0,
      missingAmounts: 0,
      recentMissingAmounts: 0,
      recentWindowSec: 86_400,
      missingRatio: 0,
    },
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
    circuits: {},
  };
}
