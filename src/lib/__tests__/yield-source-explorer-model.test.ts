import { describe, expect, it } from "vitest";
import { buildYieldSourceExplorerModel } from "@/lib/yield-source-explorer-model";
import {
  SOURCE_RISK_GOLDEN_UI_DRIVER_LABELS,
  mergeSourceRiskGoldenFixtures,
} from "@shared/test-utils/yield-source-risk-golden-fixtures";
import type { AltYieldSource, YieldRanking, YieldSourceRisk } from "@shared/types";

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
      sourceRisk: mergeSourceRiskGoldenFixtures([
        "reward-heavy",
        "low-source-depth",
        "stale-source-age",
        "bootstrap-observation-count",
        "source-switch-churn",
      ]),
      provenance: {
        sourceKey: "aave-usdc",
        sourceObservedAt: 1_700_000_000,
        sourceAgeSeconds: 60,
        sourceFreshness: "stale",
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
    expect(model.sourceRiskDrivers.map((driver) => driver.label)).toEqual(SOURCE_RISK_GOLDEN_UI_DRIVER_LABELS);
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

function altSource(overrides: Partial<AltYieldSource> & Pick<AltYieldSource, "sourceKey">): AltYieldSource {
  return {
    sourceKey: overrides.sourceKey,
    yieldSource: overrides.yieldSource ?? "Alt",
    yieldSourceUrl: overrides.yieldSourceUrl ?? null,
    yieldType: overrides.yieldType ?? "lending-vault",
    currentApy: overrides.currentApy ?? 0.04,
    apy30d: overrides.apy30d ?? 0.039,
    sourceTvlUsd: overrides.sourceTvlUsd ?? 10_000_000,
    dataSource: overrides.dataSource ?? "defillama",
    sourceRisk: overrides.sourceRisk ?? null,
  };
}

function selectedRisk(overrides: Partial<YieldSourceRisk> = {}): YieldSourceRisk {
  return {
    sourceDepthRatio: 0.05,
    sourceAgeSeconds: 60,
    rewardShare: 0,
    ...overrides,
  };
}

describe("buildYieldSourceExplorerModel — rejection hints", () => {
  it("fires 'thinner' when alternate depth is at least 5x smaller than selected", () => {
    const model = buildYieldSourceExplorerModel(ranking({
      dataSource: "defillama",
      sourceTvlUsd: 10_000_000,
      sourceRisk: selectedRisk({ sourceDepthRatio: 0.05 }),
      altSources: [
        altSource({
          sourceKey: "thin-alt",
          dataSource: "defillama",
          sourceTvlUsd: 10_000_000,
          sourceRisk: { sourceDepthRatio: 0.01, sourceAgeSeconds: 60, rewardShare: 0 },
        }),
      ],
    }));

    expect(model.retainedAlternates[0]?.rejectionHint?.code).toBe("thinner");
    expect(model.retainedAlternates[0]?.rejectionHint?.description).toBe(
      "Lower venue depth than the chosen source.",
    );
  });

  it("fires 'stale' when alternate age is at least 2x older than selected", () => {
    const model = buildYieldSourceExplorerModel(ranking({
      dataSource: "defillama",
      sourceTvlUsd: 10_000_000,
      sourceRisk: selectedRisk({ sourceAgeSeconds: 60 }),
      altSources: [
        altSource({
          sourceKey: "stale-alt",
          dataSource: "defillama",
          sourceTvlUsd: 10_000_000,
          sourceRisk: { sourceDepthRatio: 0.05, sourceAgeSeconds: 200, rewardShare: 0 },
        }),
      ],
    }));

    expect(model.retainedAlternates[0]?.rejectionHint?.code).toBe("stale");
  });

  it("fires 'rewards-only' when alternate rewardShare exceeds 0.5", () => {
    const model = buildYieldSourceExplorerModel(ranking({
      dataSource: "defillama",
      sourceTvlUsd: 10_000_000,
      sourceRisk: selectedRisk(),
      altSources: [
        altSource({
          sourceKey: "reward-alt",
          dataSource: "defillama",
          sourceTvlUsd: 10_000_000,
          sourceRisk: { sourceDepthRatio: 0.05, sourceAgeSeconds: 60, rewardShare: 0.7 },
        }),
      ],
    }));

    expect(model.retainedAlternates[0]?.rejectionHint?.code).toBe("rewards-only");
  });

  it("fires 'lower-conf' when alternate confidence tier is weaker than selected", () => {
    const model = buildYieldSourceExplorerModel(ranking({
      dataSource: "onchain",
      sourceTvlUsd: 10_000_000,
      sourceRisk: selectedRisk(),
      altSources: [
        altSource({
          sourceKey: "discovered-alt",
          dataSource: "defillama-auto",
          sourceTvlUsd: 10_000_000,
          sourceRisk: { sourceDepthRatio: 0.05, sourceAgeSeconds: 60, rewardShare: 0 },
        }),
      ],
    }));

    expect(model.retainedAlternates[0]?.rejectionHint?.code).toBe("lower-conf");
  });

  it("fires 'smaller' when alternate TVL is at least 5x smaller than selected", () => {
    const model = buildYieldSourceExplorerModel(ranking({
      dataSource: "defillama",
      sourceTvlUsd: 10_000_000,
      sourceRisk: selectedRisk(),
      altSources: [
        altSource({
          sourceKey: "small-alt",
          dataSource: "defillama",
          sourceTvlUsd: 1_000_000,
          sourceRisk: { sourceDepthRatio: 0.05, sourceAgeSeconds: 60, rewardShare: 0 },
        }),
      ],
    }));

    expect(model.retainedAlternates[0]?.rejectionHint?.code).toBe("smaller");
  });

  it("returns null when no hint condition fires", () => {
    const model = buildYieldSourceExplorerModel(ranking({
      dataSource: "defillama",
      sourceTvlUsd: 10_000_000,
      sourceRisk: selectedRisk(),
      altSources: [
        altSource({
          sourceKey: "neutral-alt",
          dataSource: "defillama",
          sourceTvlUsd: 10_000_000,
          sourceRisk: { sourceDepthRatio: 0.05, sourceAgeSeconds: 60, rewardShare: 0 },
        }),
      ],
    }));

    expect(model.retainedAlternates[0]?.rejectionHint).toBeNull();
  });

  it("respects priority order: 'thinner' beats 'rewards-only' when both fire", () => {
    const model = buildYieldSourceExplorerModel(ranking({
      dataSource: "defillama",
      sourceTvlUsd: 10_000_000,
      sourceRisk: selectedRisk({ sourceDepthRatio: 0.05 }),
      altSources: [
        altSource({
          sourceKey: "double-alt",
          dataSource: "defillama",
          sourceTvlUsd: 10_000_000,
          sourceRisk: { sourceDepthRatio: 0.005, sourceAgeSeconds: 60, rewardShare: 0.8 },
        }),
      ],
    }));

    expect(model.retainedAlternates[0]?.rejectionHint?.code).toBe("thinner");
  });
});
