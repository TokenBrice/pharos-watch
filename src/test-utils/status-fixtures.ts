import { REQUEST_SOURCE_POLICY_ID, type AttributionMeasurement, type ApiRequestAttributionResponse } from "@pharos/contracts/request-source";
import type {
  ActivePriceCoverageGap,
  ActivePriceCoverageHealth,
  EndpointProbeResult,
  HealthResponse,
  StatusResponse,
} from "@shared/types";
import { makeDataQuality, makeReserveComposition, makeStatusSummary } from "@shared/types/__tests__/status.test-support";
import { makeHealthyHealthResponse } from "@shared/test-utils/health-fixtures";

export const STATUS_FIXTURE_NOW_SECONDS = 1_700_000_000;
export const STATUS_FIXTURE_NOW_MS = STATUS_FIXTURE_NOW_SECONDS * 1_000;

export function makeMissingActiveAsset(overrides: Partial<ActivePriceCoverageGap> = {}): ActivePriceCoverageGap {
  return {
    stablecoinId: "test-dollar",
    symbol: "TUSD",
    marketCapUsd: 500_000,
    currentPrice: null,
    currentSource: null,
    currentObservedAt: null,
    currentConfidence: null,
    consecutiveMissingGenerations: 1,
    lastAcceptedPrice: null,
    lastAcceptedSource: null,
    lastAcceptedObservedAt: null,
    rejectionReason: "no-accepted-price",
    alertEligible: false,
    acknowledgedGap: null,
    ...overrides,
  };
}

export function makeActivePriceCoverage(
  missingAssets: ActivePriceCoverageGap[],
  overrides: Partial<ActivePriceCoverageHealth> = {},
): ActivePriceCoverageHealth {
  const alertEligibleIds = missingAssets.filter((asset) => asset.alertEligible && !asset.acknowledgedGap).map((asset) => asset.stablecoinId);
  const acknowledgedGapIds = missingAssets.filter((asset) => asset.acknowledgedGap).map((asset) => asset.stablecoinId);
  return {
    status: "incomplete",
    expectedActiveCount: 190,
    presentActiveCount: 190,
    pricedActiveCount: 190 - missingAssets.length,
    missingPriceCount: missingAssets.length,
    pricedActiveIds: [],
    missingActiveIds: missingAssets.map((asset) => asset.stablecoinId),
    affectedMarketCapUsd: missingAssets.reduce((sum, asset) => sum + (asset.marketCapUsd ?? 0), 0),
    missingActiveAssets: missingAssets,
    alertEligibleCount: alertEligibleIds.length,
    alertEligibleIds,
    acknowledgedGapIds,
    acknowledgedGapCount: acknowledgedGapIds.length,
    expiredGapReviewIds: [],
    invalidGapReviewIds: [],
    maxConsecutiveMissingGenerations: missingAssets.some((asset) => asset.consecutiveMissingGenerations == null)
      ? null : Math.max(0, ...missingAssets.map((asset) => asset.consecutiveMissingGenerations!)),
    observedAt: STATUS_FIXTURE_NOW_SECONDS,
    ...overrides,
  };
}

export function makeDispatchMetadata(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    subscribersNotified: 0,
    messagesSent: 0,
    pendingAttempted: 0,
    pendingDrained: 0,
    pendingRetryQueued: 0,
    pendingDroppedPermanentFailure: 0,
    pendingDroppedMaxAttemptsFallback: 0,
    pendingRateLimited: false,
    safetyAlertsSuppressed: false,
    reserveAlertsSuppressed: false,
    ...overrides,
  };
}

export function makeAvailableTelegramDeliverySli(): Extract<
  NonNullable<StatusResponse["telegramBot"]>["deliverySli"], { availability: "available" }
> {
  return {
    availability: "available",
    quality: "partial",
    freshness: "stale",
    acceptanceDefinition: "telegram_bot_api_accepted_not_user_receipt",
    rollup: {
      window: { generatedAt: STATUS_FIXTURE_NOW_SECONDS, startsAt: STATUS_FIXTURE_NOW_SECONDS - 86_400,
        endsAt: STATUS_FIXTURE_NOW_SECONDS, lookbackSec: 86_400, bounded: true },
      evidence: { latestAt: STATUS_FIXTURE_NOW_SECONDS - 3_600, ageSec: 3_600,
        freshness: "stale", freshnessThresholdSec: 600 },
      detectionToPlan: { eligibleCount: 28, observedCount: 28, averageSec: 10, maximumSec: 30, quality: "complete" },
      planToTelegramAcceptance: { eligibleCount: 7, observedCount: 7, averageSec: 20, maximumSec: 40, quality: "complete" },
      telegramAcceptanceBeforeTtl: { telegramAcceptedCount: 7, knownTtlCount: 7,
        acceptedBeforeTtlCount: 7, acceptedAfterTtlCount: 0, rate: 1, quality: "complete" },
      authoritativeTargetOutcomes: { total: 28, telegramAccepted: 7, failed: 5, cancelled: 4,
        expired: 3, executionUnknown: 2, unresolved: 7, telegramAcceptanceRate: 0.25 },
      familyAttribution: { dews: 6, depeg: 5, safety: 4, launch: 3, reserve: 2, freeze: 1, mixed: 5, unknown: 2 },
      preferenceChangeCancellations: { count: 4, reasons: [], reasonsTruncated: false },
      backlog: { windowStartsAt: STATUS_FIXTURE_NOW_SECONDS - 86_400, windowBounded: true,
        count: 7, oldestAgeSec: 300, buckets: [] },
      observedTargetErrorReasons: { reasons: [], truncated: false },
      executionUnknown: { count: 2, oldestAgeSec: 120, olderThan15mCount: 0 },
      deadLetters: { count: 0, totalAttempts: 0, reasons: [], reasonsTruncated: false,
        lastErrorReasons: [], lastErrorReasonsTruncated: false },
    },
  };
}

export function makeCompleteTelegramBotStatus(
  overrides: Partial<NonNullable<StatusResponse["telegramBot"]>> = {},
): NonNullable<StatusResponse["telegramBot"]> {
  return {
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
      sentCleanup: 0,
    },
    retryErrorClassCounts: {},
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
    ...overrides,
  };
}

/**
 * Healthy baseline `StatusResponse` fixture used by admin section tests.
 * Mutate via the {@link degraded} helper instead of editing inline so each
 * test describes its intent via a minimal patch.
 */
export function makeHealthyStatusResponse(): StatusResponse & { dataQuality: NonNullable<StatusResponse["dataQuality"]> } {
  return {
    timestamp: 1_700_000_000,
    dbHealthy: true,
    workerVersions: { public: null, heavy: null },
    schedulerLiveness: makeHealthyHealthResponse().schedulerLiveness,
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
        runs: [{ startedAt: 1_699_999_940, durationMs: 200, status: "ok" }],
        latestRunFacts: makeDispatchMetadata(),
        confirmedOutputAt: 1_699_999_940,
        expectedIntervalSec: 60,
        healthy: true,
      },
    },
    budgetOnlySurfaces: [],
    dataQuality: makeDataQuality({
      totalStablecoins: 190,
      onchainSupplyLatestAt: 1_699_999_000,
      onchainSupplyTrackedCoins: 50,
    }),
    telegramBot: makeCompleteTelegramBotStatus(),
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
    summary: makeStatusSummary({ worstCacheRatio: 0.5 }),
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
    reserveComposition: makeReserveComposition({
      configuredCoins: 100,
      freshCoins: 100,
      independentFreshEligible: 60,
      staticValidatedFresh: 30,
      weakProbeFresh: 10,
      lastSuccessAt: 1_699_999_000,
      oldestFreshAgeSec: 1_000,
      freshCoverageRatio: 1,
      authoritativeFreshCoverageRatio: 1,
    }),
    reserveDrift: [],
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

/** Healthy dependency, provider, and canary evidence for reliability workspace tests. */
export function makeHealthyReliabilityStatusResponse(base = makeHealthyStatusResponse()): StatusResponse {
  return degraded(base, {
    dependencyHealth: {
      checkedAt: base.timestamp,
      dependencies: {},
      rootCauseGroups: [],
      summary: { total: 0, healthy: 0, degraded: 0, stale: 0, unknown: 0, rootCauseGroupCount: 0 },
    },
    providerCircuitHealth: {
      checkedAt: base.timestamp,
      status: "healthy",
      totalTracked: 0,
      closedCount: 0,
      halfOpenCount: 0,
      openCount: 0,
      openProviders: [],
      byFamily: {},
    },
    canaries: {
      checkedAt: base.timestamp,
      status: "healthy",
      latestRunAt: base.timestamp,
      maxAgeSec: 900,
      totalChecks: 0,
      expectedCheckIds: [],
      presentCheckIds: [],
      missingCheckIds: [],
      okCount: 0,
      degradedCount: 0,
      errorCount: 0,
      skippedCount: 0,
      staleCount: 0,
      checks: {},
    },
  });
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

export { makeHealthyHealthResponse };

export function makeAttributionMeasurement(overrides: Partial<AttributionMeasurement> = {}): AttributionMeasurement {
  return {
    kind: "observed", observedSampleCount: 0, recordedCount: 0, probabilityStrata: [],
    coverage: "best-effort", reason: null, standardError: 0, ...overrides,
  };
}

type ApiRequestAttributionResponseOverrides = {
  generatedAt?: number;
  window?: Partial<ApiRequestAttributionResponse["window"]>;
  totals?: Partial<ApiRequestAttributionResponse["totals"]>;
  siteDelivery?: Partial<ApiRequestAttributionResponse["siteDelivery"]>;
  keyedPublicApi?: Partial<ApiRequestAttributionResponse["keyedPublicApi"]>;
};

export function makeApiRequestAttributionResponse(
  overrides: ApiRequestAttributionResponseOverrides = {},
): ApiRequestAttributionResponse {
  return {
    measurementVersion: 2,
    policyId: REQUEST_SOURCE_POLICY_ID,
    generatedAt: overrides.generatedAt ?? 1_700_000_000,
    window: {
      from: 1_699_913_600,
      to: 1_700_000_000,
      durationSec: 86_400,
      bucketSizeSec: 3_600,
      routeLimit: 5,
      apiKeyLimit: 25,
      retentionDays: 35,
      ...overrides.window,
    },
    totals: {
      siteRequests: 0,
      externalRequests: 0,
      totalRequests: 0,
      siteSharePct: 0,
      externalSharePct: 0,
      measurement: {
        siteRequests: makeAttributionMeasurement(), externalRequests: makeAttributionMeasurement(),
        totalRequests: makeAttributionMeasurement(), siteSharePct: makeAttributionMeasurement(),
        externalSharePct: makeAttributionMeasurement(),
      },
      ...overrides.totals,
    },
    siteDelivery: {
      totalSiteRequests: 0,
      pagesCacheHits: 0,
      pagesUpstreamFetches: 0,
      pagesUpstreamTimeouts: 0,
      pagesUpstreamErrors: 0,
      publicApiSiteRequests: 0,
      measurement: {
        totalSiteRequests: makeAttributionMeasurement(), pagesCacheHits: makeAttributionMeasurement(),
        pagesUpstreamFetches: makeAttributionMeasurement(), pagesUpstreamTimeouts: makeAttributionMeasurement(),
        pagesUpstreamErrors: makeAttributionMeasurement(), publicApiSiteRequests: makeAttributionMeasurement(),
      },
      ...overrides.siteDelivery,
    },
    lanes: [],
    routes: [],
    buckets: [],
    keyedPublicApi: {
      keyedRequests: 0,
      unkeyedRequests: 0,
      totalRequests: 0,
      keyedSharePct: 0,
      unkeyedSharePct: 0,
      totalKeys: 0,
      returnedKeys: 0,
      omittedKeys: 0,
      omittedRequests: 0,
      truncated: false,
      measurement: {
        keyedRequests: makeAttributionMeasurement(), unkeyedRequests: makeAttributionMeasurement(),
        totalRequests: makeAttributionMeasurement(), keyedSharePct: makeAttributionMeasurement(),
        unkeyedSharePct: makeAttributionMeasurement(),
      },
      ...overrides.keyedPublicApi,
    },
    apiKeys: [],
    scope: { countsTotalSiteDemand: true, countsWorkerLoad: true, includesPagesProxyCacheHits: true },
  };
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

export function makeOperationalDependencyFailureStatusResponse(base: StatusResponse = makeHealthyStatusResponse()): StatusResponse {
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
      expectedCheckIds: ["fixture-publication-check"],
      presentCheckIds: ["fixture-publication-check"],
      missingCheckIds: [],
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
      diagnosticIssueCount: base.summary.diagnosticIssueCount == null ? null : base.summary.diagnosticIssueCount + 3,
    },
  });
}

export function makeActionRecommendedStatusResponse(base = makeHealthyStatusResponse()): StatusResponse {
  const cause = {
    code: "blacklist_gaps_stale",
    layer: "data-quality" as const,
    severity: "critical" as const,
    message: "Fixture blacklist amount coverage requires guarded repair.",
    metric: "blacklistAmountGaps",
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
    data: makeHealthyStatusResponse(),
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
