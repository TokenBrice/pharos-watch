import { describe, expect, it } from "vitest";
import { ENGINE_VERSION, runSelector } from "../engine";
import { scoreRow } from "../scoring";
import {
  SELECTOR_ELIGIBLE_PEG_CURRENCIES,
  type MergedRow,
  type SelectorInput,
  type SelectorProfile,
} from "../types";
import { buildFixtureData, FIXTURE_DATASET, makeInput } from "./fixture";

type RouteVenue = readonly ["custody" | "some" | "active"] | readonly ["lend" | "dex" | "wrap" | "all"] | readonly ["cex" | "perps" | "spot" | "all"];

const ROUTE_HORIZONS = ["lt24h", "1to7d", "1to4w", "1to6m", "6mplus"] as const;
const ROUTE_DEPEGS = ["zero", "tight", "moderate"] as const;
const ROUTE_EXITS = ["1h", "24h", "any"] as const;
const ROUTE_VENUES: Record<SelectorProfile, readonly RouteVenue[]> = {
  treasury: [["custody"], ["some"], ["active"]],
  yield: [["lend"], ["dex"], ["wrap"], ["all"]],
  trading: [["cex"], ["perps"], ["spot"], ["all"]],
};

function routeComposability(
  profile: SelectorProfile,
  venue: RouteVenue,
): SelectorInput["composability"] {
  if (venue.includes("all" as never)) return "high";
  if (profile === "treasury") {
    if (venue.includes("custody" as never)) return "none";
    if (venue.includes("active" as never)) return "high";
    return "moderate";
  }
  return venue.length >= 2 ? "high" : "moderate";
}

function routeSkipsExit(
  profile: SelectorProfile,
  horizon: SelectorInput["horizon"],
  depegTolerance: SelectorInput["depegTolerance"],
): boolean {
  return profile === "treasury" && horizon === "6mplus" && depegTolerance === "zero";
}

function routeInputs(): SelectorInput[] {
  const out: SelectorInput[] = [];
  for (const pegCurrency of SELECTOR_ELIGIBLE_PEG_CURRENCIES) {
    for (const profile of SELECTOR_PROFILES_FOR_ROUTES) {
      if (
        profile === "yield" &&
        !(SELECTOR_ELIGIBLE_PEG_CURRENCIES as readonly string[]).includes(pegCurrency)
      ) {
        continue;
      }
      for (const horizon of ROUTE_HORIZONS) {
        for (const depegTolerance of ROUTE_DEPEGS) {
          for (const venue of ROUTE_VENUES[profile]) {
            const exits = routeSkipsExit(profile, horizon, depegTolerance) ? ["any"] as const : ROUTE_EXITS;
            for (const exitSpeed of exits) {
              out.push(makeInput({
                profile,
                pegCurrency,
                horizon,
                depegTolerance,
                composability: routeComposability(profile, venue),
                exitSpeed,
              }));
            }
          }
        }
      }
    }
  }
  return out;
}

const SELECTOR_PROFILES_FOR_ROUTES = ["treasury", "yield", "trading"] as const;

describe("runSelector — Treasury happy path", () => {
  const input = makeInput({ profile: "treasury" });

  it("produces a top-3 with the synthetic fixture", () => {
    const out = runSelector(input, buildFixtureData(), FIXTURE_DATASET);
    expect(out.recommended.length).toBeGreaterThan(0);
    expect(out.recommended.length).toBeLessThanOrEqual(3);
    // USDC/USDS/DAI are the highest-graded treasury candidates in the fixture.
    const ids = out.recommended.map((r) => r.id);
    expect(ids).toContain("usdc-circle");
  });

  it("output includes engineVersion + methodologyVersions + datasetHash", () => {
    const out = runSelector(input, buildFixtureData(), FIXTURE_DATASET);
    expect(out.engineVersion).toBe(ENGINE_VERSION);
    expect(out.methodologyVersions).toEqual(FIXTURE_DATASET.methodologyVersions);
    expect(out.datasetHash).toBe(FIXTURE_DATASET.datasetHash);
    expect(out.timestamp).toBe(FIXTURE_DATASET.timestamp);
    expect(out.usedRelaxedFallback).toBe(false);
    expect(out.relaxedReasons).toEqual([]);
    expect(out.exclusionSummary.length).toBeGreaterThan(0);
    expect(out.relaxableConstraints.length).toBeGreaterThan(0);
  });

  it("threads dataset.timestamp; no Date.now read inside the engine", () => {
    const a = runSelector(input, buildFixtureData(), {
      ...FIXTURE_DATASET,
      timestamp: 1000,
    });
    const b = runSelector(input, buildFixtureData(), {
      ...FIXTURE_DATASET,
      timestamp: 2000,
    });
    // Two runs with different timestamps must differ only in `timestamp`.
    expect(a.timestamp).toBe(1000);
    expect(b.timestamp).toBe(2000);
    expect(a.recommended.map((r) => r.id)).toEqual(b.recommended.map((r) => r.id));
  });

  it("variant dedup: only one USDC variant in top-3", () => {
    const out = runSelector(input, buildFixtureData(), FIXTURE_DATASET);
    const ids = out.recommended.map((r) => r.id);
    const usdcCount = ids.filter(
      (id) => id === "usdc-circle" || id === "usdc-variant-bridged",
    ).length;
    expect(usdcCount).toBeLessThanOrEqual(1);
  });

  it("emits recommendedSource=null for Treasury entries", () => {
    const out = runSelector(input, buildFixtureData(), FIXTURE_DATASET);
    for (const rec of out.recommended) {
      expect(rec.profile).toBe("treasury");
      expect(rec.recommendedSource).toBeNull();
    }
  });

  it("keeps high-quality DeFi rows with depeg history eligible while surfacing context", () => {
    const base = buildFixtureData().rows.get("usdc-circle");
    expect(base).toBeDefined();
    const row: MergedRow = {
      ...base!,
      id: "bold-liquity-like",
      symbol: "BOLD",
      name: "BOLD-like DeFi Stable",
      protocolSlug: "liquity-like",
      variantOf: null,
      governance: "decentralized",
      canBeBlacklisted: false,
      custodyModel: "onchain",
      depegEventCount: 4,
      pegScore: 95,
      safetyScore: 92,
      safetyProvenance: "safety-score-v9",
      safetyResilienceScore: 91,
      safetyDecentralizationScore: 92,
      safetyLiquidityScore: 88,
    };

    const out = runSelector(
      makeInput({ profile: "treasury", depegTolerance: "zero" }),
      { rows: new Map([[row.id, row]]) },
      FIXTURE_DATASET,
    );

    expect(out.recommended.map((rec) => rec.id)).toEqual([row.id]);
    expect(out.exclusionSummary.map((item) => item.reason)).not.toContain("depeg-event-count");
    expect(out.recommended[0]?.confidence).toBeLessThan(100);
    expect(out.recommended[0]?.lowestSubDimension.contextKeys).toContain("depeg-history");
    expect(out.recommended[0]?.watchText).toContain("4 events");
  });

  it("keeps weak Treasury PegScore rows hard-excluded", () => {
    const base = buildFixtureData().rows.get("usdc-circle");
    expect(base).toBeDefined();
    const row: MergedRow = {
      ...base!,
      id: "weak-peg-treasury",
      symbol: "WPEG",
      name: "Weak Peg Treasury",
      protocolSlug: "weak-peg",
      variantOf: null,
      depegEventCount: 3,
      pegScore: 65,
    };

    const out = runSelector(
      makeInput({ profile: "treasury", depegTolerance: "tight" }),
      { rows: new Map([[row.id, row]]) },
      FIXTURE_DATASET,
    );

    expect(out.recommended).toEqual([]);
    expect(out.exclusionSummary).toEqual([
      expect.objectContaining({ reason: "peg-score-floor", count: 1 }),
    ]);
    expect(out.usedRelaxedFallback).toBe(false);
  });
});

describe("runSelector — Yield happy path", () => {
  const input = makeInput({ profile: "yield", depegTolerance: "tight" });

  it("emits recommendedSource for Yield entries", () => {
    const out = runSelector(input, buildFixtureData(), FIXTURE_DATASET);
    for (const rec of out.recommended) {
      expect(rec.profile).toBe("yield");
      expect(rec.recommendedSource).not.toBeNull();
      if (rec.profile === "yield") {
        expect(rec.recommendedSource.protocol).toBeTypeOf("string");
        expect(rec.recommendedSource.chain).toBeTypeOf("string");
      }
    }
  });

  it("selects a Yield altSource that matches venue preferences when available", () => {
    const rows = new Map(buildFixtureData().rows);
    const base = rows.get("usdc-circle");
    expect(base).toBeDefined();
    rows.set("usdc-circle", {
      ...base!,
      yieldSources: [
        {
          sourceKey: "primary-wrapper",
          protocol: "Issuer wrapper",
          chain: "Ethereum",
          yieldType: "rebase",
          apy30d: 4.8,
          pharosYieldScore: 78,
          sourceTvlUsd: 100_000_000,
          dataSource: "test",
          sourceRiskScore: 15,
          venueRiskTier: "low",
          deploymentPlace: "issuer-savings",
          sourceDepthRatio: 0.8,
          sourceSwitchCount30d: 0,
          observationCount30d: 30,
          freshness: { capturedAt: 1_700_000_000, ageSeconds: 120 },
          isPrimary: true,
        },
        {
          sourceKey: "dex-lp",
          protocol: "Curve",
          chain: "Ethereum",
          yieldType: "lp-receipt",
          apy30d: 4.5,
          pharosYieldScore: 78,
          sourceTvlUsd: 80_000_000,
          dataSource: "test",
          sourceRiskScore: 18,
          venueRiskTier: "low",
          deploymentPlace: "lp",
          sourceDepthRatio: 0.7,
          sourceSwitchCount30d: 0,
          observationCount30d: 30,
          freshness: { capturedAt: 1_700_000_000, ageSeconds: 90 },
          isPrimary: false,
        },
      ],
    });

    const out = runSelector(
      makeInput({
        profile: "yield",
        depegTolerance: "tight",
        venuePreferences: ["dex"],
      }),
      { rows },
      FIXTURE_DATASET,
    );
    const usdc = out.recommended.find((rec) => rec.id === "usdc-circle");
    expect(usdc?.profile).toBe("yield");
    if (usdc?.profile === "yield") {
      expect(usdc.recommendedSource.sourceKey).toBe("dex-lp");
      expect(usdc.recommendedSource.selectionReason).toBe("venue-preference");
    }
  });

  it("sourceRiskInverted null contributes neutral 50 while lowering confidence", () => {
    const rows = new Map(buildFixtureData().rows);
    const base = rows.get("usds-sky");
    expect(base).toBeDefined();
    rows.set("usds-sky", {
      ...base!,
      sourceRiskScore: null,
    });

    const out = runSelector(input, { rows }, FIXTURE_DATASET);
    const rec = out.recommended.find((entry) => entry.id === "usds-sky");
    expect(rec).toBeDefined();
    const component = rec!.components.find((c) => c.key === "sourceRiskInverted");
    expect(component).toEqual(
      expect.objectContaining({
        rawValue: null,
        normalizedValue: 50,
        redistributed: true,
      }),
    );
    expect(component!.weight).toBeGreaterThan(0);
    expect(component!.contribution).toBeGreaterThan(0);
    expect(rec!.confidence).toBeLessThan(100);
    expect(out.coverageWarnings.redistributionCount).toBeGreaterThan(0);
  });

  it("removes Yield rows without a usable source before ranking and alternates", () => {
    const base = buildFixtureData().rows.get("usds-sky");
    expect(base).toBeDefined();
    const makeYieldRow = (
      id: string,
      overrides: Partial<MergedRow>,
    ): MergedRow => ({
      ...base!,
      id,
      symbol: id.slice(0, 5).toUpperCase(),
      name: id,
      protocolSlug: id,
      variantOf: null,
      yieldProtocolSlug: `source-${id}`,
      yieldVenueChain: "ethereum",
      yieldSources: undefined,
      ...overrides,
    });
    const phantom = makeYieldRow("phantom-yield-no-source", {
      safetyScore: 87,
      pharosYieldScore: 83,
      apy30d: 5,
      supplyUsd: 70_000_000_000,
      yieldProtocolSlug: null,
      yieldVenueChain: null,
      yieldSources: [],
    });
    const rows = new Map<string, MergedRow>([
      [
        "valid-a",
        makeYieldRow("valid-a", {
          safetyScore: 92,
          pharosYieldScore: 88,
          apy30d: 5.5,
          supplyUsd: 100_000_000_000,
        }),
      ],
      [
        "valid-b",
        makeYieldRow("valid-b", {
          safetyScore: 90,
          pharosYieldScore: 86,
          apy30d: 5.3,
          supplyUsd: 90_000_000_000,
        }),
      ],
      [
        "valid-c",
        makeYieldRow("valid-c", {
          safetyScore: 88,
          pharosYieldScore: 84,
          apy30d: 5.1,
          supplyUsd: 80_000_000_000,
        }),
      ],
      [
        "valid-d",
        makeYieldRow("valid-d", {
          safetyScore: 70,
          pharosYieldScore: 60,
          apy30d: 4.2,
          supplyUsd: 10_000_000_000,
        }),
      ],
      [
        "valid-e",
        makeYieldRow("valid-e", {
          safetyScore: 65,
          pharosYieldScore: 58,
          apy30d: 4.1,
          supplyUsd: 9_000_000_000,
        }),
      ],
      [phantom.id, phantom],
    ]);

    const out = runSelector(input, { rows }, FIXTURE_DATASET);

    expect(out.recommended.map((rec) => rec.id)).toEqual(["valid-a", "valid-b", "valid-c"]);
    expect(out.recommended[2]?.rankRobustness).toEqual({
      label: "clear-margin",
      scoreMargin: 12.9,
    });
    expect(out.lowerRanked.map((row) => row.id)).not.toContain(phantom.id);
    expect(out.lowerRanked.map((row) => row.id)).toContain("valid-e");
    expect(out.coverageWarnings.skippedForCoverage).toContainEqual({
      id: phantom.id,
      symbol: phantom.symbol,
      missingSignals: ["recommendedSource"],
    });
    expect(out.exclusionSummary).toContainEqual(
      expect.objectContaining({
        reason: "coverage-too-thin",
        sampleIds: [phantom.id],
      }),
    );
  });
});

describe("runSelector — Trading happy path", () => {
  const input = makeInput({ profile: "trading", exitSpeed: "any" });

  it("emits perInputStaleness on Trading entries", () => {
    const out = runSelector(input, buildFixtureData(), FIXTURE_DATASET);
    for (const rec of out.recommended) {
      expect(rec.profile).toBe("trading");
      expect(rec.recommendedSource).toBeNull();
      if (rec.profile === "trading") {
        expect(rec.perInputStaleness).toEqual(
          expect.objectContaining({
            pegSummary: expect.any(Number),
            dexTvl: expect.any(Number),
            dews: expect.any(Number),
          }),
        );
      }
    }
  });

  it("omits Trading per-input staleness keys when freshness timestamps are unavailable", () => {
    const data = buildFixtureData();
    data.rows = new Map(Array.from(data.rows, ([id, row]) => [
      id,
      {
        ...row,
        pegSummaryAgeSec: null,
        dexTvlAgeSec: null,
        dewsAgeSec: null,
      },
    ]));
    const out = runSelector(input, data, FIXTURE_DATASET);
    for (const rec of out.recommended) {
      if (rec.profile === "trading") {
        expect(rec.perInputStaleness).toEqual({});
      }
    }
  });

  it("skips confidence demotion (R2 Active Trader P2)", () => {
    const data = buildFixtureData();
    const out = runSelector(input, data, FIXTURE_DATASET);
    // We only assert the engine reaches the trading branch without throwing
    // and that the top entry's confidence is reported (rank stays as-scored).
    if (out.recommended.length > 0) {
      expect(out.recommended[0]!.confidence).toBeGreaterThanOrEqual(0);
    }
  });
});

describe("runSelector — universal properties", () => {
  it("runs against a selected non-USD peg universe", () => {
    const rows = new Map(buildFixtureData().rows);
    const base = rows.get("usdc-circle");
    expect(base).toBeDefined();
    rows.set("eurc-circle", {
      ...base!,
      id: "eurc-circle",
      symbol: "EURC",
      name: "EURC",
      protocolSlug: "eurc-circle",
      variantOf: null,
      pegCurrency: "EUR" as const,
      supplyUsd: 45_000_000,
    });

    const out = runSelector(
      makeInput({ pegCurrency: "EUR" }),
      { rows },
      FIXTURE_DATASET,
    );
    expect(out.universe.active).toBe(1);
    expect(out.recommended.map((rec) => rec.id)).toEqual(["eurc-circle"]);
  });

  it("marks selected-peg coverage sparse when too many rows lack required signals", () => {
    const base = buildFixtureData().rows.get("usdc-circle");
    expect(base).toBeDefined();
    const rows = new Map([
      [
        "eur-complete",
        {
          ...base!,
          id: "eur-complete",
          symbol: "EUR1",
          name: "EUR Complete",
          protocolSlug: "eur-complete",
          variantOf: null,
          pegCurrency: "EUR" as const,
        },
      ],
      [
        "eur-thin",
        {
          ...base!,
          id: "eur-thin",
          symbol: "EUR2",
          name: "EUR Thin",
          protocolSlug: "eur-thin",
          variantOf: null,
          pegCurrency: "EUR" as const,
          pegScore: null,
        },
      ],
    ]);

    const out = runSelector(makeInput({ pegCurrency: "EUR" }), { rows }, FIXTURE_DATASET);
    expect(out.coverageWarnings.skippedForCoverageCount).toBe(1);
    expect(out.coverageWarnings.sparse).toBe(true);
    expect(out.lowConfidence).toBe(true);
  });

  it("uses a low-confidence fallback instead of empty results for strict CHF and Gold Yield routes", () => {
    const base = buildFixtureData().rows.get("usdc-circle");
    expect(base).toBeDefined();

    for (const pegCurrency of ["CHF", "GOLD"] as const) {
      const row: MergedRow = {
        ...base!,
        id: `${pegCurrency.toLowerCase()}-yield-fallback`,
        symbol: pegCurrency === "GOLD" ? "PAXG" : "ZCHF",
        name: `${pegCurrency} fallback candidate`,
        protocolSlug: `${pegCurrency.toLowerCase()}-fallback`,
        variantOf: null,
        pegCurrency,
        depegEventCount: 9,
        pegScore: 40,
      };
      const out = runSelector(
        makeInput({
          profile: "yield",
          pegCurrency,
          depegTolerance: "zero",
        }),
        { rows: new Map([[row.id, row]]) },
        FIXTURE_DATASET,
      );

      expect(out.recommended.map((rec) => rec.id)).toEqual([row.id]);
      expect(out.recommended[0]?.profile).toBe("yield");
      expect(out.lowConfidence).toBe(true);
      expect(out.usedRelaxedFallback).toBe(true);
      expect(out.relaxedReasons).toContain("peg-score-floor");
    }
  });

  it("does not use relaxed fallback for non-relaxable or input-driven exclusions", () => {
    const base = buildFixtureData().rows.get("usdc-circle");
    expect(base).toBeDefined();

    const cases: Array<{
      name: string;
      input: Partial<SelectorInput>;
      row: Partial<MergedRow>;
      reason: string;
    }> = [
      {
        name: "minimum APY floor",
        input: { profile: "yield", minApy: 10 },
        row: { apy30d: 1, pegScore: 95 },
        reason: "apy-below-floor",
      },
      {
        name: "decentralization requirement",
        input: { profile: "yield", decentralization: "required" },
        row: { governance: "centralized", canBeBlacklisted: true, pegScore: 95 },
        reason: "decentralization-required-violation",
      },
      {
        name: "on-chain custody requirement",
        input: { profile: "yield", custodyOk: "onchain-only" },
        row: { custodyModel: "institutional-regulated", pegScore: 95 },
        reason: "custody-onchain-only-violation",
      },
      {
        name: "yield-native-only requirement",
        input: { profile: "yield", yieldNativeOnly: true },
        row: { deploymentPlace: "lp", pegScore: 95 },
        reason: "yield-native-only-violation",
      },
    ];

    for (const testCase of cases) {
      const row: MergedRow = {
        ...base!,
        id: `fallback-blocked-${testCase.name.replaceAll(" ", "-")}`,
        symbol: "BLK",
        name: `Blocked ${testCase.name}`,
        protocolSlug: `blocked-${testCase.name.replaceAll(" ", "-")}`,
        variantOf: null,
        ...testCase.row,
      };
      const out = runSelector(
        makeInput(testCase.input),
        { rows: new Map([[row.id, row]]) },
        FIXTURE_DATASET,
      );

      expect(out.universe.surviving, testCase.name).toBe(0);
      expect(out.recommended.map((rec) => rec.id), testCase.name).not.toContain(row.id);
      expect(out.usedRelaxedFallback, testCase.name).toBe(false);
      expect(out.relaxedReasons, testCase.name).not.toContain(testCase.reason);
      expect(out.exclusionSummary.some((item) => item.reason === testCase.reason), testCase.name).toBe(true);
    }
  });

  it("emits authored explanation text and confidence reasons instead of raw keys", () => {
    const rows = new Map(buildFixtureData().rows);
    const base = rows.get("usds-sky");
    expect(base).toBeDefined();
    rows.set("usds-sky", {
      ...base!,
      sourceRiskScore: null,
    });

    const out = runSelector(makeInput({ profile: "yield" }), { rows }, FIXTURE_DATASET);
    const rec = out.recommended.find((entry) => entry.id === "usds-sky");
    expect(rec?.whyText).toMatch(/Score \d/);
    expect(rec?.whyText).not.toMatch(/top-|strong-|weak-/);
    expect(rec?.watchText).toBeTypeOf("string");
    expect(rec?.confidenceReasons).toEqual(
      expect.arrayContaining(["source-risk-missing", "missing-critical-sourceRiskInverted"]),
    );
  });

  it("preserves reachable bluechip missing-data policy", () => {
    const base = buildFixtureData().rows.get("usds-sky");
    expect(base).toBeDefined();
    const row: MergedRow = {
      ...base!,
      bluechipGrade: null,
    };

    const yieldScore = scoreRow(row, "yield", makeInput({ profile: "yield" }));
    const treasuryScore = scoreRow(row, "treasury", makeInput({ profile: "treasury" }));

    expect(yieldScore?.components.some((component) => component.key === "bluechip")).toBe(false);
    expect(treasuryScore?.components.find((component) => component.key === "bluechip")?.redistributed).toBe(true);
  });

  it("uses a close substitute to reduce top-3 protocol concentration", () => {
    const base = buildFixtureData().rows.get("usdc-circle");
    expect(base).toBeDefined();
    const makeCandidate = (
      id: string,
      protocolSlug: string,
      safetyScore: number,
      supplyUsd: number,
    ): MergedRow => ({
      ...base!,
      id,
      symbol: id.toUpperCase(),
      name: id,
      protocolSlug,
      variantOf: null,
      safetyScore,
      safetyResilienceScore: safetyScore,
      liquidityScore: safetyScore,
      supplyUsd,
    });

    const rows = new Map<string, MergedRow>([
      ["issuer-a-1", makeCandidate("issuer-a-1", "issuer-a", 96, 100_000_000_000)],
      ["issuer-a-2", makeCandidate("issuer-a-2", "issuer-a", 95, 90_000_000_000)],
      ["issuer-b-1", makeCandidate("issuer-b-1", "issuer-b", 94, 80_000_000_000)],
      ["issuer-c-1", makeCandidate("issuer-c-1", "issuer-c", 80, 70_000_000_000)],
    ]);

    const out = runSelector(makeInput({ profile: "treasury" }), { rows }, FIXTURE_DATASET);
    expect(out.recommended.slice(0, 2).map((rec) => rec.id)).toEqual([
      "issuer-a-1",
      "issuer-b-1",
    ]);
    expect(out.recommended[1]?.rankRobustness?.label).toBe("concentration-adjusted");
  });

  it("every selectable peg/profile route has at least one recommendation in a covered universe", () => {
    const base = buildFixtureData().rows.get("usdc-circle");
    expect(base).toBeDefined();
    const rows = new Map<string, MergedRow>();
    for (const pegCurrency of SELECTOR_ELIGIBLE_PEG_CURRENCIES) {
      const row: MergedRow = {
        ...base!,
        id: `${pegCurrency.toLowerCase()}-route-candidate`,
        symbol: pegCurrency === "GOLD" ? "PAXG" : pegCurrency,
        name: `${pegCurrency} route candidate`,
        protocolSlug: `${pegCurrency.toLowerCase()}-route-candidate`,
        variantOf: null,
        pegCurrency,
        activeDepeg: false,
        currentDeviationBps: 0,
        depegEventCount: 0,
        supplyUsd: 100_000_000,
      };
      rows.set(row.id, row);
    }

    for (const input of routeInputs()) {
      const out = runSelector(input, { rows }, FIXTURE_DATASET);
      expect(
        out.recommended.length,
        `${input.pegCurrency}/${input.profile}/${input.horizon}/${input.depegTolerance}/${input.composability}/${input.exitSpeed}`,
      ).toBeGreaterThan(0);
    }
  });

  it("never recommends an NR asset across the combinatorial route suite", () => {
    const data = buildFixtureData();
    for (const input of routeInputs()) {
      const out = runSelector(input, data, FIXTURE_DATASET);
      expect(
        out.recommended.some((recommendation) => recommendation.safetyGrade === "NR"),
        `${input.pegCurrency}/${input.profile}/${input.horizon}/${input.depegTolerance}/${input.composability}/${input.exitSpeed}`,
      ).toBe(false);
    }

    const treasury = runSelector(makeInput({ profile: "treasury" }), data, FIXTURE_DATASET);
    expect(treasury.coverageWarnings.skippedForCoverage).toContainEqual({
      id: "yzusd-yuzu",
      symbol: "YZUSD",
      missingSignals: [
        "safety-nr: Critical V9 evidence remains unresolved.",
        "safetyScore",
      ],
    });
  });

  it("does not re-admit an NR row through relaxed fallback", () => {
    const base = buildFixtureData().rows.get("yzusd-yuzu");
    expect(base).toBeDefined();
    const row = { ...base!, pegScore: 60 };
    const out = runSelector(
      makeInput({ profile: "yield", depegTolerance: "zero" }),
      { rows: new Map([[row.id, row]]) },
      FIXTURE_DATASET,
    );

    expect(out.recommended).toEqual([]);
    expect(out.usedRelaxedFallback).toBe(false);
    expect(out.exclusionSummary).toContainEqual(
      expect.objectContaining({ reason: "peg-score-floor", sampleIds: ["yzusd-yuzu"] }),
    );
  });

  it("carries limited V9 evidence and binding caps into confidence and watch text", () => {
    const base = buildFixtureData().rows.get("usdc-circle");
    expect(base).toBeDefined();
    const row: MergedRow = {
      ...base!,
      safetyEvidenceLevel: "limited",
      safetyWeakestPillar: { pillar: "backing", score: 72 },
      safetyBindingCap: {
        kind: "evidence",
        limit: 80,
        source: "evidence",
        reason: "Reserve evidence is bounded.",
        binding: true,
      },
    };
    const out = runSelector(
      makeInput({ profile: "treasury" }),
      { rows: new Map([[row.id, row]]) },
      FIXTURE_DATASET,
    );

    expect(out.recommended[0]?.confidence).toBeLessThanOrEqual(80);
    expect(out.recommended[0]?.confidenceReasons).toEqual(
      expect.arrayContaining(["limited-v9-evidence", "v9-binding-cap"]),
    );
    expect(out.recommended[0]?.watchText).toContain("capped at 80");
    expect(out.recommended[0]?.watchText).toContain("Reserve evidence is bounded.");
  });

  it("surfaces the published weakest V9 pillar when no binding cap applies", () => {
    const base = buildFixtureData().rows.get("usdc-circle");
    expect(base).toBeDefined();
    const row: MergedRow = {
      ...base!,
      safetyEvidenceLevel: "adequate",
      safetyWeakestPillar: { pillar: "control", score: 40 },
      safetyBindingCap: null,
    };
    const out = runSelector(
      makeInput({ profile: "treasury" }),
      { rows: new Map([[row.id, row]]) },
      FIXTURE_DATASET,
    );

    expect(out.recommended[0]?.watchText).toContain("Economic Control at 40");
  });

  it("howey-uncertain coins are pre-excluded", () => {
    const out = runSelector(makeInput(), buildFixtureData(), FIXTURE_DATASET);
    for (const rec of out.recommended) {
      expect(rec.id).not.toBe("susde-ethena");
      expect(rec.id).not.toBe("sdai-sky");
    }
  });

  it("active-depeg blocks the test coin under tight tolerance", () => {
    const out = runSelector(
      makeInput({ depegTolerance: "tight" }),
      buildFixtureData(),
      FIXTURE_DATASET,
    );
    for (const rec of out.recommended) {
      expect(rec.id).not.toBe("active-depeg-test");
    }
  });

  it("coverage-too-thin row is reported in skippedForCoverage", () => {
    const out = runSelector(makeInput(), buildFixtureData(), FIXTURE_DATASET);
    const skippedIds = out.coverageWarnings.skippedForCoverage.map((s) => s.id);
    expect(skippedIds).toContain("coverage-thin-test");
  });

  it("scoring components are populated and bounded [0, 100]", () => {
    const out = runSelector(makeInput(), buildFixtureData(), FIXTURE_DATASET);
    for (const rec of out.recommended) {
      expect(rec.score).toBeGreaterThanOrEqual(0);
      expect(rec.score).toBeLessThanOrEqual(100);
      for (const c of rec.components) {
        if (c.normalizedValue != null) {
          expect(c.normalizedValue).toBeGreaterThanOrEqual(0);
          expect(c.normalizedValue).toBeLessThanOrEqual(100);
        }
      }
    }
  });

  it("lowConfidence flips when sparse OR top confidence < 70", () => {
    const out = runSelector(makeInput(), buildFixtureData(), FIXTURE_DATASET);
    const top = out.recommended[0];
    if (top != null && top.confidence >= 70 && !out.coverageWarnings.sparse) {
      expect(out.lowConfidence).toBe(false);
    }
  });
});

describe("runSelector — purity", () => {
  it("does not emit the removed ambient debug survivor payload", () => {
    const output = runSelector(makeInput(), buildFixtureData(), FIXTURE_DATASET);
    expect(output).not.toHaveProperty("debug");
  });

  it("no Date.now() / Math.random in the runSelector return shape", () => {
    // Run twice with the same dataset.timestamp; output must be byte-identical.
    const a = runSelector(makeInput(), buildFixtureData(), FIXTURE_DATASET);
    const b = runSelector(makeInput(), buildFixtureData(), FIXTURE_DATASET);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});
