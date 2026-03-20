import { describe, expect, it } from "vitest";
import type { EndpointProbeResult, HealthResponse, StatusResponse } from "@shared/types";
import { buildBrowserProbeSummary, buildStatusDashboardData } from "../status-dashboard-model";

const BASE_STATUS: StatusResponse = {
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
    lastChangedAt: 1_700_000_000,
    minDwellSec: 120,
    staleMinDwellSec: 180,
    consecutiveRaw: {
      healthy: 3,
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
    ageSeconds: 0,
    maxAgeSec: 60,
    isStale: false,
  },
  probe: {
    timestamp: 1_700_000_000,
    status: "healthy",
    sampleCount: 1,
    passCount: 1,
    failCount: 0,
    p95LatencyMs: 50,
  },
  discrepancy: {
    hasDivergence: false,
    severityDelta: 0,
    statusSeverity: 0,
    probeSeverity: 0,
    details: null,
    probeAgeSeconds: 0,
    consecutiveDivergent: 0,
  },
  timeline: [],
  caches: {},
  crons: {},
  dataQuality: {
    stablecoinsCacheStatus: "ok",
    stablecoinsCacheReason: null,
    blacklistGapStatus: "ok",
    activeDepegStatus: "ok",
    onchainSupplyQueryStatus: "ok",
    sourceFailures: [],
    totalStablecoins: 0,
    missingPrices: 0,
    blacklistMissingAmounts: 0,
    blacklistRecentMissingAmounts: 0,
    blacklistRecentWindowSec: 86400,
    blacklistMissingRatio: 0,
    blacklistTotal: 0,
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
    discoveryCandidates: null,
  },
  summary: {
    unhealthyCrons: 0,
    degradedCrons: 0,
    cronErrors: 0,
    worstCacheRatio: 0,
  },
  liquidityHealth: null,
  priceSourceHealth: null,
  discoveryCandidates: null,
  mintBurnReconciliation: null,
  reserveComposition: {
    configuredCoins: 0,
    freshCoins: 0,
    staleCoins: 0,
    missingCoins: 0,
    degradedCoins: 0,
    errorCoins: 0,
    lastSuccessAt: null,
    oldestFreshAgeSec: null,
  },
  reserveDrift: [],
  classificationWarnings: [],
};

const BASE_HEALTH: HealthResponse = {
  status: "healthy",
  timestamp: 1_700_000_000,
  warnings: [],
  caches: {},
  blacklist: {
    totalEvents: 0,
    missingAmounts: 0,
    recentMissingAmounts: 0,
    recentWindowSec: 86400,
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

describe("status dashboard model", () => {
  it("treats semantic degradation as an unhealthy browser probe", () => {
    const probes: EndpointProbeResult[] = [
      {
        path: "/api/health",
        status: 200,
        latencyMs: 80,
        semanticStatus: "degraded",
        semanticDetail: "Mint/burn sync warning",
        semanticScope: "health",
      },
      {
        path: "/api/stablecoins",
        status: 200,
        latencyMs: 40,
      },
    ];

    expect(buildBrowserProbeSummary(probes, 10_000)).toEqual({
      sampleCount: 2,
      passCount: 1,
      failCount: 1,
      degradedCount: 1,
      staleCount: 0,
      p95LatencyMs: 80,
      status: "degraded",
      updatedAt: 10,
    });
  });

  it("uses the oldest critical query timestamp as the freshness floor", () => {
    const model = buildStatusDashboardData({
      data: BASE_STATUS,
      healthData: BASE_HEALTH,
      probes: [],
      querySyncs: {
        statusUpdatedAt: 900_000,
        healthUpdatedAt: 870_000,
        probesUpdatedAt: 900_000,
        historyUpdatedAt: 900_000,
      },
      nowMs: 1_000_000,
      healthError: null,
      probesError: null,
      historyError: null,
      historyTransitions: undefined,
    });

    expect(model.clientDataAgeSec).toBe(130);
    expect(model.clientDataStale).toBe(true);
    expect(model.querySyncs.find((sync) => sync.key === "health")?.stale).toBe(true);
    expect(model.notices.some((notice) => notice.id === "client-stale")).toBe(true);
  });
});
