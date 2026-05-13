import { describe, expect, it } from "vitest";
import { makeAltYieldSource, makeYieldProvenance, makeYieldRanking } from "@/app/yield/test-helpers";
import { buildYieldViewModel } from "@/lib/yield-view-model";

const rows = [
  makeYieldRanking({
    id: "usdc-circle",
    symbol: "USDC",
    name: "USD Coin",
    yieldType: "lending-opportunity",
    warningSignals: [],
    safetyScore: 82,
    sourceTvlUsd: 5_000_000,
    pharosYieldScore: 72,
    benchmarkKey: "USD",
    benchmarkLabel: "USD 3M T-Bill",
    benchmarkRate: 4.25,
    provenance: makeYieldProvenance({
      confidenceTier: "curated",
      benchmarkKey: "USD",
      benchmarkLabel: "USD 3M T-Bill",
      benchmarkRate: 4.25,
    }),
    altSources: [
      makeAltYieldSource({
        yieldSource: "Aave V3 USDC",
        dataSource: "defillama-auto",
      }),
    ],
  }),
  makeYieldRanking({
    id: "eurc-circle",
    symbol: "EURC",
    name: "EURC",
    yieldType: "lending-vault",
    warningSignals: ["data-stale"],
    safetyScore: null,
    safetyGrade: null,
    sourceTvlUsd: null,
    pharosYieldScore: 66,
    benchmarkKey: "EUR",
    benchmarkLabel: "EUR 3M compounded ESTR",
    benchmarkRate: 2.5,
    provenance: makeYieldProvenance({
      confidenceTier: "deterministic",
      benchmarkKey: "EUR",
      benchmarkLabel: "EUR 3M compounded ESTR",
      benchmarkRate: 2.5,
    }),
  }),
  makeYieldRanking({
    id: "usdt-tether",
    symbol: "USDT",
    name: "Tether USD",
    yieldType: "lending-opportunity",
    warningSignals: ["low-source-tvl"],
    safetyScore: 65,
    sourceTvlUsd: 50_000_000,
    pharosYieldScore: 58,
    benchmarkKey: "USD",
    benchmarkLabel: "USD 3M T-Bill",
    benchmarkRate: 4.25,
    provenance: makeYieldProvenance({
      confidenceTier: "discovered",
      benchmarkKey: "USD",
      benchmarkLabel: "USD 3M T-Bill",
      benchmarkRate: 4.25,
    }),
  }),
];

describe("buildYieldViewModel", () => {
  it("normalizes invalid URL params back to defaults without breaking the view", () => {
    const model = buildYieldViewModel(rows, {
      peg: "DOGE",
      yieldType: "rebasing",
      warnings: "bad",
      minSafety: "-1",
      minTvl: "tiny",
      sourceConfidence: "fallback",
      benchmark: "JPY",
      opportunity: "venue",
    });

    expect(model.filters).toMatchObject({
      peg: "all",
      yieldType: "all",
      warnings: "all",
      minSafety: null,
      minTvl: null,
      sourceConfidence: "all",
      benchmark: "all",
      opportunity: "all",
    });
    expect(model.invalidParamKeys).toEqual([
      "peg",
      "yieldType",
      "warnings",
      "minSafety",
      "minTvl",
      "sourceConfidence",
      "benchmark",
      "opportunity",
    ]);
    expect(model.visibleRows).toHaveLength(3);
  });

  it("applies every supported current-payload filter from one model", () => {
    const model = buildYieldViewModel(rows, {
      peg: "non-usd",
      yieldType: "lending-vault",
      q: "eur",
      warnings: "only",
      sourceConfidence: "deterministic",
      benchmark: "EUR",
      opportunity: "holder-yield",
    });

    expect(model.visibleRows.map((row) => row.id)).toEqual(["eurc-circle"]);
    expect(model.filters).toMatchObject({
      peg: "non-usd",
      yieldType: "lending-vault",
      q: "eur",
      warnings: "only",
      sourceConfidence: "deterministic",
      benchmark: "EUR",
      opportunity: "holder-yield",
    });
  });

  it("excludes null safety and TVL only when minimum filters are set", () => {
    expect(buildYieldViewModel(rows, {}).visibleRows.map((row) => row.id)).toContain("eurc-circle");

    const safetyFiltered = buildYieldViewModel(rows, { minSafety: "70" });
    expect(safetyFiltered.visibleRows.map((row) => row.id)).toEqual(["usdc-circle"]);

    const tvlFiltered = buildYieldViewModel(rows, { minTvl: "10000000" });
    expect(tvlFiltered.visibleRows.map((row) => row.id)).toEqual(["usdt-tether"]);
  });

  it("filters source confidence by the selected source, not alternate sources", () => {
    const model = buildYieldViewModel(rows, { sourceConfidence: "curated" });

    expect(model.visibleRows.map((row) => row.id)).toEqual(["usdc-circle"]);
  });

  it("derives view-rank labels inside the filtered comparable set", () => {
    const model = buildYieldViewModel(rows, { peg: "non-usd" });

    expect(model.visibleRows).toHaveLength(1);
    expect(model.visibleRows[0]).toMatchObject({
      id: "eurc-circle",
      viewRank: 1,
      rankWithinSet: 1,
      rankLabel: "#1 in Non-USD set",
    });
  });

  it("exposes only current-payload comparable sets", () => {
    const model = buildYieldViewModel(rows, {});

    expect(model.comparableSets.map((set) => set.basis)).toEqual(
      expect.arrayContaining(["yield-type", "peg", "benchmark", "warning-state", "source-confidence", "tvl"]),
    );
    expect(model.comparableSets.map((set) => set.basis)).not.toEqual(
      expect.arrayContaining(["chain", "venue", "risk-tier", "deployment-place"]),
    );
  });

  it("returns a useful filtered empty state", () => {
    const model = buildYieldViewModel(rows, { q: "zzzz" });

    expect(model.visibleRows).toEqual([]);
    expect(model.emptyState).toEqual({
      isEmpty: true,
      title: "No rows match this view",
      description: "Reset one or more filters to broaden the comparable set.",
    });
    expect(model.stats.avgApy).toBe(0);
  });
});
