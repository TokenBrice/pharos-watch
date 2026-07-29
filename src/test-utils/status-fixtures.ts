import type { EndpointProbeResult, HealthResponse, StatusResponse, StatusSectionKey } from "@shared/types";

export const STATUS_FIXTURE_NOW_SECONDS = 1_700_000_000;
export const STATUS_FIXTURE_NOW_MS = STATUS_FIXTURE_NOW_SECONDS * 1_000;

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
          metadata: {
            subscribersNotified: 0,
            messagesSent: 0,
            freshAttempted: 0,
            freshSent: 0,
            freshRetryQueued: 0,
            freshPermanentFailures: 0,
            pendingAttempted: 0,
            pendingDrained: 0,
            pendingRetryQueued: 0,
            pendingDroppedPermanentFailure: 0,
            pendingDroppedMaxAttemptsFallback: 0,
            pendingRateLimited: false,
            safetyAlertsSuppressed: false,
            reserveAlertsSuppressed: false,
          },
        },
        recentRuns: [{ startedAt: 1_699_999_940, durationMs: 200, status: "ok" }],
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
      explicitCoinSubscriptions: 12,
      presetImpliedCoinSubscriptions: 3,
      activePresetFollowers: 2,
      avgSubscriptionsPerSubscribedChat: 2.5,
      pendingDisambiguations: 0,
      pendingDeliveries: 0,
      oldestPendingDeliveryAgeSec: null,
      oldestDuePendingAgeSec: null,
      estimatedDrainTimeSec: 0,
      pendingDeliveryBacklog: {
        claimable: 0,
        due: 0,
        deferred: 0,
        expired: 0,
        nearTtl: 0,
        executionUnknown: 0,
        completedPendingCleanup: 0,
      },
      retryErrorClassCounts: {},
      webhookEffectUnknown: 0,
      deliverySli: {
        availability: "unavailable",
        quality: "unavailable",
        freshness: "unknown",
        acceptanceDefinition: "telegram_bot_api_accepted_not_user_receipt",
        rollup: null,
        error: {
          code: "telegram_delivery_sli_query_failed",
          message: "Telegram delivery SLI telemetry unavailable.",
        },
      },
      quality: { status: "complete", unavailableFields: [] },
      lastSubscriberActivityAt: 1_699_999_000,
      customPreferenceChats: 1,
      quietHoursEnabledChats: 2,
      alertTypeChats: {
        dews: 3,
        depeg: 4,
        safety: 2,
        launch: 1,
        reserve: 1,
        freeze: 1,
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

export function makeScheduledSlotEventMarkerQueryFailedStatusResponse(
  base = makeHealthyStatusResponse(),
): StatusResponse {
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

export function makeFullyHealthyCurrentStatusResponse(): StatusResponse {
  return makeHealthyStatusResponse();
}

export function makeMaintenanceDebtStatusResponse(base = makeHealthyStatusResponse()): StatusResponse {
  const cause = {
    code: "ddr_repair_debt_present",
    layer: "data-quality" as const,
    severity: "warning" as const,
    message: "4 fixture source events are quarantined pending planned repair migration.",
    metric: "ddrRepairDebtCount",
    value: 4,
    threshold: 1,
  };

  return degraded(base, {
    causes: {
      availability: [...base.causes.availability],
      dataQuality: [...base.causes.dataQuality, cause],
      overall: [...base.causes.overall, cause],
    },
    dataQuality: {
      ...base.dataQuality,
      ddrRepairDebtStatus: "present",
      ddrRepairDebtCount: 4,
      ddrRepairDebtCheckedAt: base.timestamp - 30,
      ddrRepairDebtEvents: [
        { eventId: 101, reason: "fixture-source-repair" },
        { eventId: 102, reason: "fixture-source-repair" },
      ],
      repairDebt: {
        status: "present",
        openCount: 4,
        oldestAgeSec: 7_200,
        byKind: {
          "fixture-source-repair": {
            openCount: 4,
            oldestAgeSec: 7_200,
            nextRunnerDueAt: base.timestamp + 900,
          },
        },
        availabilityEscalated: false,
        nextRunnerDueAt: base.timestamp + 900,
        source: "worker-repair-tasks",
      },
    },
  });
}

export function makeDegradedPublicImpactStatusResponse(base = makeHealthyStatusResponse()): StatusResponse {
  const cause = {
    code: "cache_ratio_degraded",
    layer: "availability" as const,
    severity: "warning" as const,
    message: "Fixture public cache freshness exceeded the degraded threshold.",
    metric: "worstCacheRatio",
    value: 1.5,
    threshold: 1,
  };

  return degraded(base, {
    availabilityStatus: "degraded",
    rawOverallStatus: "degraded",
    overallStatus: "degraded",
    causes: {
      availability: [...base.causes.availability, cause],
      dataQuality: [...base.causes.dataQuality],
      overall: [...base.causes.overall, cause],
    },
    state: {
      ...base.state,
      currentStatus: "degraded",
      rawStatus: "degraded",
      lastChangedAt: base.timestamp - 300,
      consecutiveRaw: { healthy: 0, degraded: 3, stale: 0 },
    },
    summary: {
      ...base.summary,
      worstCacheRatio: 1.5,
    },
  });
}

export function makeDegradedPublicHealthResponse(base = makeHealthyHealthResponse()): HealthResponse {
  return {
    ...base,
    status: "degraded",
    warnings: ["Fixture public cache freshness is degraded."],
  };
}

export function makeRecoveryHoldStatusResponse(base = makeHealthyStatusResponse()): StatusResponse {
  return degraded(base, {
    rawOverallStatus: "healthy",
    overallStatus: "degraded",
    state: {
      ...base.state,
      currentStatus: "degraded",
      rawStatus: "healthy",
      lastChangedAt: base.timestamp - 90,
      consecutiveRaw: { healthy: 2, degraded: 0, stale: 0 },
    },
  });
}

export function makeSectionLoaderFailureStatusResponse(
  base = makeHealthyStatusResponse(),
  section: StatusSectionKey = "dependencyHealth",
): StatusResponse {
  return degraded(base, {
    sectionErrors: {
      ...base.sectionErrors,
      [section]: {
        code: `fixture_${section}_query_failed`,
        message: "Fixture section loader failed without exposing production data.",
      },
    },
  });
}

export function makeOperationalDependencyFailureStatusResponse(base = makeHealthyStatusResponse()): StatusResponse {
  const cause = {
    code: "fixture_operational_dependency_failure",
    layer: "system" as const,
    severity: "warning" as const,
    message: "Fixture canary, dependency, and provider-circuit evidence is degraded.",
  };

  return degraded(base, {
    rawOverallStatus: "degraded",
    overallStatus: "degraded",
    causes: {
      availability: [...base.causes.availability],
      dataQuality: [...base.causes.dataQuality],
      overall: [...base.causes.overall, cause],
    },
    state: {
      ...base.state,
      currentStatus: "degraded",
      rawStatus: "degraded",
      lastChangedAt: base.timestamp - 180,
      consecutiveRaw: { healthy: 0, degraded: 2, stale: 0 },
    },
    dependencyHealth: {
      checkedAt: base.timestamp,
      dependencies: {
        "fixture-market-cache": {
          id: "fixture-market-cache",
          label: "Fixture market cache",
          sourceOfTruth: "fixture-cache-store",
          producerJob: "fixture-sync-job",
          cacheKey: "fixture:market-cache",
          publicationSurface: null,
          impactLayer: "availability",
          criticality: "critical",
          dependsOn: [],
          consumers: ["fixture-public-reader"],
          status: "stale",
          checkedAt: base.timestamp,
          updatedAt: base.timestamp - 7_200,
          ageSeconds: 7_200,
          maxAgeSec: 900,
          reason: "Fixture dependency exceeded its freshness budget.",
          runbookPath: "/docs/runbooks/fixture-dependency.md",
        },
      },
      rootCauseGroups: [
        {
          rootDependencyId: "fixture-market-cache",
          rootStatus: "stale",
          rootReason: "Fixture dependency exceeded its freshness budget.",
          symptomDependencyIds: [],
          impactedDependencyIds: ["fixture-market-cache"],
          consumerIds: ["fixture-public-reader"],
          criticality: "critical",
        },
      ],
      summary: {
        total: 1,
        healthy: 0,
        degraded: 0,
        stale: 1,
        unknown: 0,
        rootCauseGroupCount: 1,
      },
    },
    providerCircuitHealth: {
      checkedAt: base.timestamp,
      status: "stale",
      totalTracked: 1,
      closedCount: 0,
      halfOpenCount: 0,
      openCount: 1,
      openProviders: [
        {
          providerId: "fixture-provider-a",
          family: "fixture-pricing",
          state: "open",
          consecutiveFailures: 5,
          openedAt: base.timestamp - 600,
          openAgeSec: 600,
          lastFailureAt: base.timestamp - 30,
          lastSuccessAt: base.timestamp - 3_600,
        },
      ],
      byFamily: {
        "fixture-pricing": { total: 1, closed: 0, halfOpen: 0, open: 1 },
      },
    },
    canaries: {
      checkedAt: base.timestamp,
      status: "stale",
      latestRunAt: base.timestamp - 30,
      maxAgeSec: 900,
      totalChecks: 1,
      okCount: 0,
      degradedCount: 0,
      errorCount: 1,
      skippedCount: 0,
      staleCount: 0,
      checks: {
        "fixture-publication-check": {
          checkId: "fixture-publication-check",
          label: "Fixture publication invariant",
          description: "Checks a synthetic publication contract.",
          status: "error",
          severity: "critical",
          observedAt: base.timestamp - 30,
          durationMs: 125,
          error: "Fixture publication invariant failed.",
        },
      },
    },
    summary: {
      ...base.summary,
      canaryTotalChecks: 1,
      canaryErrorCount: 1,
      canaryDegradedCount: 0,
      canarySkippedCount: 0,
      canaryStaleCount: 0,
      diagnosticIssueCount: base.summary.diagnosticIssueCount + 3,
    },
  });
}

export function makeActionRecommendedStatusResponse(base = makeHealthyStatusResponse()): StatusResponse {
  const cause = {
    code: "missing_prices_stale",
    layer: "data-quality" as const,
    severity: "critical" as const,
    message: "Fixture price coverage is stale and requires a guarded backfill.",
    metric: "missingPrices",
    value: 12,
    threshold: 8,
  };

  return degraded(base, {
    dataQualityStatus: "stale",
    rawOverallStatus: "stale",
    overallStatus: "stale",
    causes: {
      availability: [...base.causes.availability],
      dataQuality: [...base.causes.dataQuality, cause],
      overall: [...base.causes.overall, cause],
    },
    dataQuality: {
      ...base.dataQuality,
      missingPrices: 12,
    },
    state: {
      ...base.state,
      currentStatus: "stale",
      rawStatus: "stale",
      lastChangedAt: base.timestamp - 240,
      consecutiveRaw: { healthy: 0, degraded: 0, stale: 2 },
    },
  });
}

export function makeActionBlockedStatusResponse(base = makeActionRecommendedStatusResponse()): StatusResponse {
  const dbCause = {
    code: "db_unhealthy",
    layer: "system" as const,
    severity: "critical" as const,
    message: "Fixture D1 write path is unavailable; mutation actions must remain blocked.",
  };

  return degraded(base, {
    dbHealthy: false,
    availabilityStatus: "stale",
    causes: {
      availability: [...base.causes.availability, dbCause],
      dataQuality: [...base.causes.dataQuality],
      overall: [...base.causes.overall, dbCause],
    },
    reserveComposition: {
      ...base.reserveComposition,
      writeTimeoutUncertain: 1,
      cursorTailError: "Fixture deferred cursor tail failed.",
      status: "degraded",
    },
  });
}

export function makeLongCommsStatusResponse(base = makeHealthyStatusResponse()): StatusResponse {
  const perAlertType = {
    dews: { sent: 125, enqueued: 3, failed: 1, blocked: 0, firstSendLatencyMs: 12_345 },
    depeg: { sent: 84, enqueued: 5, failed: 2, blocked: 1, firstSendLatencyMs: 23_456 },
    safety: { sent: 43, enqueued: 8, failed: 3, blocked: 0, firstSendLatencyMs: 34_567 },
    launch: { sent: 21, enqueued: 13, failed: 0, blocked: 2, firstSendLatencyMs: 45_678 },
    reserve: { sent: 17, enqueued: 2, failed: 1, blocked: 0, firstSendLatencyMs: 56_789 },
    freeze: { sent: 9, enqueued: 1, failed: 0, blocked: 0, firstSendLatencyMs: 67_890 },
  };

  return degraded(base, {
    telegramBot: {
      ...base.telegramBot!,
      totalChats: 240,
      alertEnabledChats: 210,
      deliverableChats: 198,
      totalSubscriptions: 1_250,
      explicitCoinSubscriptions: 1_075,
      presetImpliedCoinSubscriptions: 175,
      activePresetFollowers: 48,
      pendingDeliveries: 29,
      pendingDisambiguations: 7,
      lastSubscriberActivityAt: base.timestamp - 98_765,
      oldestPendingDeliveryAgeSec: 54_321,
      pendingDeliveryBacklog: { due: 17, deferred: 9, expired: 3, nearTtl: 4 },
      retryErrorClassCounts: {
        gateway_timeout_after_fixture_retry_budget: 11,
        fixture_rate_limit: 7,
      },
      lifecycleSnapshot: {
        date: "2023-10-31",
        snapshotAt: base.timestamp - 12_345_678,
        activeWatchers: 198,
        newWatchers: 18,
        churnedWatchers: 9,
        reactivatedWatchers: 4,
        explicitCoinFollows: 1_075,
        presetImpliedCoinFollows: 175,
        activePresetFollowers: 48,
        alertTypeOptIns: {
          dews: 180,
          depeg: 175,
          safety: 160,
          launch: 145,
          reserve: 120,
          freeze: 110,
          allTypes: 95,
        },
        quietHoursEnabledChats: 88,
        pendingDeliveries: 29,
      },
      topStablecoins: [
        {
          stablecoinId: "fixture-dollar-alpha",
          symbol: "FXA",
          subscribers: 144,
          explicitSubscribers: 120,
          presetImpliedSubscribers: 24,
        },
      ],
    },
    crons: {
      ...base.crons,
      "dispatch-telegram-alerts": {
        ...base.crons["dispatch-telegram-alerts"],
        lastRun: {
          startedAt: base.timestamp - 7_654,
          durationMs: 98_765,
          status: "degraded",
          itemCount: 290,
          metadata: {
            subscribersNotified: 198,
            messagesSent: 290,
            pendingAttempted: 41,
            pendingDrained: 12,
            pendingRetryQueued: 9,
            pendingDeferred: 17,
            pendingDropped: 3,
            pendingEnqueued: 29,
            pendingRetryAfterSec: 3_600,
            perAlertType,
          },
        },
        recentRuns: [
          {
            startedAt: base.timestamp - 7_654,
            durationMs: 98_765,
            status: "degraded",
            itemCount: 290,
            metadata: { perAlertType },
          },
        ],
        healthy: false,
      },
    },
  });
}

export interface StatusDashboardModelFixtureInputs {
  data: StatusResponse;
  healthData: HealthResponse | null | undefined;
  probes: EndpointProbeResult[] | undefined;
  querySyncs: {
    statusUpdatedAt: number;
    healthUpdatedAt: number;
    probesUpdatedAt: number;
    historyUpdatedAt: number;
    requestSourceUpdatedAt: number;
  };
  nowMs: number;
  statusError: Error | null;
  healthError: Error | null;
  probesError: Error | null;
  historyError: Error | null;
  requestSourceError: Error | null;
  historyTransitions: StatusResponse["timeline"] | undefined;
}

type StatusDashboardModelFixtureOverrides = Omit<Partial<StatusDashboardModelFixtureInputs>, "querySyncs"> & {
  querySyncs?: Partial<StatusDashboardModelFixtureInputs["querySyncs"]>;
};

export function makeCurrentStatusDashboardInputs(
  overrides: StatusDashboardModelFixtureOverrides = {},
): StatusDashboardModelFixtureInputs {
  const updatedAt = STATUS_FIXTURE_NOW_MS - 10_000;
  const base: StatusDashboardModelFixtureInputs = {
    data: makeFullyHealthyCurrentStatusResponse(),
    healthData: makeHealthyHealthResponse(),
    probes: [
      { path: "/fixture/status", status: 200, latencyMs: 75, semanticStatus: "healthy" },
      { path: "/fixture/health", status: 200, latencyMs: 90, semanticStatus: "healthy" },
    ],
    querySyncs: {
      statusUpdatedAt: updatedAt,
      healthUpdatedAt: updatedAt,
      probesUpdatedAt: updatedAt,
      historyUpdatedAt: updatedAt,
      requestSourceUpdatedAt: updatedAt,
    },
    nowMs: STATUS_FIXTURE_NOW_MS,
    statusError: null,
    healthError: null,
    probesError: null,
    historyError: null,
    requestSourceError: null,
    historyTransitions: [],
  };

  return {
    ...base,
    ...overrides,
    querySyncs: { ...base.querySyncs, ...overrides.querySyncs },
  };
}

export function makeMissingNeverLoadedEvidenceInputs(): StatusDashboardModelFixtureInputs {
  return makeCurrentStatusDashboardInputs({
    healthData: null,
    probes: undefined,
    historyTransitions: undefined,
    querySyncs: {
      healthUpdatedAt: 0,
      probesUpdatedAt: 0,
      historyUpdatedAt: 0,
      requestSourceUpdatedAt: 0,
    },
  });
}

export function makeStaleEvidenceInputs(): StatusDashboardModelFixtureInputs {
  const staleAt = STATUS_FIXTURE_NOW_MS - 10 * 60_000;
  return makeCurrentStatusDashboardInputs({
    querySyncs: {
      statusUpdatedAt: staleAt,
      healthUpdatedAt: staleAt,
      probesUpdatedAt: staleAt,
    },
  });
}

export function makeBackgroundRefreshFailureInputs(): StatusDashboardModelFixtureInputs {
  return makeCurrentStatusDashboardInputs({
    statusError: new Error("Fixture status refresh failed; retained last-good data."),
    healthError: new Error("Fixture health refresh failed; retained last-good data."),
    probesError: new Error("Fixture probe refresh failed; retained last-good data."),
  });
}
