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
    sourceRisk: {
      sourceDepthRatio: 0.0005,
    },
    pharosYieldScore: 72,
    benchmarkKey: "USD",
    benchmarkLabel: "USD 3M T-Bill",
    benchmarkRate: 4.25,
    provenance: makeYieldProvenance({
      confidenceTier: "curated",
      sourceSwitch: true,
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
    sourceRisk: {
      sourceDepthRatio: 0.005,
    },
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
      expect.arrayContaining(["yield-type", "peg", "benchmark", "warning-state", "source-confidence", "tvl", "source-depth"]),
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

  it("filters by URL-backed source depth lens", () => {
    expect(buildYieldViewModel(rows, { depth: "thin" }).visibleRows.map((row) => row.id)).toEqual(["usdc-circle"]);
    expect(buildYieldViewModel(rows, { depth: "moderate" }).visibleRows.map((row) => row.id)).toEqual(["usdt-tether"]);
    expect(buildYieldViewModel(rows, { depth: "hide-thin" }).visibleRows.map((row) => row.id)).toEqual([
      "eurc-circle",
      "usdt-tether",
    ]);

    expect(buildYieldViewModel(rows, {}).options.depth.find((option) => option.value === "hide-thin")).toEqual({
      value: "hide-thin",
      label: "Hide thin venues",
      count: 2,
    });
  });

  it("filters rows with changed sources from URL state", () => {
    expect(buildYieldViewModel(rows, { sourceChanged: "only" }).visibleRows.map((row) => row.id)).toEqual([
      "usdc-circle",
    ]);
    expect(buildYieldViewModel(rows, { sourceChanged: "none" }).visibleRows.map((row) => row.id)).toEqual([
      "eurc-circle",
      "usdt-tether",
    ]);
  });

  it("filters rising rows by current vs 30d APY with observation floor", () => {
    const trendingRows = [
      makeYieldRanking({
        id: "rising-row",
        symbol: "RISE",
        name: "Rising",
        currentApy: 8,
        apy30d: 5,
        sourceRisk: { observationCount30d: 12 },
      }),
      makeYieldRanking({
        id: "flat-row",
        symbol: "FLAT",
        name: "Flat",
        currentApy: 5,
        apy30d: 5,
        sourceRisk: { observationCount30d: 12 },
      }),
      makeYieldRanking({
        id: "thin-history-row",
        symbol: "THIN",
        name: "Thin History",
        currentApy: 9,
        apy30d: 5,
        sourceRisk: { observationCount30d: 3 },
      }),
    ];

    const model = buildYieldViewModel(trendingRows, { trending: "rising" });
    expect(model.visibleRows.map((row) => row.id)).toEqual(["rising-row"]);
  });

  it("marks the active preset and counts its matching rows", () => {
    const warningsModel = buildYieldViewModel(rows, { warnings: "only" });
    expect(warningsModel.matchingPreset).toBe("watchlist-warnings");
    const watchlist = warningsModel.presets.find((preset) => preset.key === "watchlist-warnings");
    expect(watchlist?.active).toBe(true);
    expect(watchlist?.count).toBe(2);

    const defaultModel = buildYieldViewModel(rows, {});
    expect(defaultModel.matchingPreset).toBeNull();
  });

  it("deactivates the preset when an additional filter is toggled", () => {
    const model = buildYieldViewModel(rows, { warnings: "only", minSafety: "70" });
    expect(model.matchingPreset).toBeNull();
  });

  it("builds currency tab options conditional on row presence", () => {
    const model = buildYieldViewModel(rows, {});
    const tabValues = model.options.currencyTabs.map((option) => option.value);

    // USD + EUR present in rows; AUD/CAD/Other absent → no tabs for those.
    expect(tabValues).toEqual(["all", "USD", "EUR"]);
    expect(model.options.currencyTabs.find((option) => option.value === "all")?.count).toBe(3);
    expect(model.options.currencyTabs.find((option) => option.value === "USD")?.count).toBe(2);
    expect(model.options.currencyTabs.find((option) => option.value === "EUR")?.count).toBe(1);
  });

  it("groups AUD/CAD into a shared tab and aggregates non-enumerated pegs into Other", () => {
    const audCadOtherRows = [
      makeYieldRanking({ id: "audd-novatti", symbol: "AUDD", name: "AUDD" }),
      makeYieldRanking({ id: "cadm-mento", symbol: "CADM", name: "CADM" }),
      makeYieldRanking({ id: "zarp-zarp", symbol: "ZARP", name: "ZARP" }),
      makeYieldRanking({ id: "paxg-paxos", symbol: "PAXG", name: "PAXG" }),
    ];

    const model = buildYieldViewModel(audCadOtherRows, {});
    const tabValues = model.options.currencyTabs.map((option) => option.value);

    expect(tabValues).toEqual(["all", "aud-cad", "other"]);
    expect(model.options.currencyTabs.find((option) => option.value === "aud-cad")?.count).toBe(2);
    expect(model.options.currencyTabs.find((option) => option.value === "other")?.count).toBe(2);
  });

  it("filters rows by the aud-cad and other peg aggregates", () => {
    const audCadOtherRows = [
      makeYieldRanking({ id: "audd-novatti", symbol: "AUDD" }),
      makeYieldRanking({ id: "cadm-mento", symbol: "CADM" }),
      makeYieldRanking({ id: "zarp-zarp", symbol: "ZARP" }),
      makeYieldRanking({ id: "usdc-circle", symbol: "USDC" }),
    ];

    const audCadModel = buildYieldViewModel(audCadOtherRows, { peg: "aud-cad" });
    expect(audCadModel.visibleRows.map((row) => row.id)).toEqual(["audd-novatti", "cadm-mento"]);
    expect(audCadModel.comparisonLabel).toBe("AUD/CAD set");

    const otherModel = buildYieldViewModel(audCadOtherRows, { peg: "other" });
    expect(otherModel.visibleRows.map((row) => row.id)).toEqual(["zarp-zarp"]);
    expect(otherModel.comparisonLabel).toBe("Other currencies set");
  });

  it("accepts aud-cad and other peg URL params even when no peg-pill option matches", () => {
    const audCadRows = [
      makeYieldRanking({ id: "audd-novatti", symbol: "AUDD" }),
    ];

    const model = buildYieldViewModel(audCadRows, { peg: "aud-cad" });
    expect(model.filters.peg).toBe("aud-cad");
    expect(model.invalidParamKeys).not.toContain("peg");
  });
});
