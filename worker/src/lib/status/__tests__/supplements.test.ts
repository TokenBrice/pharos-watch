import { describe, expect, it, vi } from "vitest";
import { mockD1 } from "@shared/test-utils/mock-d1";
import type { CronStatusDetail } from "@shared/types/status";
import { loadStablecoinsCache, hasUsableStablecoinsPayload, type StablecoinsCacheLoadResult } from "../../stablecoins-cache";

vi.mock("../../stablecoins-cache", () => ({
  loadStablecoinsCache: vi.fn(async () => ({ kind: "error", reason: "missing", updatedAt: null })),
  hasUsableStablecoinsPayload: vi.fn(() => false),
}));
vi.mock("../yield-health", () => ({ loadYieldHealthSummary: vi.fn(async () => null) }));
vi.mock("../../publication-contract", () => ({
  loadPublicationHealth: vi.fn(async () => ({ surfaces: {}, failedSurfaces: [] })),
}));
vi.mock("../../provider-circuit-health", () => ({ loadProviderCircuitHealth: vi.fn(async () => null) }));
vi.mock("../../canary-checks", () => ({ loadCanaryStatus: vi.fn(async () => null) }));
vi.mock("../derived-data", () => ({ getMintBurnReconciliation: vi.fn(async (_db: D1Database, now: number) => ({
  conservationVersion: 1 as const,
  checkedAt: now,
  criticalCount: 0,
  rows: [],
})) }));
vi.mock("../../live-reserves/store", () => ({ loadFreshIndependentLiveReserveMap: vi.fn(async () => new Map()) }));
vi.mock("../../collateral-drift", () => ({
  summarizeCollateralDriftFromLiveReserveMap: vi.fn(() => ({ driftCoins: [] })),
}));
vi.mock("../../../telegram/outbox/pending-capacity", () => ({
  readTelegramPendingCapacity: vi.fn(async () => ({
    status: "available",
    value: {
      active: 0,
      due: 0,
      deferred: 0,
      expired: 0,
      nearTtl: 0,
      sending: 0,
      pendingSending: 0,
      freshSending: 0,
      executionUnknown: 0,
      pendingExecutionUnknown: 0,
      freshExecutionUnknown: 0,
      oldestExecutionUnknownAgeSec: null,
      executionUnknownSampleLimit: 5_001,
      executionUnknownLowerBound: false,
      sentCleanup: 0,
    },
  })),
  toPendingDeliveryBacklog: vi.fn(() => ({})),
}));
vi.mock("../price-source-depth", () => ({
  loadSourceDepthDistribution: vi.fn(async () => ({ "1": 1 })),
}));

import { loadStatusSupplements } from "../supplements";

const NOW = 1_779_000_000;

function statusDb(dispatchMetadata: Record<string, unknown> = {}) {
  return mockD1([
    { match: "FROM telegram_subscribers", rows: [], first: { n: 1 } },
    {
      match: "dispatch-telegram-alerts",
      rows: [],
      first: {
        started_at: NOW - 30,
        status: "ok",
        metadata: JSON.stringify(dispatchMetadata),
      },
    },
  ]);
}

function cronsWithPriceSourceHealth(priceSourceHealth: unknown): Record<string, CronStatusDetail> {
  return {
    "sync-stablecoins": {
      expectedIntervalSec: 900,
      healthy: true,
      confirmedOutputAt: null,
      runs: [{
        startedAt: NOW - 60,
        durationMs: 100,
        status: "ok",
        metadata: { priceSourceHealth },
      }],
    },
  };
}

function cronsWithDexLiquidityRuns(
  runs: CronStatusDetail["runs"],
  expectedIntervalSec = 1800,
): Record<string, CronStatusDetail> {
  return {
    "sync-dex-liquidity": {
      runs,
      healthy: true,
      confirmedOutputAt: null,
      expectedIntervalSec,
    },
  };
}

const ZERO_COVERAGE = {
  currentCoverage: 0, previousCoverage: 0,
  currentGlobalTvl: 0, previousGlobalTvl: 0,
  currentTop10CoveredTvl: 0, previousTop10CoveredTvl: 0,
  currentTop10GuardTvl: 0, previousTop10GuardTvl: 0,
  nearCoverageGuard: false, nearValueGuard: false, nearMajorCoverageGuard: false,
  currentCoverageClasses: { primary: 0, mixed: 0, fallback: 0, legacy: 0, unobserved: 0 },
  previousCoverageClasses: { primary: 0, mixed: 0, fallback: 0, legacy: 0, unobserved: 0 },
};


describe("loadStatusSupplements", () => {
  it("fails the CoinGecko supplement on overflow rather than accepting partial prices", async () => {
    vi.mocked(loadStablecoinsCache).mockResolvedValueOnce({
      kind: "ok", updatedAt: NOW, payload: { peggedAssets: [
        { id: "usdc-circle", geckoId: "usd-coin", price: 1 },
      ] },
    } as StablecoinsCacheLoadResult);
    vi.mocked(hasUsableStablecoinsPayload).mockReturnValue(true);
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response("{}", {
      headers: { "Content-Length": String(256 * 1024 + 1) },
    }));
    try {
      const supplements = await loadStatusSupplements(statusDb(), NOW, {}, "key");
      expect(supplements.coingeckoPriceDiff).toBeNull();
      expect(fetchMock).toHaveBeenCalledOnce();
    } finally {
      fetchMock.mockRestore();
      vi.mocked(hasUsableStablecoinsPayload).mockReturnValue(false);
    }
  });

  it("publishes null suppression flags when dispatch metadata omits them", async () => {
    const supplements = await loadStatusSupplements(statusDb(), NOW, {});

    expect(supplements.telegramSummary).toMatchObject({
      safetyAlertsSuppressed: null,
      reserveAlertsSuppressed: null,
    });
  });

  it("isolates malformed price-source health metadata", async () => {
    const supplements = await loadStatusSupplements(
      statusDb(),
      NOW,
      cronsWithPriceSourceHealth({ totalAssets: "invalid" }),
    );

    expect(supplements.priceSourceHealth).toBeNull();
    expect(supplements.sectionErrors.priceSourceHealth).toEqual({
      code: "price_source_health_extraction_failed",
      message: "Price source health data unavailable.",
    });
  });

  it("adds source-depth distribution to valid price-source health metadata", async () => {
    const priceSourceHealth = {
      sourceDistribution: { coingecko: 1 },
      confidenceDistribution: { high: 1, "single-source": 0, low: 0, fallback: 0 },
      totalAssets: 1,
      lastSync: NOW - 60,
    };

    const supplements = await loadStatusSupplements(
      statusDb(),
      NOW,
      cronsWithPriceSourceHealth(priceSourceHealth),
    );

    expect(supplements.priceSourceHealth).toEqual({
      ...priceSourceHealth,
      sourceDepthDistribution: { "1": 1 },
    });
    expect(supplements.sectionErrors.priceSourceHealth).toBeUndefined();
  });

  it("derives liquidity health from the newest run that carries sourceCoverage", async () => {
    // Production shape: the cadence-reuse `skipped_neutral` run persists
    // `sourceCoverage: null` while the previous `ok` run holds the freshest
    // completed measurement.
    const crons = cronsWithDexLiquidityRuns([
      { startedAt: NOW - 600, durationMs: 4, status: "skipped_neutral", metadata: { sourceCoverage: null } },
      {
        startedAt: NOW - 2100,
        durationMs: 5000,
        status: "ok",
        metadata: {
          failedSources: [],
          sourceCoverage: {
            ...ZERO_COVERAGE,
            currentCoverage: 274,
            previousCoverage: 273,
            nearCoverageGuard: false,
          },
        },
      },
    ]);

    const supplements = await loadStatusSupplements(statusDb(), NOW, crons);

    expect(supplements.liquidityHealth).toMatchObject({
      lastRunStatus: "ok",
      sourceRunStartedAt: NOW - 2100,
      currentCoverage: 274,
      previousCoverage: 273,
      nearCoverageGuard: false,
    });
    expect(supplements.sectionErrors.liquidityHealth).toBeUndefined();
  });

  it("publishes null liquidity health when no run inside the freshness budget carries sourceCoverage", async () => {
    const crons = cronsWithDexLiquidityRuns([
      { startedAt: NOW - 600, durationMs: 4, status: "skipped_neutral", metadata: { sourceCoverage: null } },
      {
        startedAt: NOW - 3700,
        durationMs: 5000,
        status: "ok",
        metadata: { sourceCoverage: { currentCoverage: 274 } },
      },
    ]);

    const supplements = await loadStatusSupplements(statusDb(), NOW, crons);

    expect(supplements.liquidityHealth).toBeNull();
    expect(supplements.sectionErrors.liquidityHealth?.code).toBe("liquidity_health_extraction_failed");
  });

  it.each([
    ["missing coverage", undefined, []],
    ["null coverage", null, []],
    ["empty coverage", {}, []],
    ["nonfinite coverage", { ...ZERO_COVERAGE, currentCoverage: Infinity }, []],
    ["numeric string", { ...ZERO_COVERAGE, currentCoverage: "0" }, []],
    ["boolean count", { ...ZERO_COVERAGE, currentCoverage: false }, []],
    ["object count", { ...ZERO_COVERAGE, currentCoverage: {} }, []],
    ["missing classes", { ...ZERO_COVERAGE, currentCoverageClasses: undefined }, []],
    ["null current classes", { ...ZERO_COVERAGE, currentCoverageClasses: null }, []],
    ["missing sources", ZERO_COVERAGE, undefined],
    ["malformed sources", ZERO_COVERAGE, ["source", false]],
    ["malformed guard", { ...ZERO_COVERAGE, nearCoverageGuard: "false" }, []],
  ])("isolates %s instead of inventing zero coverage", async (_label, sourceCoverage, failedSources) => {
    const supplements = await loadStatusSupplements(statusDb(), NOW, cronsWithDexLiquidityRuns([{
      startedAt: NOW - 60, durationMs: 1, status: "ok", metadata: { sourceCoverage, failedSources },
    }]));
    expect(supplements.liquidityHealth).toBeNull();
    expect(supplements.sectionErrors.liquidityHealth?.code).toBe("liquidity_health_extraction_failed");
    expect(supplements.publicationHealth).toMatchObject({ surfaces: {}, failedSurfaces: [] });
  });

  it("retains explicit zero and false in complete admitted coverage", async () => {
    const supplements = await loadStatusSupplements(statusDb(), NOW, cronsWithDexLiquidityRuns([{
      startedAt: NOW - 60, durationMs: 1, status: "ok",
      metadata: { sourceCoverage: ZERO_COVERAGE, failedSources: [] },
    }]));
    expect(supplements.liquidityHealth).toEqual({
      ...ZERO_COVERAGE, failedSources: [], lastRunStatus: "ok", sourceRunStartedAt: NOW - 60,
    });
    expect(supplements.sectionErrors.liquidityHealth).toBeUndefined();
  });
});
