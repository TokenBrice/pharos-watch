import { describe, expect, it } from "vitest";
import { makeAltYieldSource, makeYieldProvenance, makeYieldRanking } from "@shared/test-utils/yield-ranking-fixtures";
import { RISK_BUDGET_FILTER_KEYS, YIELD_FILTER_AXIS_REGISTRY, YIELD_LANDING_RISK_BUDGET, buildYieldViewModel, prepareYieldUniverse, riskBudgetUrlValue } from "@/lib/yield-view-model";
import type { YieldViewModelUrlParams } from "@/lib/yield-view-config";
import { formatTvlOption } from "@/lib/yield-view-model-helpers";

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
    warningSignals: ["yield-spike"],
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

describe("TVL filter capacity labels", () => {
  it.each([NaN, Infinity, -Infinity])("keeps invalid capacity %s unavailable", (value) => {
    expect(formatTvlOption(value)).toBe("N/A");
  });
  it("preserves finite thresholds, zero, and negatives", () => {
    expect(formatTvlOption(250_000_000)).toBe("$250M+");
    expect(formatTvlOption(0)).toBe("$0+");
    expect(formatTvlOption(-250)).toBe("$-250+");
  });
});

describe("buildYieldViewModel", () => {
  it("normalizes invalid URL params back to defaults without breaking the view", () => {
    const model = buildYieldViewModel(prepareYieldUniverse(rows, null), {
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

  it.each([
    [{ risk: "any", peg: "non-usd" }, ["eurc-circle"]],
    [{ risk: "any", yieldType: "lending-vault" }, ["eurc-circle"]],
    [{ risk: "any", q: "eur" }, ["eurc-circle"]],
    [{ risk: "any", warnings: "only" }, ["eurc-circle", "usdt-tether"]],
    [{ risk: "any", sourceConfidence: "deterministic" }, ["eurc-circle"]],
    [{ risk: "any", benchmark: "EUR" }, ["eurc-circle"]],
    [{ risk: "any", opportunity: "holder-yield" }, ["eurc-circle"]],
  ])("independently filters by %j", (filters, expected) => {
    const model = buildYieldViewModel(prepareYieldUniverse(rows, null), filters);
    expect(model.visibleRows.map((row) => row.id).sort()).toEqual(expected);
  });

  it("composes multiple current-payload filters with AND semantics", () => {
    const model = buildYieldViewModel(prepareYieldUniverse(rows, null), {
      risk: "any",
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
    const model = buildYieldViewModel(prepareYieldUniverse(opportunityRows, null), { risk: "any", opportunity: "lending-opportunity" });

    expect(model.visibleRows.map((row) => row.id).sort()).toEqual(["fixed", "lend", "tranche"]);
    expect(model.comparisonLabel).toBe("External opportunities");
    expect(model.visibleRows[0]?.rankLabel).toContain("External opportunities");
    expect(model.options.opportunity).toEqual([
      { value: "all", label: "All opportunities", count: 4 },
      { value: "holder-yield", label: "Holder yield", count: 1 },
      { value: "lending-opportunity", label: "External opportunities", count: 3 },
    ]);

    const trancheModel = buildYieldViewModel(prepareYieldUniverse(opportunityRows, null), { risk: "any", yieldType: "structured-tranche" });
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
      prepareYieldUniverse(
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
        null,
      ),
      { benchmark: "MXN" },
    );

    expect(model.filters.benchmark).toBe("MXN");
    expect(model.invalidParamKeys).not.toContain("benchmark");
    expect(model.visibleRows.map((row) => row.id)).toEqual(["mxn-yield-row"]);
    expect(model.options.benchmark).toContainEqual({ value: "MXN", label: "MXN", count: 1 });
  });

  it("excludes null safety and TVL only when minimum filters are set", () => {
    expect(buildYieldViewModel(prepareYieldUniverse(rows, null), { risk: "any" }).visibleRows.map((row) => row.id)).toContain("eurc-circle");

    const safetyFiltered = buildYieldViewModel(prepareYieldUniverse(rows, null), { risk: "any", minSafety: "70" });
    expect(safetyFiltered.visibleRows.map((row) => row.id)).toEqual(["usdc-circle"]);

    const tvlFiltered = buildYieldViewModel(prepareYieldUniverse(rows, null), { risk: "any", minTvl: "10000000" });
    expect(tvlFiltered.visibleRows.map((row) => row.id)).toEqual(["usdt-tether"]);
  });

  it("filters source confidence by the selected source, not alternate sources", () => {
    const model = buildYieldViewModel(prepareYieldUniverse(rows, null), { sourceConfidence: "curated" });

    expect(model.visibleRows.map((row) => row.id)).toEqual(["usdc-circle"]);
  });

  it("derives view-rank labels inside the filtered comparable set", () => {
    const model = buildYieldViewModel(prepareYieldUniverse(rows, null), { risk: "any", peg: "non-usd" });

    expect(model.visibleRows).toHaveLength(1);
    expect(model.visibleRows[0]).toMatchObject({
      id: "eurc-circle",
      viewRank: 1,
      rankLabel: "#1 in Non-USD set",
    });
  });

  it("filters by URL-backed source depth lens", () => {
    expect(buildYieldViewModel(prepareYieldUniverse(rows, null), { risk: "any", depth: "thin" }).visibleRows.map((row) => row.id)).toEqual(["usdc-circle"]);
    expect(buildYieldViewModel(prepareYieldUniverse(rows, null), { risk: "any", depth: "moderate" }).visibleRows.map((row) => row.id)).toEqual(["usdt-tether"]);
    expect(buildYieldViewModel(prepareYieldUniverse(rows, null), { risk: "any", depth: "hide-thin" }).visibleRows.map((row) => row.id)).toEqual([
      "eurc-circle",
      "usdt-tether",
    ]);

    expect(buildYieldViewModel(prepareYieldUniverse(rows, null), { risk: "any" }).options.depth.find((option) => option.value === "hide-thin")).toEqual({
      value: "hide-thin",
      label: "Hide thin venues",
      count: 2,
    });
  });

  it("filters rows with changed sources from URL state", () => {
    expect(buildYieldViewModel(prepareYieldUniverse(rows, null), { risk: "any", sourceChanged: "only" }).visibleRows.map((row) => row.id)).toEqual([
      "usdc-circle",
    ]);
    expect(buildYieldViewModel(prepareYieldUniverse(rows, null), { risk: "any", sourceChanged: "none" }).visibleRows.map((row) => row.id)).toEqual([
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

    const clean = buildYieldViewModel(prepareYieldUniverse(postureRows, null), { risk: "any", sourcePosture: "clean" });
    expect(clean.visibleRows.map((row) => row.id)).toEqual(["clean-row"]);
    expect(clean.comparisonLabel).toBe("Clean source posture");

    const watch = buildYieldViewModel(prepareYieldUniverse(postureRows, null), { risk: "any", sourcePosture: "watch" });
    expect(watch.visibleRows.map((row) => row.id)).toEqual(["clean-row", "watch-row"]);
    expect(watch.comparisonLabel).toBe("Clean/watch source posture");

    const watchOnly = buildYieldViewModel(prepareYieldUniverse(postureRows, null), { risk: "any", sourcePosture: "watch-only" });
    expect(watchOnly.visibleRows.map((row) => row.id)).toEqual(["watch-row"]);
    expect(watchOnly.comparisonLabel).toBe("Watch source posture");

    const speculative = buildYieldViewModel(prepareYieldUniverse(postureRows, null), { risk: "any", sourcePosture: "speculative" });
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

    const model = buildYieldViewModel(prepareYieldUniverse(trendingRows, null), { trending: "rising" });
    expect(model.visibleRows.map((row) => row.id)).toEqual(["rising-row"]);
  });

  it("filters rows by the aud-cad and other peg aggregates", () => {
    const audCadOtherRows = [
      makeYieldRanking({ id: "audd-novatti", symbol: "AUDD" }),
      makeYieldRanking({ id: "cadm-mento", symbol: "CADM" }),
      makeYieldRanking({ id: "zarp-zarp", symbol: "ZARP" }),
      makeYieldRanking({ id: "usdc-circle", symbol: "USDC" }),
    ];

    const audCadModel = buildYieldViewModel(prepareYieldUniverse(audCadOtherRows, null), { peg: "aud-cad" });
    expect(audCadModel.visibleRows.map((row) => row.id)).toEqual(["audd-novatti", "cadm-mento"]);
    expect(audCadModel.comparisonLabel).toBe("AUD/CAD set");

    const otherModel = buildYieldViewModel(prepareYieldUniverse(audCadOtherRows, null), { peg: "other" });
    expect(otherModel.visibleRows.map((row) => row.id)).toEqual(["zarp-zarp"]);
    expect(otherModel.comparisonLabel).toBe("Other currencies set");
  });

  it("accepts aud-cad and other peg URL params even when no peg-pill option matches", () => {
    const audCadRows = [
      makeYieldRanking({ id: "audd-novatti", symbol: "AUDD" }),
    ];

    const model = buildYieldViewModel(prepareYieldUniverse(audCadRows, null), { peg: "aud-cad" });
    expect(model.filters.peg).toBe("aud-cad");
    expect(model.invalidParamKeys).not.toContain("peg");
  });

  it("defaults to all when watchlistIds is not provided", () => {
    const model = buildYieldViewModel(prepareYieldUniverse(rows, null), { risk: "any" });

    expect(model.filters.watchlist).toBe("all");
    expect(model.visibleRows.map((row) => row.id)).toEqual(["usdc-circle", "eurc-circle", "usdt-tether"]);
    expect(model.options.watchlist.find((option) => option.value === "only")?.count).toBe(0);
  });

  it("counts watchlist matches and filters to only watchlist rows", () => {
    const watchlistIds = new Set(["usdc-circle", "usdt-tether"]);

    const allModel = buildYieldViewModel(prepareYieldUniverse(rows, watchlistIds), { risk: "any" });
    expect(allModel.options.watchlist.find((option) => option.value === "only")?.count).toBe(2);
    expect(allModel.visibleRows).toHaveLength(3);

    const onlyModel = buildYieldViewModel(prepareYieldUniverse(rows, watchlistIds), { risk: "any", watchlist: "only" });
    expect(onlyModel.visibleRows.map((row) => row.id)).toEqual(["usdc-circle", "usdt-tether"]);
  });

  it("filters watched rows that need attention without forcing warnings/source-changed AND semantics", () => {
    const watchlistIds = new Set(["usdc-circle", "eurc-circle", "usdt-tether"]);

    const allModel = buildYieldViewModel(prepareYieldUniverse(rows, watchlistIds), { risk: "any" });
    expect(allModel.options.attention.find((option) => option.value === "watchlist")?.count).toBe(3);

    const attentionModel = buildYieldViewModel(prepareYieldUniverse(rows, watchlistIds), { risk: "any", attention: "watchlist" });
    expect(attentionModel.visibleRows.map((row) => row.id)).toEqual([
      "usdc-circle",
      "eurc-circle",
      "usdt-tether",
    ]);
    expect(attentionModel.comparisonLabel).toBe("Watched rows needing attention");

    const warningAndChangedOnly = buildYieldViewModel(prepareYieldUniverse(rows, watchlistIds), {
      risk: "any",
      watchlist: "only",
      warnings: "only",
      sourceChanged: "only",
    });
    expect(warningAndChangedOnly.visibleRows.map((row) => row.id)).toEqual([]);
  });

  it("normalizes invalid watchlist URL params back to default", () => {
    const model = buildYieldViewModel(prepareYieldUniverse(rows, null), { watchlist: "bogus" });

    expect(model.filters.watchlist).toBe("all");
    expect(model.invalidParamKeys).toContain("watchlist");
  });

  it("yields empty visible rows when watchlist=only and no ids are provided", () => {
    const model = buildYieldViewModel(prepareYieldUniverse(rows, null), { watchlist: "only" });

    expect(model.visibleRows).toEqual([]);
  });

  it("matches each risk-budget stop's filter overrides to its matching key", () => {
    // Empty URL lands on the opportunistic band, risk=any is the neutral
    // band, and an explicit key stacked on the landing band matches no stop.
    const landing = buildYieldViewModel(prepareYieldUniverse(rows, null), {});
    expect(landing.riskBudget.matching).toBe("opportunistic");

    const any = buildYieldViewModel(prepareYieldUniverse(rows, null), { risk: "any" });
    expect(any.riskBudget.matching).toBe("all");

    const conservative = buildYieldViewModel(prepareYieldUniverse(rows, null), { risk: "conservative" });
    expect(conservative.riskBudget.matching).toBe("conservative");

    const balanced = buildYieldViewModel(prepareYieldUniverse(rows, null), { risk: "balanced" });
    expect(balanced.riskBudget.matching).toBe("balanced");

    const stacked = buildYieldViewModel(prepareYieldUniverse(rows, null), { minSafety: "80" });
    expect(stacked.riskBudget.matching).toBeNull();

    const stops = any.riskBudget.stops.map((stop) => stop.key);
    expect(stops).toEqual(["conservative", "balanced", "opportunistic", "all"]);
    expect(any.riskBudget.stops.every((stop) => stop.count >= 0)).toBe(true);
  });

  it("returns null matchingRiskBudget when filters don't match any stop", () => {
    const model = buildYieldViewModel(prepareYieldUniverse(rows, null), { minSafety: "65" });
    expect(model.riskBudget.matching).toBeNull();
    expect(model.riskBudget.stops.every((stop) => stop.active === false)).toBe(true);
  });

  it("does not treat operational advisories as warnings for the warnings filter or watchlist attention", () => {
    const advisoryRows = [
      makeYieldRanking({ id: "advisory", symbol: "ADV", safetyScore: 90, warningSignals: ["aging", "data-stale", "benchmark-degraded"] }),
      makeYieldRanking({ id: "real", symbol: "REL", safetyScore: 90, warningSignals: ["aging", "yield-spike"] }),
    ];
    const only = buildYieldViewModel(prepareYieldUniverse(advisoryRows, null), { risk: "any", warnings: "only" });
    expect(only.visibleRows.map((row) => row.id)).toEqual(["real"]);
    const hidden = buildYieldViewModel(prepareYieldUniverse(advisoryRows, null), { risk: "any", warnings: "hide" });
    expect(hidden.visibleRows.map((row) => row.id)).toEqual(["advisory"]);
    expect(hidden.visibleRows[0].warningSignals).toEqual(["aging", "data-stale", "benchmark-degraded"]);
  });

  it("applies the opportunistic landing band only when the URL omits risk", () => {
    const bandRows = [
      makeYieldRanking({ id: "low-safety", symbol: "LOW", safetyScore: 40, warningSignals: [] }),
      makeYieldRanking({ id: "warned", symbol: "WRN", safetyScore: 90, warningSignals: ["yield-spike"] }),
    ];

    const landing = buildYieldViewModel(prepareYieldUniverse(bandRows, null), {});
    expect(landing.visibleRows.map((row) => row.id)).toEqual([]);

    const neutral = buildYieldViewModel(prepareYieldUniverse(bandRows, null), { risk: "any" });
    expect(neutral.visibleRows.map((row) => row.id).sort()).toEqual(["low-safety", "warned"]);
  });

  it("stacks explicit risk-budget params on top of the landing band", () => {
    const stacked = buildYieldViewModel(prepareYieldUniverse(rows, null), { minSafety: "80" });

    // The band fills only the keys the URL leaves unset (warnings=hide), so
    // warning and null-safety rows stay hidden alongside the explicit floor,
    // and the implicit landing band is not echoed back into the URL state.
    expect(stacked.visibleRows.map((row) => row.id)).toEqual(["usdc-circle"]);
    expect(stacked.normalizedParams.risk).toBeNull();
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

    const model = buildYieldViewModel(prepareYieldUniverse([...cohortRows, ...smallCohort], null), {});
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
    const defaultFilterKeys = Object.keys(buildYieldViewModel(prepareYieldUniverse([], null), {}).filters).sort();
    const registryKeys = YIELD_FILTER_AXIS_REGISTRY.map((axis) => axis.key as string).sort();

    expect(registryKeys).toEqual(defaultFilterKeys);
    expect(YIELD_FILTER_AXIS_REGISTRY.length).toBe(defaultFilterKeys.length);
    expect(new Set(registryKeys).size).toBe(registryKeys.length);
    expect(
      YIELD_FILTER_AXIS_REGISTRY.every((axis) => typeof (axis as { matches?: unknown }).matches === "function"),
    ).toBe(true);
  });

  it.each([
    { name: "landing band", params: {} },
    { name: "non-USD research filter", params: { peg: "non-usd" } },
    { name: "USD search with custom risk axes", params: {
      risk: "any", peg: "USD", q: "US", sourceConfidence: "deterministic",
      depth: "hide-thin", minSafety: "80", sourcePosture: "clean", warnings: "only",
    } },
  ] satisfies Array<{ name: string; params: YieldViewModelUrlParams }>)(
    "counts every risk-budget stop after replacing risk axes from $name",
    ({ params }) => {
      const universe = prepareYieldUniverse(rows, null);
      const before = buildYieldViewModel(universe, params);
      for (const stop of before.riskBudget.stops) {
        // Mirror the URL replacement applied by the slider's click handler.
        const target = { ...params } as YieldViewModelUrlParams;
        for (const key of RISK_BUDGET_FILTER_KEYS) delete target[key];
        if (stop.key === YIELD_LANDING_RISK_BUDGET) delete target.risk;
        else target.risk = riskBudgetUrlValue(stop.key);
        const after = buildYieldViewModel(universe, target);
        expect(stop.count, stop.key).toBe(after.visibleRows.length);
        expect(after.filters.peg).toBe(before.filters.peg);
        expect(after.filters.q).toBe(before.filters.q);
      }
      const allCount = before.riskBudget.stops.find((stop) => stop.key === "all")?.count;
      expect(allCount).toBe(params.peg === "non-usd" ? 1 : 2 + (params.peg ? 0 : 1));
    },
  );

  it("round-trips explicit risk-band params instead of flagging them", () => {
    const opportunistic = buildYieldViewModel(prepareYieldUniverse(rows, null), { risk: "opportunistic" });
    expect(opportunistic.invalidParamKeys).not.toContain("risk");
    expect(opportunistic.normalizedParams.risk).toBe("opportunistic");
    expect(opportunistic.filters).toMatchObject({ minSafety: 50, warnings: "hide" });

    const all = buildYieldViewModel(prepareYieldUniverse(rows, null), { risk: "all" });
    expect(all.invalidParamKeys).not.toContain("risk");
    expect(all.normalizedParams.risk).toBe("any");
    expect(all.filters).toMatchObject({ minSafety: null, warnings: "all" });

    const any = buildYieldViewModel(prepareYieldUniverse(rows, null), { risk: "any" });
    expect(any.invalidParamKeys).not.toContain("risk");

    const unknown = buildYieldViewModel(prepareYieldUniverse(rows, null), { risk: "yolo" });
    expect(unknown.invalidParamKeys).toContain("risk");
    expect(unknown.normalizedParams.risk).toBeNull();
  });

  it("assigns viewRank from published order, not input array order", () => {
    const rankedRows = [
      makeYieldRanking({ id: "bronze", symbol: "BRZ", liveRank: 3, publishedRank: 3 }),
      makeYieldRanking({ id: "gold", symbol: "GLD", liveRank: 1, publishedRank: 2 }),
      makeYieldRanking({ id: "unranked", symbol: "UNR", liveRank: null, publishedRank: null, pharosYieldScore: 5 }),
      makeYieldRanking({ id: "silver", symbol: "SLV", liveRank: null, publishedRank: 2 }),
    ];
    const model = buildYieldViewModel(prepareYieldUniverse(rankedRows, null), { risk: "any" });

    expect(model.visibleRows.map((row) => [row.id, row.viewRank])).toEqual([
      ["gold", 1],
      ["silver", 2],
      ["bronze", 3],
      ["unranked", 4],
    ]);
  });
});
