import { describe, expect, it } from "vitest";
import { buildYieldSourceExplorerModel } from "@/lib/yield-source-explorer-model";
import type { YieldRanking } from "@shared/types";

function ranking(overrides: Partial<YieldRanking> = {}): YieldRanking {
  return {
    id: "usdc-circle",
    symbol: "USDC",
    name: "USD Coin",
    currentApy: 0.052,
    apy7d: 0.051,
    apy30d: 0.05,
    apyBase: null,
    apyReward: null,
    yieldSource: "Aave",
    yieldSourceUrl: null,
    yieldType: "lending-vault",
    dataSource: "defillama",
    sourceTvlUsd: 10_000_000,
    pharosYieldScore: 42,
    safetyScore: 90,
    safetyGrade: "A",
    yieldToRisk: 1,
    excessYield: 0.01,
    benchmarkRate: 0.04,
    benchmarkLabel: "T-bill",
    benchmarkSelectionMode: "native",
    benchmarkIsFallback: false,
    yieldStability: 0.9,
    apyVariance30d: 0.001,
    apyMin30d: 0.04,
    apyMax30d: 0.06,
    warningSignals: [],
    altSources: [],
    provenance: {
      sourceKey: "aave-usdc",
      sourceObservedAt: 1_700_000_000,
      sourceAgeSeconds: 60,
      confidenceTier: "curated",
      selectionMethod: "confidence-weighted",
      selectionReason: "Higher confidence than retained alternates.",
      sourceSwitch: false,
      previousBestSourceKey: null,
      usedLegacyHistory: false,
      usedDefaultSafety: false,
      benchmarkRecordDate: null,
      benchmarkIsFallback: false,
      benchmarkFallbackMode: null,
      anomalies: [],
    },
    ...overrides,
  };
}

describe("buildYieldSourceExplorerModel", () => {
  it("returns selected source, retained alternates, risk labels, switch metadata, and benchmark context", () => {
    const model = buildYieldSourceExplorerModel(ranking({
      sourceRisk: {
        sourceRiskPenalty: 1.4,
        rewardShare: 0.8,
        sourceDepthRatio: 0.0005,
        sourceAgeSeconds: 8 * 60 * 60,
        observationCount30d: 3,
        sourceSwitchCount30d: 1,
      },
      provenance: {
        sourceKey: "aave-usdc",
        sourceObservedAt: 1_700_000_000,
        sourceAgeSeconds: 60,
        confidenceTier: "curated",
        selectionMethod: "confidence-weighted",
        selectionReason: "Higher confidence than retained alternates.",
        sourceSwitch: true,
        previousBestSourceKey: "compound-usdc",
        usedLegacyHistory: false,
        usedDefaultSafety: false,
        benchmarkRecordDate: null,
        benchmarkIsFallback: false,
        benchmarkFallbackMode: null,
        anomalies: [],
      },
      altSources: [
        {
          sourceKey: "compound-usdc",
          yieldSource: "Compound",
          yieldSourceUrl: "https://example.com/compound",
          yieldType: "lending-vault",
          currentApy: 0.04,
          apy30d: 0.039,
          sourceTvlUsd: 20_000_000,
          dataSource: "defillama",
        },
      ],
    }));

    expect(model.selectedSource.sourceKey).toBe("aave-usdc");
    expect(model.retainedAlternates.map((source) => source.sourceKey)).toEqual(["compound-usdc"]);
    expect(model.sourceRiskDrivers.map((driver) => driver.label)).toEqual([
      "reward-heavy",
      "thin source depth",
      "stale source",
      "limited history",
      "source changed",
    ]);
    expect(model.sourceSwitch).toMatchObject({
      changed: true,
      previousSourceKey: "compound-usdc",
      previousSourceDisplayLabel: "Compound",
    });
    expect(model.benchmarkContext).toMatchObject({
      label: "T-bill",
      rate: 0.04,
      isFallback: false,
      selectionMode: "native",
    });
  });

  it("keeps duplicate labels identifiable and missing URLs safe", () => {
    const model = buildYieldSourceExplorerModel(ranking({
      yieldSourceUrl: undefined,
      altSources: [
        {
          sourceKey: "aave-usdt",
          yieldSource: "Aave",
          yieldSourceUrl: null,
          yieldType: "lending-vault",
          currentApy: 0.041,
          apy30d: 0.04,
          sourceTvlUsd: 5_000_000,
          dataSource: "defillama",
        },
      ],
    }));

    expect(model.selectedSource.displayLabel).toBe("Aave (aave-usdc)");
    expect(model.retainedAlternates[0]?.displayLabel).toBe("Aave (aave-usdt)");
    expect(model.sourceIdentity.url).toBeNull();
    expect(model.historySources.map((source) => source.yieldSource)).toEqual([
      "Aave (aave-usdc)",
      "Aave (aave-usdt)",
    ]);
  });
});
