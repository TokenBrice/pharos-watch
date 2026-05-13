import { describe, expect, it } from "vitest";
import { buildYieldSourceBoardModel } from "@/app/yield/source-board-model";
import { makeAltYieldSource, makeYieldProvenance, makeYieldRanking } from "./test-helpers";
import type { YieldBenchmarkRegistry } from "@shared/types";

describe("buildYieldSourceBoardModel", () => {
  it("summarizes selected rows, alternate rows, confidence, switches, anomalies, and source-row APY", () => {
    const rankings = [
      makeYieldRanking({
        id: "usdc-circle",
        apy30d: 5,
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
    expect(model.representedDataSourceCount).toBe(3);
    expect(model.selectedConfidenceCounts).toEqual({
      deterministic: 1,
      curated: 1,
      discovered: 0,
      fallback: 0,
    });
    expect(model.selectedConfidenceUnknownCount).toBe(0);
    expect(model.depthCounts).toEqual({
      deep: 0,
      moderate: 0,
      thin: 0,
      unknown: 2,
    });
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
        makeYieldRanking({
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
      depthCounts: {
        deep: 0,
        moderate: 0,
        thin: 0,
        unknown: 0,
      },
      sourceSwitchCount: 0,
      anomalyCount: 0,
      sourceRowApy: null,
      benchmarkLabels: [],
      groups: [],
    });
  });
});
