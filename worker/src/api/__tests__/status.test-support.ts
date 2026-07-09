import { vi } from "vitest";
import { mockD1 } from "../../test-helpers/__shared/mock-d1";
import { makeApiRequest, stubCryptoForAuth } from "../../test-helpers/__shared/auth";
import { mockFetch } from "../../test-helpers/__shared/mock-fetch";
import { CRON_INTERVALS } from "@shared/lib/cron-jobs";
import { ACTIVE_STABLECOINS } from "@shared/lib/stablecoins/registry";
import * as dependencyHealthModule from "../../lib/dependency-health";

stubCryptoForAuth();

const { handleStatus } = await import("../status");
const { STATUS_RAW_SNAPSHOT_CACHE_KEY, STATUS_RAW_SNAPSHOT_MAX_AGE_SEC } =
  await import("../../lib/status/raw-snapshot");

/** Build a mock cache row with a recent updated_at */
function makeCacheRow(key: string, ageSec = 300) {
  return {
    key,
    updated_at: Math.floor(Date.now() / 1000) - ageSec,
    value: JSON.stringify(key === "fx-rates" ? { peggedEUR: 1.08 } : []),
  };
}

/** Build a mock cron_runs row */
function makeCronRow(job: string, status = "ok", ageSec = 300) {
  return {
    job,
    started_at: Math.floor(Date.now() / 1000) - ageSec,
    duration_ms: 1500,
    status,
    error: null,
    item_count: 100,
    metadata: null,
  };
}

function makeRawStatusForSnapshot(now: number, overrides: Record<string, unknown> = {}) {
  return {
    dbHealthy: true,
    availabilityStatus: "healthy",
    dataQualityStatus: "healthy",
    rawOverallStatus: "healthy",
    confidence: 0.95,
    causes: {
      availability: [],
      dataQuality: [],
      overall: [],
    },
    caches: {},
    crons: {
      "sync-stablecoins": {
        lastRun: makeCronRow("sync-stablecoins", "ok", 60),
        recentRuns: [makeCronRow("sync-stablecoins", "ok", 60)],
        expectedIntervalSec: 900,
        healthy: true,
      },
    },
    budgetOnlySurfaces: [],
    dataQuality: {
      stablecoinsCacheStatus: "ok",
      stablecoinsCacheReason: null,
      blacklistGapStatus: "ok",
      activeDepegStatus: "ok",
      onchainSupplyQueryStatus: "ok",
      sourceFailures: [],
      totalStablecoins: 1,
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
      onchainSupplyLatestAt: now - 60,
      onchainSupplyTrackedCoins: 1,
      activeDepegs: 0,
      staleOnchainSupply: 0,
      onchainStaleRatio: 0,
    },
    telegramBot: null,
    sectionErrors: {},
    datasetFreshness: {
      stablecoins: now - 60,
      blacklist: now - 60,
      mintBurn: now - 60,
      supply: now - 60,
      safetyGrades: now - 60,
      yield: now - 60,
      depegs: now - 60,
      dews: now - 60,
      digest: now - 60,
      discoveryCandidates: now - 60,
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
    reserveComposition: {
      configuredCoins: 0,
      freshCoins: 0,
      staleCoins: 0,
      missingCoins: 0,
      degradedCoins: 0,
      errorCoins: 0,
      corruptCoins: 0,
      independentFreshEligible: 0,
      independentFreshUnverified: 0,
      staticValidatedFresh: 0,
      weakProbeFresh: 0,
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
      lastSuccessAt: null,
      oldestFreshAgeSec: null,
      status: "healthy",
      freshCoverageRatio: 0,
      authoritativeFreshCoverageRatio: 0,
    },
    freshnessDiagnostics: [],
    ...overrides,
  };
}

function makeRawStatusSnapshotRow(now: number, ageSec: number, overrides: Record<string, unknown> = {}) {
  const updatedAt = now - ageSec;
  return {
    key: STATUS_RAW_SNAPSHOT_CACHE_KEY,
    updated_at: updatedAt,
    value: JSON.stringify({
      version: 1,
      producedAt: updatedAt,
      raw: makeRawStatusForSnapshot(updatedAt, overrides),
    }),
  };
}

function makeMinimalLiveStatusRows(now: number, stateRow: Record<string, unknown> | null = null) {
  const stablecoinsCache = JSON.stringify({
    peggedAssets: [{ id: "usdt-tether", symbol: "USDT", price: 1, circulating: { peggedUSD: 100_000_000 } }],
  });
  return [
    { match: "cache WHERE key IN", rows: [makeCacheRow("stablecoins"), makeCacheRow("stablecoin-charts")] },
    { match: "dex_liquidity", rows: [], first: { age: 300 } },
    { match: "yield_data", rows: [], first: { age: 300 } },
    { match: "stress_signals", rows: [], first: { age: 300 } },
    { match: "cron_runs", rows: [makeCronRow("sync-stablecoins", "ok", 30)] },
    { match: "cache", rows: [], first: { value: stablecoinsCache, updated_at: now - 60 } },
    { match: "blacklist_events", rows: [], first: { total: 0, missing: 0, missing_recent: 0 } },
    { match: "depeg_events", rows: [], first: { cnt: 0 } },
    { match: "onchain_supply WHERE updated_at", rows: [], first: { cnt: 0 } },
    { match: "onchain_supply WHERE updated_at >", rows: [] },
    { match: "FROM discovery_candidates WHERE dismissed = 0", rows: [] },
    { match: "FROM status_state", rows: [], first: stateRow },
  ];
}
function cleanupStatusTest() {
  vi.restoreAllMocks();
}

const fixtureMockD1 = mockD1;
const fixtureMakeApiRequest = makeApiRequest;
const fixtureMockFetch = mockFetch;
const fixtureCRON_INTERVALS = CRON_INTERVALS;
const fixtureACTIVE_STABLECOINS = ACTIVE_STABLECOINS;
const fixtureDependencyHealthModule = dependencyHealthModule;

export {
  handleStatus,
  STATUS_RAW_SNAPSHOT_CACHE_KEY,
  STATUS_RAW_SNAPSHOT_MAX_AGE_SEC,
  makeCacheRow,
  makeCronRow,
  makeRawStatusForSnapshot,
  makeRawStatusSnapshotRow,
  makeMinimalLiveStatusRows,
  cleanupStatusTest,
  fixtureMockD1,
  fixtureMakeApiRequest,
  fixtureMockFetch,
  fixtureCRON_INTERVALS,
  fixtureACTIVE_STABLECOINS,
  fixtureDependencyHealthModule,
};
