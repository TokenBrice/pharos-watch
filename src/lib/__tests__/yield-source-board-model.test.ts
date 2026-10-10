import { describe, expect, it } from "vitest";
import { buildYieldSourceBoardModel, inferLaneConfidenceTier } from "@/lib/yield-source-board-model";
import { makeAltYieldSource, makeYieldProvenance, makeYieldRanking } from "@shared/test-utils/yield-ranking-fixtures";
import { projectYieldRankingsSummary } from "@shared/lib/yield-rankings-summary";
import type { YieldRanking } from "@shared/types";
import { YIELD_RANKING_SUMMARY_ALT_SOURCE_LIMIT } from "@shared/types/yield-summary";

function projectRows(rankings: YieldRanking[]) {
  return projectYieldRankingsSummary({ rankings, riskFreeRate: 4, scalingFactor: 8, medianApy: null, updatedAt: 1_800_000_000 });
}

describe("buildYieldSourceBoardModel", () => {
  it("preserves detailed source lanes and anomaly evidence through the summary projection", () => {
    const rankings = [makeYieldRanking({
      dataSource: "onchain",
      provenance: makeYieldProvenance({ anomalies: ["low-source-tvl"] }),
      altSources: [makeAltYieldSource({ dataSource: "defillama", apy30d: 7 })],
    })];
    const summary = projectRows(rankings);
    const detailModel = buildYieldSourceBoardModel(rankings);
    const summaryModel = buildYieldSourceBoardModel(summary.rankings);
    expect(summaryModel.groups).toEqual(detailModel.groups);
    expect(summaryModel.anomalyDetails).toEqual(detailModel.anomalyDetails);
    expect(summaryModel.anomalyCount).toBe(1);
    expect(summaryModel.anomalyUnavailableCount).toBe(0);
    expect(summaryModel.compositionMissingSourceCount).toBe(0);
  });

  it("keeps complete totals independent of bounded alternate lane detail", () => {
    const rankings = [makeYieldRanking({
      altSources: Array.from({ length: YIELD_RANKING_SUMMARY_ALT_SOURCE_LIMIT + 2 }, (_, index) =>
        makeAltYieldSource({ sourceKey: `alt-${index}` })),
    })];
    const summary = projectRows(rankings);
    const model = buildYieldSourceBoardModel(summary.rankings);
    expect(model.representedSourceCount).toBe(1 + rankings[0].altSources.length);
    expect(model.compositionMissingSourceCount).toBe(2);
    expect(model.groups.reduce((sum, lane) => sum + lane.representedSourceCount, 0)).toBe(1 + YIELD_RANKING_SUMMARY_ALT_SOURCE_LIMIT);
    const legacy = { ...summary.rankings[0], provenance: null, altSources: undefined };
    expect(buildYieldSourceBoardModel([legacy])).toMatchObject({
      representedSourceCount: model.representedSourceCount,
      compositionMissingSourceCount: rankings[0].altSources.length,
      anomalyUnavailableCount: 1,
    });
  });
  it("summarizes selected rows, alternate rows, confidence, switches, anomalies, and lane APY", () => {
    const rankings = [
      makeYieldRanking({
        id: "usdc-circle",
        apy30d: 5,
        sourceRisk: {
          sourceRiskPenalty: 1.4,
          sourceRiskScore: 27,
          sourceDepthRatio: 0.0005,
          sourceAgeSeconds: 60,
          venueRiskTier: "unknown",
        },
        warningSignals: ["low-source-tvl"],
        provenance: makeYieldProvenance({
          sourceKey: "compound-usdc",
          confidenceTier: "curated",
          sourceSwitch: true,
          anomalies: ["low-source-tvl"],
        }),
        altSources: [
          makeAltYieldSource({
            sourceKey: "aave-usdc",
            yieldSource: "Aave V3 USDC",
            yieldType: "lending-opportunity",
            dataSource: "defillama-auto",
            apy30d: 4,
          }),
          makeAltYieldSource({
            sourceKey: "sky-usdc",
            yieldSource: "Sky Savings",
            yieldType: "lending-vault",
            dataSource: "defillama",
            apy30d: 6,
          }),
        ],
      }),
      makeYieldRanking({
        id: "eurc-circle",
        symbol: "EURC",
        name: "EURC",
        apy30d: 8,
        yieldSource: "Morpho EURC",
        dataSource: "protocol-api",
        sourceTvlUsd: 20_000_000,
        sourceRisk: {
          sourceRiskPenalty: 1.05,
          sourceRiskScore: 3,
          sourceDepthRatio: 0.005,
          sourceAgeSeconds: 60,
          venueRiskTier: "low",
        },
        benchmarkKey: "EUR",
        benchmarkLabel: "EUR 3M compounded ESTR",
        benchmarkCurrency: "EUR",
        provenance: makeYieldProvenance({
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
    expect(model.selectedConfidenceCounts).toEqual({
      deterministic: 1,
      curated: 1,
      discovered: 0,
      fallback: 0,
    });
    expect(model.selectedConfidenceUnknownCount).toBe(0);
    expect(model.depthCounts).toEqual({
      deep: 0,
      moderate: 1,
      thin: 1,
      unknown: 0,
    });
    expect(model.postureCounts).toEqual({
      clean: 1,
      watch: 0,
      speculative: 1,
    });
    expect(model.topSourceRiskDrivers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: "source-changed", count: 1 }),
        expect.objectContaining({ key: "thin-source-depth", count: 1 }),
      ]),
    );
    expect(model.sourceSwitchCount).toBe(1);
    expect(model.anomalyCount).toBe(1);

    expect(model.groups[0]).toEqual(expect.objectContaining({
      key: "lending-opportunity:protocol-api",
      dataSourceLabel: "Protocol API",
      yieldTypeLabel: "Lending Opp.",
      laneConfidenceTier: "curated",
      selectedCount: 2,
      alternateCount: 0,
      representedSourceCount: 2,
      apy: { min: 5, median: 6.5, max: 8 },
    }));
    expect(model.groups.find((group) => group.key === "lending-opportunity:defillama-auto")).toEqual(
      expect.objectContaining({
        laneConfidenceTier: "discovered",
        selectedCount: 0,
        alternateCount: 1,
        representedSourceCount: 1,
        apy: { min: 4, median: 4, max: 4 },
      }),
    );
    expect(model.groups.find((group) => group.key === "lending-vault:defillama")).toEqual(
      expect.objectContaining({
        laneConfidenceTier: "curated",
        selectedCount: 0,
        alternateCount: 1,
        representedSourceCount: 1,
        apy: { min: 6, median: 6, max: 6 },
      }),
    );
  });

  it("does not assign confidence tiers to alternate source rows", () => {
    const model = buildYieldSourceBoardModel([
      makeYieldRanking({
        provenance: null,
        altSources: [
          makeAltYieldSource({
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

  it("formats prototype-property dataSource values as unknown labels", () => {
    const model = buildYieldSourceBoardModel([
      makeYieldRanking({
        id: "unknown-source-row",
        dataSource: "unknown-source",
        yieldSource: "Unknown Source",
        apy30d: 5,
        provenance: null,
      }),
      makeYieldRanking({
        id: "constructor-source-row",
        dataSource: "constructor",
        yieldSource: "Constructor Source",
        apy30d: 6,
        provenance: null,
      }),
    ]);

    expect(model.groups.map((group) => group.dataSourceLabel)).toEqual([
      "Constructor",
      "Unknown Source",
    ]);
  });

  it("infers lane confidence tier from known dataSource values and returns null for unknown", () => {
    expect(inferLaneConfidenceTier("onchain")).toBe("deterministic");
    expect(inferLaneConfidenceTier("rate-derived")).toBe("deterministic");
    expect(inferLaneConfidenceTier("defillama")).toBe("curated");
    expect(inferLaneConfidenceTier("protocol-api")).toBe("curated");
    expect(inferLaneConfidenceTier("defillama-auto")).toBe("discovered");
    expect(inferLaneConfidenceTier("price-derived")).toBe("fallback");
    expect(inferLaneConfidenceTier("mystery-feed")).toBeNull();
  });

  it("returns empty summaries for an empty ranking set", () => {
    const model = buildYieldSourceBoardModel([]);

    expect(model).toMatchObject({
      selectedCount: 0,
      alternateCount: 0,
      representedSourceCount: 0,
      selectedConfidenceCounts: {
        deterministic: 0,
        curated: 0,
        discovered: 0,
        fallback: 0,
      },
      selectedConfidenceUnknownCount: 0,
      depthCounts: {
        deep: 0,
        moderate: 0,
        thin: 0,
        unknown: 0,
      },
      postureCounts: {
        clean: 0,
        watch: 0,
        speculative: 0,
      },
      topSourceRiskDrivers: [],
      sourceSwitchCount: 0,
      anomalyCount: 0,
      groups: [],
    });
  });
});
