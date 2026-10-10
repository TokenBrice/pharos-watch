import { describe, expect, it } from "vitest";
import type { D1UsageSummary } from "@shared/types";
import {
  buildPipelineIntegrityModel,
  buildPipelineModeSummaries,
  buildPipelineQualityModel,
  collectPipelineLoaderErrors,
} from "@/lib/pipeline-workspace-model";
import {
  degraded,
  makeHealthyStatusResponse,
  makeOperationalDependencyFailureStatusResponse,
  makePublicationFailureStatusResponse,
} from "@/test-utils/status-fixtures";

function withReadyQuality() {
  const base = makeHealthyStatusResponse();
  return degraded(base, {
    dataQuality: {
      ...base.dataQuality,
      blacklistTotal: 100,
      blacklistMissingAmounts: 0,
      blacklistMissingRatio: 0,
      blacklistRecentMissingAmounts: 0,
    },
  });
}

describe("pipeline quality model", () => {
  it("distinguishes a real zero from an unknown denominator", () => {
    const unknown = buildPipelineQualityModel(makeHealthyStatusResponse());
    const knownZero = buildPipelineQualityModel(withReadyQuality());

    expect(unknown.rows.find((row) => row.id === "blacklist-gaps")).toMatchObject({
      currentValue: "Unknown",
      state: "unknown",
    });
    expect(knownZero.rows.find((row) => row.id === "blacklist-gaps")).toMatchObject({
      currentValue: "0 (0.00%); 0 recent",
      state: "healthy",
    });
  });

  it("keeps inactive on-chain ratio gates Unknown instead of reporting healthy zeroes", () => {
    const base = withReadyQuality();
    const data = degraded(base, {
      dataQuality: {
        ...base.dataQuality,
        onchainSupplyTrackedCoins: 5,
        onchainSupplyDivergences: 0,
        onchainDivergenceRatio: 0,
        staleOnchainSupply: 0,
        onchainStaleRatio: 0,
      },
    });
    const rows = buildPipelineQualityModel(data).rows;

    expect(rows.find((row) => row.id === "onchain-divergences")).toMatchObject({
      currentValue: "Unknown",
      state: "unknown",
    });
    expect(rows.find((row) => row.id === "stale-onchain")?.stateDetail).toContain("Confidence floor is inactive");
  });

  it("builds dense threshold rows with critical state and explicit population", () => {
    const base = withReadyQuality();
    const data = degraded(base, {
      dataQuality: {
        ...base.dataQuality,
        totalStablecoins: 100,
        missingPrices: 50,
      },
    });
    const model = buildPipelineQualityModel(data);
    const missing = model.rows.find((row) => row.id === "missing-prices");

    expect(model.rows).toHaveLength(4);
    expect(missing).toMatchObject({
      currentValue: "50 (50.0%)",
      eligiblePopulation: "100 active stablecoins returned by the cache",
      warningThreshold: ">18%",
      staleThreshold: ">45%",
      state: "critical",
    });
  });

  it("describes stale snapshots with the canonical eight-hour freshness window", () => {
    const base = withReadyQuality();
    const data = degraded(base, {
      dataQuality: {
        ...base.dataQuality,
        onchainSupplyQueryStatus: "ok",
        onchainSupplyMonitoring: "active",
        onchainSupplyTrackedCoins: 10,
        onchainSupplyDivergences: 0,
        onchainDivergenceRatio: 0,
        staleOnchainSupply: 1,
        onchainStaleRatio: 0.1,
      },
    });

    expect(buildPipelineQualityModel(data).rows.find((row) => row.id === "stale-onchain")?.stateDetail).toBe(
      "Snapshots older than 8h count as stale for this threshold.",
    );
  });

  it("does not let informational depegs or Integrity repair debt drive the Quality badge", () => {
    const base = withReadyQuality();
    const data = degraded(base, {
      dataQuality: {
        ...base.dataQuality,
        activeDepegStatus: "failed",
        repairDebt: {
          ...base.dataQuality.repairDebt,
          status: "present",
          openCount: 4,
        },
      },
    });
    const quality = buildPipelineModeSummaries(data).find((mode) => mode.id === "quality");

    expect(buildPipelineQualityModel(data).activeDepegs).toMatchObject({
      currentValue: "Unknown",
      unavailable: true,
    });
    expect(quality).toMatchObject({ severity: "healthy", issueCount: 0 });
  });

  it("counts only non-healthy threshold rows and reports their worst severity", () => {
    const base = withReadyQuality();
    const data = degraded(base, {
      dataQuality: { ...base.dataQuality, totalStablecoins: 100, missingPrices: 50 },
    });

    expect(buildPipelineModeSummaries(data).find((mode) => mode.id === "quality")).toMatchObject({
      issueCount: 1,
      severity: "critical",
    });
  });
});

describe("pipeline market price scope", () => {
  const legacy = {
    totalAssets: 567, lastSync: 100,
    confidenceDistribution: { high: 115, "single-source": 325, low: 20, fallback: 1 },
    sourceDistribution: { missing: 106 },
  };
  it.each([
    ["active", { ...legacy, active: { ...legacy, totalAssets: 334, sourceDistribution: { missing: 16 } } }, 16],
    ["legacy", legacy, 106],
    ["empty active population", { ...legacy, active: { ...legacy, totalAssets: 0, sourceDistribution: { missing: 0 } } }, 1],
  ])("uses the %s population for the Markets badge", (_label, priceSourceHealth, priceIssues) => {
    const base = makeHealthyStatusResponse();
    const control = degraded(base, { priceSourceHealth: { ...legacy, sourceDistribution: { missing: 0 } } });
    const otherIssues = buildPipelineModeSummaries(control).find((mode) => mode.id === "markets")!.issueCount;
    const data = degraded(base, { priceSourceHealth });
    expect(buildPipelineModeSummaries(data).find((mode) => mode.id === "markets")!.issueCount)
      .toBe(otherIssues + priceIssues);
  });
});

describe("pipeline storage capacity", () => {
  const telemetry: D1UsageSummary = {
    checkedAt: 100, windowStart: 0, windowEnd: 100, databaseId: "fixture",
    databaseName: null, databaseSizeBytes: 95, numTables: 10, region: null,
    readReplicationMode: null, readQueries24h: 1, writeQueries24h: 1,
    rowsRead24h: 1, rowsWritten24h: 1,
  };
  it.each([
    ["normal", "healthy", 0],
    ["watch", "watch", 1],
    ["warning", "watch", 1],
    ["critical", "critical", 1],
  ] as const)("uses published %s capacity rather than telemetry presence", (thresholdState, severity, issueCount) => {
    const data = degraded(makeHealthyStatusResponse(), { d1Usage: {
      ...telemetry,
      capacity: {
        observedAt: 100, databaseSizeBytes: 95, maximumSizeBytes: 100,
        utilizationRatio: 0.95, utilizationPercent: 95, thresholdState,
        crossedThresholdPercent: 90, nextThresholdPercent: 100, sampleCount: 1,
        forecastBasis: "insufficient-history", forecastSpanHours: 0,
        growthBytesPerDay: null, nextThresholdAt: null, exhaustionAt: null, daysUntilExhaustion: null,
      },
    } });
    expect(buildPipelineModeSummaries(data).find((mode) => mode.id === "storage"))
      .toMatchObject({ severity, issueCount });
  });

  it.each([
    ["absent capacity", telemetry, {}],
    ["null capacity", { ...telemetry, capacity: null }, {}],
    ["failed telemetry", null, { d1Usage: { code: "d1_usage_failed", message: "Telemetry failed" } }],
  ] as const)("keeps %s Unknown with an evidence issue", (_label, d1Usage, sectionErrors) => {
    const data = degraded(makeHealthyStatusResponse(), { d1Usage, sectionErrors });
    expect(buildPipelineModeSummaries(data).find((mode) => mode.id === "storage"))
      .toMatchObject({ severity: "unknown", issueCount: 1 });
  });
});

describe("pipeline coverage summaries", () => {
  it("maps inactive loader errors to human labels while retaining raw keys and codes", () => {
    const base = makeHealthyStatusResponse();
    const data = degraded(base, {
      sectionErrors: {
        coingeckoPriceDiff: { code: "cg_query_failed", message: "Comparison timed out" },
        reserveDrift: { code: "reserve_drift_computation_failed", message: "Reserve query timed out" },
        dependencyHealth: { code: "dependency_query_failed", message: "Dependency inventory timed out" },
      },
    });

    expect(collectPipelineLoaderErrors(data)).toEqual([
      expect.objectContaining({ label: "CoinGecko comparison", rawKey: "coingeckoPriceDiff", code: "cg_query_failed" }),
      expect.objectContaining({
        label: "Reserve drift",
        rawKey: "reserveDrift",
        code: "reserve_drift_computation_failed",
      }),
      expect.objectContaining({ label: "Dependency health", rawKey: "dependencyHealth" }),
    ]);
  });

  it("covers publication controls, publication failures, and dependency evidence in Integrity", () => {
    const dependencyData = makeOperationalDependencyFailureStatusResponse();
    const publicationData = makePublicationFailureStatusResponse();
    const data = degraded(dependencyData, {
      publicationHealth: publicationData.publicationHealth,
      dataQuality: {
        ...dependencyData.dataQuality,
        stablecoinPublication: {
          status: "incomplete",
          expectedActiveCount: 10,
          presentActiveCount: 8,
          waivedActiveCount: 1,
          missingActiveIds: ["missing-coin"],
          waivedActiveIds: ["waived-coin"],
          expiredWaiverIds: [],
          observedAt: dependencyData.timestamp,
        },
      },
    });
    const model = buildPipelineIntegrityModel(data);

    expect(model.controlRows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: "Stablecoin publication coverage", state: "critical" }),
      ]),
    );
    expect(model.publicationRows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          label: "DEX Liquidity", rawCode: "dex-liquidity", state: "unknown",
          currentValue: "Unavailable",
          detail: expect.stringContaining("publication_query_failed"),
        }),
      ]),
    );
    expect(model.dependencyRows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: "Fixture market cache", rawCode: "fixture-market-cache", state: "critical" }),
      ]),
    );
  });
});
