import { describe, expect, it } from "vitest";
import { buildYieldSourceBoardModel } from "@/app/yield/source-board-model";
import type { AltYieldSource, YieldBenchmarkRegistry, YieldRanking, YieldRankingProvenance } from "@shared/types";

function makeProvenance(overrides: Partial<YieldRankingProvenance> = {}): YieldRankingProvenance {
  return {
    sourceKey: "selected-source",
    sourceObservedAt: 1_776_000_000,
    sourceAgeSeconds: 300,
    comparisonAnchorObservedAt: null,
    comparisonAnchorAgeSeconds: null,
    confidenceTier: "curated",
    selectionMethod: "confidence-weighted",
    selectionReason: "selected by confidence-weighted arbitration",
    sourceSwitch: false,
    previousBestSourceKey: null,
    usedLegacyHistory: false,
    usedDefaultSafety: false,
    benchmarkKey: "USD",
    benchmarkLabel: "USD 3M T-Bill",
    benchmarkCurrency: "USD",
    benchmarkRate: 4.25,
    benchmarkRecordDate: "2026-04-23",
    benchmarkIsFallback: false,
    benchmarkFallbackMode: null,
    benchmarkSelectionMode: "native",
    benchmarkIsProxy: false,
    anomalies: [],
    ...overrides,
  };
}

function makeAltSource(overrides: Partial<AltYieldSource> = {}): AltYieldSource {
  return {
    sourceKey: "alt-source",
    yieldSource: "Aave V3 USDC",
    yieldSourceUrl: "https://example.com/aave",
    yieldType: "lending-opportunity",
    currentApy: 4,
    apy30d: 4,
    sourceTvlUsd: 2_000_000,
    dataSource: "defillama-auto",
    ...overrides,
  };
}

function makeRanking(overrides: Partial<YieldRanking> = {}): YieldRanking {
  return {
    id: "usdc-circle",
    symbol: "USDC",
    name: "USD Coin",
    currentApy: 5,
    apy7d: 5,
    apy30d: 5,
    apyBase: null,
    apyReward: null,
    yieldSource: "Compound V3 USDC",
    yieldSourceUrl: "https://example.com/compound",
    yieldType: "lending-opportunity",
    dataSource: "protocol-api",
    sourceTvlUsd: 5_000_000,
    pharosYieldScore: 50,
    safetyScore: 80,
    safetyGrade: "A",
    yieldToRisk: 1.2,
    excessYield: 0.75,
    benchmarkKey: "USD",
    benchmarkLabel: "USD 3M T-Bill",
    benchmarkCurrency: "USD",
    benchmarkRate: 4.25,
    benchmarkRecordDate: "2026-04-23",
    benchmarkIsFallback: false,
    benchmarkFallbackMode: null,
    benchmarkSelectionMode: "native",
    benchmarkIsProxy: false,
    yieldStability: 0.9,
    apyVariance30d: 0.3,
    apyMin30d: 4.5,
    apyMax30d: 5.5,
    warningSignals: [],
    altSources: [],
    provenance: makeProvenance(),
    ...overrides,
  };
}

describe("buildYieldSourceBoardModel", () => {
  it("summarizes selected rows, alternate rows, confidence, switches, anomalies, and source-row APY", () => {
    const rankings = [
      makeRanking({
        id: "usdc-circle",
        apy30d: 5,
        provenance: makeProvenance({
          sourceKey: "compound-usdc",
          confidenceTier: "curated",
          sourceSwitch: true,
          anomalies: ["low-source-tvl"],
        }),
        altSources: [
          makeAltSource({
            sourceKey: "aave-usdc",
            yieldSource: "Aave V3 USDC",
            yieldType: "lending-opportunity",
            dataSource: "defillama-auto",
            apy30d: 4,
          }),
          makeAltSource({
            sourceKey: "sky-usdc",
            yieldSource: "Sky Savings",
            yieldType: "lending-vault",
            dataSource: "defillama",
            apy30d: 6,
          }),
        ],
      }),
      makeRanking({
        id: "eurc-circle",
        symbol: "EURC",
        name: "EURC",
        apy30d: 8,
        yieldSource: "Morpho EURC",
        dataSource: "protocol-api",
        benchmarkKey: "EUR",
        benchmarkLabel: "EUR 3M compounded ESTR",
        benchmarkCurrency: "EUR",
        provenance: makeProvenance({
          sourceKey: "morpho-eurc",
          confidenceTier: "deterministic",
          benchmarkKey: "EUR",
          benchmarkLabel: "EUR 3M compounded ESTR",
          benchmarkCurrency: "EUR",
        }),
      }),
    ];

    const model = buildYieldSourceBoardModel(rankings);

    expect(model.selectedCount).toBe(2);
    expect(model.alternateCount).toBe(2);
    expect(model.representedSourceCount).toBe(4);
    expect(model.representedDataSourceCount).toBe(3);
    expect(model.selectedConfidenceCounts).toEqual({
      deterministic: 1,
      curated: 1,
      discovered: 0,
      fallback: 0,
    });
    expect(model.selectedConfidenceUnknownCount).toBe(0);
    expect(model.sourceSwitchCount).toBe(1);
    expect(model.anomalyCount).toBe(1);
    expect(model.sourceRowApy).toEqual({ min: 4, median: 5.5, max: 8 });
    expect(model.benchmarkLabels).toEqual([
      { label: "EUR 3M compounded ESTR", count: 1 },
      { label: "USD 3M T-Bill", count: 1 },
    ]);

    expect(model.groups[0]).toEqual(expect.objectContaining({
      key: "lending-opportunity:protocol-api",
      dataSourceLabel: "Protocol API",
      yieldTypeLabel: "Lending Opp.",
      selectedCount: 2,
      alternateCount: 0,
      representedSourceCount: 2,
      apy: { min: 5, median: 6.5, max: 8 },
    }));
    expect(model.groups.find((group) => group.key === "lending-opportunity:defillama-auto")).toEqual(
      expect.objectContaining({
        selectedCount: 0,
        alternateCount: 1,
        representedSourceCount: 1,
        apy: { min: 4, median: 4, max: 4 },
      }),
    );
    expect(model.groups.find((group) => group.key === "lending-vault:defillama")).toEqual(
      expect.objectContaining({
        selectedCount: 0,
        alternateCount: 1,
        representedSourceCount: 1,
        apy: { min: 6, median: 6, max: 6 },
      }),
    );
  });

  it("does not assign confidence tiers to alternate source rows", () => {
    const model = buildYieldSourceBoardModel([
      makeRanking({
        provenance: null,
        altSources: [
          makeAltSource({
            dataSource: "defillama-auto",
            yieldType: "lending-opportunity",
            apy30d: 7,
          }),
        ],
      }),
    ]);

    expect(model.selectedCount).toBe(1);
    expect(model.alternateCount).toBe(1);
    expect(model.selectedConfidenceCounts).toEqual({
      deterministic: 0,
      curated: 0,
      discovered: 0,
      fallback: 0,
    });
    expect(model.selectedConfidenceUnknownCount).toBe(1);
  });

  it("uses benchmark options when row-level labels are absent", () => {
    const benchmarks: YieldBenchmarkRegistry = {
      USD: {
        key: "USD",
        label: "USD 3M T-Bill",
        currency: "USD",
        rate: 4.25,
        recordDate: "2026-04-23",
        fetchedAt: 1_776_000_000,
        ageSeconds: 60,
        source: "fred-dgs3mo",
        isFallback: false,
        fallbackMode: null,
      },
    };
    const model = buildYieldSourceBoardModel(
      [
        makeRanking({
          benchmarkKey: "USD",
          benchmarkLabel: undefined,
          benchmarkSelectionMode: undefined,
          benchmarkIsFallback: undefined,
        }),
      ],
      { benchmarks },
    );

    expect(model.benchmarkLabels).toEqual([{ label: "USD 3M T-Bill", count: 1 }]);
  });

  it("returns empty summaries for an empty ranking set", () => {
    const model = buildYieldSourceBoardModel([]);

    expect(model).toMatchObject({
      selectedCount: 0,
      alternateCount: 0,
      representedSourceCount: 0,
      representedDataSourceCount: 0,
      selectedConfidenceCounts: {
        deterministic: 0,
        curated: 0,
        discovered: 0,
        fallback: 0,
      },
      selectedConfidenceUnknownCount: 0,
      sourceSwitchCount: 0,
      anomalyCount: 0,
      sourceRowApy: null,
      benchmarkLabels: [],
      groups: [],
    });
  });
});
