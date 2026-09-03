import { describe, expect, it, vi } from "vitest";
import { assessPublicHealth } from "../public-health-assessment";
import { mockD1, type MockTableConfig } from "@shared/test-utils/mock-d1";
import { ACTIVE_IDS } from "@shared/lib/stablecoins/registry";
import { makeNoopD1 } from "../../test-helpers/noop-d1";

/**
 * Minimal D1 mock that returns a stablecoins cache row and empty results for
 * every other query. Enough to drive `assessPublicHealth` through its cache
 * enrichment path without having to mock every downstream sub-query.
 */
function makeMinimalDb(
  nowSec: number,
  d1Capacity?: Record<string, unknown>,
  stablecoinPublicationMetadata?: Record<string, unknown>,
): D1Database {
  const emptyFirst = async <T>() => null as T | null;
  return makeNoopD1({
    prepare: (sql: string) => ({
      bind: (..._args: unknown[]) => ({
        all: async <T>() => {
          if (sql.includes("cache WHERE key IN")) {
            return {
              results: [{ key: "stablecoins", updated_at: nowSec - 60 }] as T[],
              success: true,
              meta: {},
            };
          }
          return { results: [] as T[], success: true, meta: {} };
        },
        first: async <T>() => {
          if (d1Capacity && sql.includes("SELECT value, updated_at FROM cache WHERE key = ?")) {
            return {
              value: JSON.stringify({ version: 1, assessment: d1Capacity }),
              updated_at: nowSec,
            } as T;
          }
          return emptyFirst<T>();
        },
        run: async () => ({ success: true, meta: {} }),
      }),
      all: async <T>() => ({ results: [] as T[], success: true, meta: {} }),
      first: async <T>() => {
        if (stablecoinPublicationMetadata && sql.includes("job = 'sync-stablecoins'")) {
          return {
            started_at: nowSec - 30,
            metadata: JSON.stringify(stablecoinPublicationMetadata),
          } as T;
        }
        return emptyFirst<T>();
      },
      run: async () => ({ success: true, meta: {} }),
    }),
    batch: async () => [],
    exec: async () => ({ count: 0, duration: 0 }),
    dump: async () => new ArrayBuffer(0),
  });
}

function makeMintBurnAssessmentDb(
  nowSec: number,
  options: {
    latestRunStatus?: string | null;
    latestSuccessfulSyncAt?: number | null;
    latestSuccessfulSyncError?: unknown;
    rowCount?: number | null;
    rowCountError?: unknown;
    sentinelAutoRepairCount?: number;
  } = {},
): D1Database {
  const latestRunStatus = options.latestRunStatus !== undefined ? options.latestRunStatus : "ok";
  const latestSuccessfulSyncAt =
    options.latestSuccessfulSyncAt !== undefined ? options.latestSuccessfulSyncAt : nowSec - 300;
  const rowCount = options.rowCount !== undefined ? options.rowCount : 4321;
  const cacheRows = [
    { key: "stablecoins", updated_at: nowSec - 60, value: "{}" },
    { key: "stablecoin-charts", updated_at: nowSec - 60, value: "{}" },
    { key: "usds-status", updated_at: nowSec - 60, value: "{}" },
    { key: "fx-rates", updated_at: nowSec - 60, value: JSON.stringify({ peggedEUR: 1.08 }) },
    { key: "bluechip-ratings", updated_at: nowSec - 60, value: "{}" },
    {
      key: "freshness:dex-liquidity",
      updated_at: nowSec - 60,
      value: JSON.stringify({
        updatedAt: nowSec - 60,
        source: "sync-dex-liquidity",
        publishStatus: "ok",
      }),
    },
    {
      key: "freshness:yield-data",
      updated_at: nowSec - 60,
      value: JSON.stringify({
        updatedAt: nowSec - 60,
        source: "sync-yield-data",
        publishStatus: "ok",
      }),
    },
    {
      key: "freshness:dews",
      updated_at: nowSec - 60,
      value: JSON.stringify({
        updatedAt: nowSec - 60,
        source: "compute-dews",
        publishStatus: "ok",
      }),
    },
  ];
  const timestampLookup: MockTableConfig = {
    match: "MAX(started_at)",
    matchBinds: ["sync-mint-burn"],
    rows: [],
    ...(options.latestSuccessfulSyncError
      ? { throwError: options.latestSuccessfulSyncError }
      : { first: { started_at: latestSuccessfulSyncAt } }),
  };
  const rowCountLookup: MockTableConfig = {
    match: "item_count",
    matchBinds: ["cron-sentinel", "mint-burn-growth-watchdog"],
    rows: [],
    ...(options.rowCountError
      ? { throwError: options.rowCountError }
      : {
          first: rowCount == null
            ? null
            : options.sentinelAutoRepairCount == null
              ? {
                  job: "mint-burn-growth-watchdog",
                  item_count: rowCount,
                  metadata: JSON.stringify({ rowCount }),
                }
              : {
                  job: "cron-sentinel",
                  item_count: rowCount,
                  metadata: JSON.stringify({
                    mode: "daily",
                    sources: {
                      growth: { status: "ok", itemCount: rowCount },
                      "repair-debt": {
                        status: "ok",
                        metadata: { autoRepairCount: options.sentinelAutoRepairCount },
                      },
                    },
                  }),
                },
        }),
  };

  return mockD1([
    { match: "SELECT 1", rows: [], first: { value: 1 } },
    { match: "cache WHERE key IN", rows: cacheRows },
    { match: "SELECT value, updated_at FROM cache WHERE key = ?", rows: [], first: null },
    { match: "SELECT key, value FROM cache WHERE key LIKE 'circuit:%'", rows: [] },
    { match: "blacklist-gap-metrics-cache-read", rows: [], first: null },
    { match: "GROUP BY job", rows: [] },
    { match: "blacklist-gap-aggregate", rows: [], first: { total: 0, missing: 0, missing_recent: 0 } },
    {
      match: "SELECT status",
      matchBinds: ["sync-mint-burn"],
      rows: [],
      first: latestRunStatus == null ? null : { status: latestRunStatus },
    },
    timestampLookup,
    rowCountLookup,
    { match: "FROM cron_runs", rows: [], first: null },
  ]);
}

describe("assessPublicHealth upstream provider enrichment", () => {
  it("keeps the alert-broker status surface inert without querying broker tables", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const db = mockD1([
      { match: "SELECT 1", rows: [], first: { value: 1 } },
      { match: "cache WHERE key IN", rows: [{ key: "stablecoins", updated_at: nowSec - 60 }] },
      { match: "FROM cron_runs", rows: [], first: null },
      { match: "blacklist-gap-aggregate", rows: [], first: { total: 0, missing: 0, missing_recent: 0 } },
      { match: "SELECT status", matchBinds: ["sync-mint-burn"], rows: [], first: null },
      { match: "MAX(started_at)", rows: [], first: null },
      { match: "item_count", rows: [], first: null },
      { match: "SELECT key, value FROM cache WHERE key LIKE 'circuit:%'", rows: [] },
      { match: "blacklist-gap-metrics-cache-read", rows: [], first: null },
      { match: "SELECT value, updated_at FROM cache WHERE key = ?", rows: [], first: null },
    ]);

    const result = await assessPublicHealth(db, nowSec, { logPrefix: "test" });

    expect(result.alertBroker).toEqual({
      activeCount: 0,
      pendingCount: 0,
      criticalActiveCount: 0,
      failedDeliveryCount: 0,
      missingTargetCount: 0,
      oldestActiveAt: null,
      activeConditionKeys: [],
      queryFailed: false,
    });
    expect(result.alertBrokerImpactStatus).toBe("healthy");
    expect(db.getHistory().some((entry) => /alert_broker_/i.test(entry.sql))).toBe(false);
  });

  it("tags the stablecoins cache with upstreamProvider = 'DefiLlama'", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const db = makeMinimalDb(nowSec);

    const result = await assessPublicHealth(db, nowSec, { logPrefix: "test" });

    expect(result.caches.stablecoins?.upstreamProvider).toBe("DefiLlama");
  });

  it("tags unknown cache keys with upstreamProvider = null", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const db = makeMinimalDb(nowSec);

    const result = await assessPublicHealth(db, nowSec, { logPrefix: "test" });

    // `fx-rates` and `bluechip-ratings` exist in CACHE_FRESHNESS_THRESHOLDS;
    // pick one that also has a mapping to verify attribution works for more
    // than just the stablecoins lane.
    expect(result.caches["fx-rates"]?.upstreamProvider).toBe("Frankfurter");
    expect(result.caches["bluechip-ratings"]?.upstreamProvider).toBe("Bluechip");
  });

  it("surfaces cached D1 warning capacity as degraded health", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const db = makeMinimalDb(nowSec, {
      observedAt: nowSec,
      databaseSizeBytes: 7_500_000_000,
      maximumSizeBytes: 10_000_000_000,
      utilizationRatio: 0.75,
      utilizationPercent: 75,
      thresholdState: "warning",
      crossedThresholdPercent: 75,
      nextThresholdPercent: 90,
      sampleCount: 72,
      forecastBasis: "linear-30d",
      forecastSpanHours: 71,
      growthBytesPerDay: 100_000_000,
      nextThresholdAt: nowSec + 15 * 86_400,
      exhaustionAt: nowSec + 25 * 86_400,
      daysUntilExhaustion: 25,
    });

    const result = await assessPublicHealth(db, nowSec, { logPrefix: "test" });

    expect(result.d1Capacity?.thresholdState).toBe("warning");
    expect(result.d1CapacityImpactStatus).toBe("degraded");
    expect(result.overallStatus).not.toBe("healthy");
    expect(result.warnings).toContain("d1-capacity-warning");
    expect(result.warnings.join(" ")).not.toContain("75");
  });

  it("names unwaived active-universe omissions and degrades public health", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const missingId = [...ACTIVE_IDS][0]!;
    const db = makeMinimalDb(nowSec, undefined, {
      activePublicationCoverage: {
        complete: false,
        expectedActiveCount: ACTIVE_IDS.size,
        presentActiveCount: ACTIVE_IDS.size - 1,
        waivedActiveCount: 0,
        missingActiveIds: [missingId],
        waivedActiveIds: [],
        expiredWaiverIds: [],
      },
    });

    const result = await assessPublicHealth(db, nowSec, { logPrefix: "test" });

    expect(result.stablecoinPublication).toMatchObject({
      status: "incomplete",
      missingActiveIds: [missingId],
    });
    expect(result.stablecoinPublicationImpactStatus).toBe("degraded");
    expect(result.overallStatus).not.toBe("healthy");
    expect(result.warnings).toContain(`stablecoin-publication-incomplete:${missingId}`);
  });

  it("fails closed when exact active-universe coverage evidence is unavailable", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const result = await assessPublicHealth(makeMinimalDb(nowSec), nowSec, { logPrefix: "test" });

    expect(result.stablecoinPublication.status).toBe("unknown");
    expect(result.stablecoinPublicationImpactStatus).toBe("degraded");
    expect(result.overallStatus).not.toBe("healthy");
    expect(result.warnings).toContain("stablecoin-publication-unknown");
  });

  it("warns without degrading health for missing active prices while row publication remains complete", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const activeIds = [...ACTIVE_IDS];
    const missingId = activeIds[0]!;
    const db = makeMinimalDb(nowSec, undefined, {
      activePublicationCoverage: {
        complete: true,
        expectedActiveCount: activeIds.length,
        presentActiveCount: activeIds.length,
        waivedActiveCount: 0,
        missingActiveIds: [],
        waivedActiveIds: [],
        expiredWaiverIds: [],
      },
      activePriceCoverage: {
        complete: false,
        expectedActiveCount: activeIds.length,
        presentActiveCount: activeIds.length,
        pricedActiveCount: activeIds.length - 1,
        missingPriceCount: 1,
        pricedActiveIds: activeIds.filter((stablecoinId) => stablecoinId !== missingId),
        missingActiveIds: [missingId],
        affectedMarketCapUsd: 88_000_000,
        missingActiveAssets: [{
          stablecoinId: missingId,
          symbol: "MISS",
          marketCapUsd: 88_000_000,
          currentPrice: null,
          currentSource: null,
          currentObservedAt: null,
          currentConfidence: null,
          consecutiveMissingGenerations: 2,
          lastAcceptedPrice: 1.001,
          lastAcceptedSource: "pyth",
          lastAcceptedObservedAt: nowSec - 1_800,
          rejectionReason: "no-accepted-price",
          alertEligible: true,
        }],
        alertEligibleCount: 1,
        alertEligibleIds: [missingId],
        maxConsecutiveMissingGenerations: 2,
      },
    });

    const result = await assessPublicHealth(db, nowSec, { logPrefix: "test" });

    expect(result.stablecoinPublication.status).toBe("complete");
    expect(result.activePriceCoverage).toMatchObject({
      status: "incomplete",
      missingActiveIds: [missingId],
      affectedMarketCapUsd: 88_000_000,
      alertEligibleCount: 1,
      alertEligibleIds: [missingId],
      maxConsecutiveMissingGenerations: 2,
    });
    expect(result.activePriceCoverage.missingActiveAssets[0]).toMatchObject({
      stablecoinId: missingId,
      symbol: "MISS",
      consecutiveMissingGenerations: 2,
      lastAcceptedPrice: 1.001,
      lastAcceptedSource: "pyth",
      rejectionReason: "no-accepted-price",
      alertEligible: true,
    });
    expect(result.activePriceCoverageImpactStatus).toBe("healthy");
    expect(result.warnings).toContain(`active-price-coverage-incomplete:${missingId}`);
  });

  it("keeps public health healthy for a transient (non-alert-eligible) price miss while preserving the coverage payload", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const activeIds = [...ACTIVE_IDS];
    const missingId = activeIds[0]!;
    const db = makeMinimalDb(nowSec, undefined, {
      activePublicationCoverage: {
        complete: true,
        expectedActiveCount: activeIds.length,
        presentActiveCount: activeIds.length,
        waivedActiveCount: 0,
        missingActiveIds: [],
        waivedActiveIds: [],
        expiredWaiverIds: [],
      },
      activePriceCoverage: {
        complete: false,
        expectedActiveCount: activeIds.length,
        presentActiveCount: activeIds.length,
        pricedActiveCount: activeIds.length - 1,
        missingPriceCount: 1,
        pricedActiveIds: activeIds.filter((stablecoinId) => stablecoinId !== missingId),
        missingActiveIds: [missingId],
        affectedMarketCapUsd: 88_000_000,
        missingActiveAssets: [{
          stablecoinId: missingId,
          symbol: "MISS",
          marketCapUsd: 88_000_000,
          currentPrice: null,
          currentSource: null,
          currentObservedAt: null,
          currentConfidence: null,
          consecutiveMissingGenerations: 1,
          lastAcceptedPrice: 1.001,
          lastAcceptedSource: "pyth",
          lastAcceptedObservedAt: nowSec - 900,
          rejectionReason: "no-accepted-price",
          alertEligible: false,
        }],
        alertEligibleCount: 0,
        alertEligibleIds: [],
        maxConsecutiveMissingGenerations: 1,
      },
    });

    const result = await assessPublicHealth(db, nowSec, { logPrefix: "test" });

    // Impact is gated on alert-eligibility: a single-cycle rotation miss does
    // not degrade the public banner.
    expect(result.activePriceCoverageImpactStatus).toBe("healthy");
    expect(result.warnings.some((warning) => warning.startsWith("active-price-coverage-incomplete"))).toBe(false);
    // Observability preserved: the JSON payload still reports the exact miss.
    expect(result.activePriceCoverage).toMatchObject({
      status: "incomplete",
      missingActiveIds: [missingId],
      missingPriceCount: 1,
      alertEligibleCount: 0,
      alertEligibleIds: [],
    });
  });

  it("reconstructs alertable gaps from compacted cron state", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const activeIds = [...ACTIVE_IDS];
    const missingId = activeIds[0]!;
    const db = makeMinimalDb(nowSec, undefined, {
      activePriceCoverage: {
        complete: false,
        expectedActiveCount: activeIds.length,
        presentActiveCount: activeIds.length,
        pricedActiveCount: activeIds.length - 1,
        missingPriceCount: 1,
        pricedActiveIds: activeIds.filter((stablecoinId) => stablecoinId !== missingId),
        missingActiveIds: [missingId],
        affectedMarketCapUsd: 88_000_000,
        missingActiveAssets: [],
        missingActiveState: [[
          missingId,
          4,
          0.999,
          "redstone",
          nowSec - 3_600,
          "no-accepted-price",
        ]],
        alertEligibleCount: 1,
        alertEligibleIds: [missingId],
        maxConsecutiveMissingGenerations: 4,
      },
    });

    const result = await assessPublicHealth(db, nowSec, { logPrefix: "test" });

    expect(result.activePriceCoverage.missingActiveAssets).toEqual([
      expect.objectContaining({
        stablecoinId: missingId,
        consecutiveMissingGenerations: 4,
        lastAcceptedPrice: 0.999,
        lastAcceptedSource: "redstone",
        rejectionReason: "no-accepted-price",
        alertEligible: true,
      }),
    ]);
  });
});

describe("assessPublicHealth mint/burn subquery failures", () => {
  it("reads growth and repair diagnostics from the daily sentinel row", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const result = await assessPublicHealth(makeMintBurnAssessmentDb(nowSec, {
      rowCount: 7654,
      sentinelAutoRepairCount: 3,
    }), nowSec, { logPrefix: "test" });

    expect(result.mintBurn.totalEvents).toBe(7654);
    expect(result.repairRunnerAutoRepairCount).toBe(3);
  });

  it("preserves timestamp lookup failures as mint/burn query errors", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const db = makeMintBurnAssessmentDb(nowSec, {
      latestSuccessfulSyncError: new Error("timestamp lookup failed"),
    });

    try {
      const result = await assessPublicHealth(db, nowSec, { logPrefix: "test" });

      expect(result.mintBurnQueryError).toBe("Mint/burn health data unavailable.");
      expect(result.mintBurn.queryErrors).toEqual({
        latestSuccessfulSyncAt: "Latest successful mint/burn sync timestamp unavailable.",
        rowCount: null,
      });
      expect(result.mintBurn.totalEvents).toBe(4321);
      expect(result.mintBurnImpactStatus).toBe("degraded");
      expect(result.overallStatus).not.toBe("stale");
      expect(result.mintBurnBootstrap).toBe(false);
      expect(result.warnings).toContain("mint-burn-query-failed");
    } finally {
      consoleError.mockRestore();
    }
  });

  it("keeps row-count lookup failures distinct from timestamp query errors", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const db = makeMintBurnAssessmentDb(nowSec, {
      rowCountError: new Error("row-count lookup failed"),
    });

    try {
      const result = await assessPublicHealth(db, nowSec, { logPrefix: "test" });

      expect(result.mintBurnQueryError).toBeNull();
      expect(result.mintBurn.queryErrors).toEqual({
        latestSuccessfulSyncAt: null,
        rowCount: "Mint/burn row-count diagnostics unavailable.",
      });
      expect(result.mintBurn.totalEvents).toBeNull();
      expect(result.mintBurn.sync.lastSuccessfulSyncAt).toBe(nowSec - 300);
      expect(result.mintBurnImpactStatus).toBe("healthy");
      expect(result.warnings).not.toContain("mint-burn-query-failed");
    } finally {
      consoleError.mockRestore();
    }
  });

  it("keeps successful missing-sync results classified as stale instead of query errors", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const db = makeMintBurnAssessmentDb(nowSec, {
      latestRunStatus: "error",
      latestSuccessfulSyncAt: null,
      rowCount: null,
    });

    const result = await assessPublicHealth(db, nowSec, { logPrefix: "test" });

    expect(result.mintBurnQueryError).toBeNull();
    expect(result.mintBurn.queryErrors).toEqual({
      latestSuccessfulSyncAt: null,
      rowCount: null,
    });
    expect(result.mintBurn.sync.lastSuccessfulSyncAt).toBeNull();
    expect(result.mintBurnImpactStatus).toBe("stale");
    expect(result.mintBurnBootstrap).toBe(false);
    expect(result.warnings).not.toContain("mint-burn-query-failed");
  });
});
