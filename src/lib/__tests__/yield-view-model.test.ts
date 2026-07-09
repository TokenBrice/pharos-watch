import { describe, expect, it } from "vitest";
import { makeAltYieldSource, makeYieldProvenance, makeYieldRanking } from "@/test/fixtures/yield";
import { YIELD_FILTER_AXIS_REGISTRY, buildYieldViewModel } from "@/lib/yield-view-model";

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
      sourcePosture: "reckless",
      attention: "urgent",
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
      sourcePosture: "all",
      attention: "all",
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
      "sourcePosture",
      "attention",
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

  it("groups fixed-yield PT and structured-tranche rows with external opportunity rows", () => {
    const opportunityRows = [
      makeYieldRanking({ id: "native", symbol: "NATIVE", yieldType: "lending-vault" }),
      makeYieldRanking({ id: "lend", symbol: "LEND", yieldType: "lending-opportunity" }),
      makeYieldRanking({ id: "fixed", symbol: "FIXED", yieldType: "fixed-yield" }),
      makeYieldRanking({ id: "tranche", symbol: "TRANCHE", yieldType: "structured-tranche" }),
    ];
    const model = buildYieldViewModel(opportunityRows, { opportunity: "lending-opportunity" });

    expect(model.visibleRows.map((row) => row.id).sort()).toEqual(["fixed", "lend", "tranche"]);
    expect(model.comparisonLabel).toBe("External opportunities");
    expect(model.visibleRows[0]?.rankLabel).toContain("External opportunities");
    expect(model.options.opportunity).toEqual([
      { value: "all", label: "All opportunities", count: 4 },
      { value: "holder-yield", label: "Holder yield", count: 1 },
      { value: "lending-opportunity", label: "External opportunities", count: 3 },
    ]);

    const trancheModel = buildYieldViewModel(opportunityRows, { yieldType: "structured-tranche" });
    expect(trancheModel.filters.yieldType).toBe("structured-tranche");
    expect(trancheModel.visibleRows.map((row) => row.id)).toEqual(["tranche"]);
    expect(trancheModel.comparisonLabel).toBe("Structured Tranche");
    expect(trancheModel.options.yieldType).toContainEqual({
      value: "structured-tranche",
      label: "Structured Tranche",
      count: 1,
    });
  });

  it("keeps expanded benchmark registry values valid when matching rows exist", () => {
    const model = buildYieldViewModel(
      [
        makeYieldRanking({
          id: "mxn-yield-row",
          symbol: "MXNY",
          name: "MXN Yield",
          benchmarkKey: "MXN",
          benchmarkLabel: "MXN short rate",
          benchmarkRate: 10.5,
          provenance: makeYieldProvenance({
            benchmarkKey: "MXN",
            benchmarkLabel: "MXN short rate",
            benchmarkRate: 10.5,
          }),
        }),
      ],
      { benchmark: "MXN" },
    );

    expect(model.filters.benchmark).toBe("MXN");
    expect(model.invalidParamKeys).not.toContain("benchmark");
    expect(model.visibleRows.map((row) => row.id)).toEqual(["mxn-yield-row"]);
    expect(model.options.benchmark).toContainEqual({ value: "MXN", label: "MXN", count: 1 });
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
      rankLabel: "#1 in Non-USD set",
    });
  });

  it("returns a useful filtered empty state", () => {
    const model = buildYieldViewModel(rows, { q: "zzzz" });

    expect(model.visibleRows).toEqual([]);
    expect(model.emptyState).toMatchObject({
      isEmpty: true,
      title: "No rows match this view",
      description: "Reset one or more filters to broaden the comparable set.",
    });
    expect(model.stats.avgApy).toBe(0);
    expect(model.stats.medianApy).toBe(0);
  });

  it("keeps empty payload median APY at zero", () => {
    const model = buildYieldViewModel([], {});

    expect(model.visibleRows).toEqual([]);
    expect(model.stats.avgApy).toBe(0);
    expect(model.stats.medianApy).toBe(0);
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

  it("filters by source posture with watch as a clean-or-watch cap", () => {
    const postureRows = [
      makeYieldRanking({
        id: "clean-row",
        symbol: "CLN",
        sourceRisk: {
          sourceRiskPenalty: 1.05,
          sourceDepthRatio: 0.005,
          sourceAgeSeconds: 60,
          venueRiskTier: "low",
        },
        sourceTvlUsd: 10_000_000,
        warningSignals: [],
        provenance: makeYieldProvenance({ sourceSwitch: false }),
      }),
      makeYieldRanking({
        id: "watch-row",
        symbol: "WCH",
        sourceRisk: {
          sourceRiskPenalty: 1.15,
          sourceDepthRatio: 0.005,
          sourceAgeSeconds: 60,
          venueRiskTier: "medium",
        },
        sourceTvlUsd: 10_000_000,
        warningSignals: [],
        provenance: makeYieldProvenance({ sourceSwitch: false }),
      }),
      makeYieldRanking({
        id: "spec-row",
        symbol: "SPC",
        sourceRisk: {
          sourceRiskPenalty: 1.4,
          sourceDepthRatio: 0.0005,
          sourceAgeSeconds: 60,
          venueRiskTier: "unknown",
        },
        sourceTvlUsd: 10_000_000,
        warningSignals: [],
        provenance: makeYieldProvenance({ sourceSwitch: false }),
      }),
    ];

    const clean = buildYieldViewModel(postureRows, { sourcePosture: "clean" });
    expect(clean.visibleRows.map((row) => row.id)).toEqual(["clean-row"]);
    expect(clean.comparisonLabel).toBe("Clean source posture");

    const watch = buildYieldViewModel(postureRows, { sourcePosture: "watch" });
    expect(watch.visibleRows.map((row) => row.id)).toEqual(["clean-row", "watch-row"]);
    expect(watch.comparisonLabel).toBe("Clean/watch source posture");

    const watchOnly = buildYieldViewModel(postureRows, { sourcePosture: "watch-only" });
    expect(watchOnly.visibleRows.map((row) => row.id)).toEqual(["watch-row"]);
    expect(watchOnly.comparisonLabel).toBe("Watch source posture");

    const speculative = buildYieldViewModel(postureRows, { sourcePosture: "speculative" });
    expect(speculative.visibleRows.map((row) => row.id)).toEqual(["spec-row"]);
    expect(speculative.options.sourcePosture).toEqual([
      { value: "all", label: "All postures", count: 3 },
      { value: "clean", label: "Clean", count: 1 },
      { value: "watch", label: "Clean + watch", count: 2 },
      { value: "watch-only", label: "Watch only", count: 1 },
      { value: "speculative", label: "Speculative", count: 1 },
    ]);
    expect(speculative.visibleRows[0]?.sourcePosture).toBe("speculative");
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
    const warningsModel = buildYieldViewModel(rows, { attention: "watchlist" }, {
      watchlistIds: new Set(["usdc-circle", "eurc-circle", "usdt-tether"]),
    });
    expect(warningsModel.matchingPreset).toBe("watchlist-warnings");
    const watchlist = warningsModel.presets.find((preset) => preset.key === "watchlist-warnings");
    expect(watchlist?.active).toBe(true);
    expect(watchlist?.count).toBe(3);

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

  it("defaults to all when watchlistIds is not provided", () => {
    const model = buildYieldViewModel(rows, {});

    expect(model.filters.watchlist).toBe("all");
    expect(model.visibleRows.map((row) => row.id)).toEqual(["usdc-circle", "eurc-circle", "usdt-tether"]);
    expect(model.options.watchlist.find((option) => option.value === "only")?.count).toBe(0);
  });

  it("counts watchlist matches and filters to only watchlist rows", () => {
    const watchlistIds = new Set(["usdc-circle", "usdt-tether"]);

    const allModel = buildYieldViewModel(rows, {}, { watchlistIds });
    expect(allModel.options.watchlist.find((option) => option.value === "only")?.count).toBe(2);
    expect(allModel.visibleRows).toHaveLength(3);

    const onlyModel = buildYieldViewModel(rows, { watchlist: "only" }, { watchlistIds });
    expect(onlyModel.visibleRows.map((row) => row.id)).toEqual(["usdc-circle", "usdt-tether"]);
  });

  it("filters watched rows that need attention without forcing warnings/source-changed AND semantics", () => {
    const watchlistIds = new Set(["usdc-circle", "eurc-circle", "usdt-tether"]);

    const allModel = buildYieldViewModel(rows, {}, { watchlistIds });
    expect(allModel.options.attention.find((option) => option.value === "watchlist")?.count).toBe(3);

    const attentionModel = buildYieldViewModel(rows, { attention: "watchlist" }, { watchlistIds });
    expect(attentionModel.visibleRows.map((row) => row.id)).toEqual([
      "usdc-circle",
      "eurc-circle",
      "usdt-tether",
    ]);
    expect(attentionModel.comparisonLabel).toBe("Watched rows needing attention");

    const warningAndChangedOnly = buildYieldViewModel(rows, {
      watchlist: "only",
      warnings: "only",
      sourceChanged: "only",
    }, { watchlistIds });
    expect(warningAndChangedOnly.visibleRows.map((row) => row.id)).toEqual([]);
  });

  it("normalizes invalid watchlist URL params back to default", () => {
    const model = buildYieldViewModel(rows, { watchlist: "bogus" });

    expect(model.filters.watchlist).toBe("all");
    expect(model.invalidParamKeys).toContain("watchlist");
  });

  it("yields empty visible rows when watchlist=only and no ids are provided", () => {
    const model = buildYieldViewModel(rows, { watchlist: "only" });

    expect(model.visibleRows).toEqual([]);
  });

  it("supports merging multiple preset overrides on a single model", () => {
    // Simulates the stackable-preset wire flow: best-dollar then treasury-grade.
    // best-dollar overrides: { peg: "USD", minSafety: 80 }
    // treasury-grade overrides: { minSafety: 80, depth: "hide-thin", sourceConfidence: "deterministic" }
    // Merge result (last-applied wins on conflict) should preserve all keys.
    const merged = buildYieldViewModel(rows, {
      peg: "USD",
      minSafety: "80",
      depth: "hide-thin",
      sourceConfidence: "deterministic",
    });

    expect(merged.filters).toMatchObject({
      peg: "USD",
      minSafety: 80,
      depth: "hide-thin",
      sourceConfidence: "deterministic",
    });
    // No single preset matches the merged state.
    expect(merged.matchingPreset).toBeNull();
  });

  it("matches each risk-budget stop's filter overrides to its matching key", () => {
    const conservative = buildYieldViewModel(rows, {
      minSafety: "80",
      depth: "hide-thin",
      sourcePosture: "clean",
      warnings: "hide",
    });
    expect(conservative.riskBudget.matching).toBe("conservative");

    const balanced = buildYieldViewModel(rows, {
      minSafety: "70",
      depth: "hide-thin",
      sourcePosture: "watch",
      warnings: "hide",
    });
    expect(balanced.riskBudget.matching).toBe("balanced");

    const opportunistic = buildYieldViewModel(rows, {
      minSafety: "50",
      warnings: "hide",
    });
    expect(opportunistic.riskBudget.matching).toBe("opportunistic");

    const all = buildYieldViewModel(rows, {});
    expect(all.riskBudget.matching).toBe("all");

    const stops = all.riskBudget.stops.map((stop) => stop.key);
    expect(stops).toEqual(["conservative", "balanced", "opportunistic", "all"]);
    expect(all.riskBudget.stops.every((stop) => stop.count >= 0)).toBe(true);
  });

  it("returns null matchingRiskBudget when filters don't match any stop", () => {
    const model = buildYieldViewModel(rows, { minSafety: "65" });
    expect(model.riskBudget.matching).toBeNull();
    expect(model.riskBudget.stops.every((stop) => stop.active === false)).toBe(true);
  });

  it("computes empty-state suggestions ranked by row recovery", () => {
    // Designed so dropping any of these three filters recovers a non-empty subset:
    //   peg=USD ∧ warnings=only ∧ benchmark=EUR
    // Drop peg → EURC matches (warnings+EUR). Drop benchmark → USDT matches.
    // Drop warnings → still empty (USDC/USDT are USD-not-EUR). Top 3 by gain.
    const model = buildYieldViewModel(rows, {
      peg: "USD",
      warnings: "only",
      benchmark: "EUR",
    });

    expect(model.visibleRows).toEqual([]);
    expect(model.emptyState.isEmpty).toBe(true);
    expect(model.emptyState.suggestions.length).toBeGreaterThan(0);
    expect(model.emptyState.suggestions.length).toBeLessThanOrEqual(3);
    expect(model.emptyState.suggestions.every((s) => s.gain > 0)).toBe(true);
    const gains = model.emptyState.suggestions.map((s) => s.gain);
    expect(gains).toEqual([...gains].sort((a, b) => b - a));
    const keys = model.emptyState.suggestions.map((s) => s.filterKey);
    expect(keys).toEqual(expect.arrayContaining(["peg", "benchmark"]));
  });

  it("emits no empty-state suggestions when the payload itself is empty", () => {
    const model = buildYieldViewModel([], {});
    expect(model.emptyState.isEmpty).toBe(true);
    expect(model.emptyState.suggestions).toEqual([]);
  });

  it("suggests relaxing the watchlist filter when it leaves zero visible rows", () => {
    // WHY: regression guard — getActiveFilterSummaries and listFilterRelaxations
    // used to drift; watchlist used to surface as an active chip but not as a relax
    // candidate. The registry now drives both.
    const model = buildYieldViewModel(rows, { watchlist: "only" }, { watchlistIds: new Set<string>() });
    expect(model.visibleRows).toEqual([]);
    const keys = model.emptyState.suggestions.map((s) => s.filterKey);
    expect(keys).toContain("watchlist");
  });

  it("computes cohort percentile per row and suppresses small cohorts", () => {
    const cohortRows = Array.from({ length: 12 }, (_, i) =>
      makeYieldRanking({
        id: `lend-${i}`,
        symbol: `LEND${i}`,
        yieldType: "lending-opportunity",
        safetyGrade: "A",
        pharosYieldScore: i * 5,
      }),
    );
    // 3 rows in a "B" band — too small (<8) for a percentile.
    const smallCohort = Array.from({ length: 3 }, (_, i) =>
      makeYieldRanking({
        id: `vault-${i}`,
        symbol: `VLT${i}`,
        yieldType: "lending-vault",
        safetyGrade: "B",
        pharosYieldScore: i * 10,
      }),
    );

    const model = buildYieldViewModel([...cohortRows, ...smallCohort], {});
    const top = model.visibleRows.find((row) => row.id === "lend-11");
    const bottom = model.visibleRows.find((row) => row.id === "lend-0");
    const smallCohortRow = model.visibleRows.find((row) => row.id === "vault-2");

    expect(top?.cohortPercentile?.cohortSize).toBe(12);
    expect(top?.cohortPercentile?.value).toBe(100);
    expect(bottom?.cohortPercentile?.value).toBeLessThan(20);

    expect(smallCohortRow?.cohortPercentile?.cohortSize).toBe(3);
    expect(smallCohortRow?.cohortPercentile?.value).toBeNull();
  });

  it("registers a descriptor for every YieldViewModelFilters key (no drift)", () => {
    // Guards the invariant that every filter key has a registry entry, or the
    // row predicates, active-summary chips, and empty-state suggestion ranker
    // can drift silently.
    const defaultFilterKeys = Object.keys(buildYieldViewModel([], {}).filters).sort();
    const registryKeys = YIELD_FILTER_AXIS_REGISTRY.map((axis) => axis.key as string).sort();

    expect(registryKeys).toEqual(defaultFilterKeys);
    expect(YIELD_FILTER_AXIS_REGISTRY.length).toBe(defaultFilterKeys.length);
    expect(new Set(registryKeys).size).toBe(registryKeys.length);
    expect(
      YIELD_FILTER_AXIS_REGISTRY.every((axis) => typeof (axis as { matches?: unknown }).matches === "function"),
    ).toBe(true);
  });
});
