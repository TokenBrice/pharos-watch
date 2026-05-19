import { describe, expect, it } from "vitest";
import {
  HOWEY_UNCERTAIN_ASSETS,
  activeDepegThresholdBps,
  applyInputDrivenExclusions,
  evaluateExclusions,
  hasRequiredSignals,
  tradingDewsCeiling,
} from "../exclusions";
import type { MergedRow, SelectorInput } from "../types";

function makeRow(overrides: Partial<MergedRow> = {}): MergedRow {
  return {
    id: "test-coin",
    symbol: "TEST",
    name: "Test Stable",
    protocolSlug: "test",
    variantOf: null,
    isYieldBearing: false,
    pegCurrency: "USD",
    lifecycle: "active",
    governance: "decentralized",
    canBeBlacklisted: false,
    mechanismArchetype: "cdp",
    supplyUsd: 1_000_000_000,
    pegScore: 95,
    pegStabilityScore: 85,
    activeDepeg: false,
    currentDeviationBps: 10,
    depegEventCount: 0,
    lastEventAt: null,
    dewsScore: 25,
    safetyGrade: "A",
    safetyScore: 90,
    safetyResilienceScore: 80,
    safetyDependencyRiskScore: 80,
    safetyDecentralizationScore: 70,
    safetyLiquidityScore: 75,
    collateralQuality: 80,
    custodyModel: "onchain",
    bluechipGrade: "A",
    liquidityScore: 80,
    effectiveTvlUsd: 50_000_000,
    concentrationHhi: 0.3,
    chainTvl: { ethereum: 40_000_000, base: 10_000_000 },
    effectiveExitScore: 80,
    pharosYieldScore: 80,
    apy30d: 5,
    apyVariance30d: 0.5,
    benchmarkRate: 4.5,
    sourceRiskScore: 20,
    venueRiskTier: "low",
    warningSignals: [],
    deploymentPlace: "native-wrapper",
    sourceSwitch: false,
    yieldProtocolSlug: "aave-v3",
    yieldVenueChain: "ethereum",
    yieldHistoryDays: 365,
    yieldFreshness: { capturedAt: 0, ageSeconds: 60 },
    trackingSpanDays: 365,
    isRecentListing: false,
    pegSummaryAgeSec: 30,
    dexTvlAgeSec: 120,
    dewsAgeSec: 200,
    ...overrides,
  };
}

function makeInput(overrides: Partial<SelectorInput> = {}): SelectorInput {
  return {
    profile: "treasury",
    pegCurrency: "USD",
    horizon: "1to6m",
    depegTolerance: "tight",
    composability: "moderate",
    exitSpeed: "any",
    minApy: null,
    yieldNativeOnly: false,
    decentralization: "any",
    custodyOk: "any",
    ...overrides,
  };
}

describe("threshold helpers", () => {
  it("activeDepegThresholdBps scales with tolerance", () => {
    expect(activeDepegThresholdBps("zero")).toBe(50);
    expect(activeDepegThresholdBps("tight")).toBe(100);
    expect(activeDepegThresholdBps("moderate")).toBe(200);
  });

  it("tradingDewsCeiling scales with exit speed", () => {
    expect(tradingDewsCeiling("1h")).toBe(35);
    expect(tradingDewsCeiling("24h")).toBe(45);
    expect(tradingDewsCeiling("any")).toBe(55);
  });
});

describe("universal exclusions", () => {
  it("below-supply-floor: $4.5M excluded, $5.5M passes", () => {
    expect(evaluateExclusions(makeRow({ supplyUsd: 4_500_000 }), makeInput())).toEqual(
      expect.objectContaining({ reason: "below-supply-floor" }),
    );
    expect(evaluateExclusions(makeRow({ supplyUsd: 5_500_000 }), makeInput())).toBeNull();
  });

  it("active-depeg scales with depegTolerance (zero=50bps)", () => {
    const tight = makeRow({ activeDepeg: true, currentDeviationBps: 60 });
    expect(evaluateExclusions(tight, makeInput({ depegTolerance: "zero" }))).toEqual(
      expect.objectContaining({ reason: "active-depeg" }),
    );
    const within = makeRow({ activeDepeg: true, currentDeviationBps: 40 });
    expect(evaluateExclusions(within, makeInput({ depegTolerance: "zero" }))).toBeNull();
  });

  it("active-depeg uses absolute current deviation", () => {
    const offPegBelow = makeRow({ activeDepeg: true, currentDeviationBps: -60 });
    expect(evaluateExclusions(offPegBelow, makeInput({ depegTolerance: "zero" }))).toEqual(
      expect.objectContaining({ reason: "active-depeg" }),
    );
  });

  it("active-depeg scales with depegTolerance (tight=100bps)", () => {
    const over = makeRow({ activeDepeg: true, currentDeviationBps: 110 });
    expect(evaluateExclusions(over, makeInput({ depegTolerance: "tight" }))).toEqual(
      expect.objectContaining({ reason: "active-depeg" }),
    );
    const under = makeRow({ activeDepeg: true, currentDeviationBps: 90 });
    expect(evaluateExclusions(under, makeInput({ depegTolerance: "tight" }))).toBeNull();
  });

  it("active-depeg scales with depegTolerance (moderate=200bps)", () => {
    const over = makeRow({ activeDepeg: true, currentDeviationBps: 210 });
    expect(evaluateExclusions(over, makeInput({ depegTolerance: "moderate" }))).toEqual(
      expect.objectContaining({ reason: "active-depeg" }),
    );
    const under = makeRow({ activeDepeg: true, currentDeviationBps: 190 });
    expect(evaluateExclusions(under, makeInput({ depegTolerance: "moderate" }))).toBeNull();
  });

  it("F grade always excluded", () => {
    expect(evaluateExclusions(makeRow({ safetyGrade: "F" }), makeInput())).toEqual(
      expect.objectContaining({ reason: "safety-grade-floor" }),
    );
  });

  it("howey-uncertain pre-exclusion list", () => {
    expect(HOWEY_UNCERTAIN_ASSETS.has("susde-ethena")).toBe(true);
    expect(HOWEY_UNCERTAIN_ASSETS.has("usdc-circle")).toBe(false);
    expect(
      evaluateExclusions(makeRow({ id: "susde-ethena" }), makeInput()),
    ).toEqual(expect.objectContaining({ reason: "howey-uncertain" }));
  });
});

describe("treasury exclusions", () => {
  const input = makeInput({ profile: "treasury" });

  it("safety-grade-floor: C excluded, C+ passes", () => {
    expect(evaluateExclusions(makeRow({ safetyGrade: "C" }), input)).toEqual(
      expect.objectContaining({ reason: "safety-grade-floor" }),
    );
    expect(evaluateExclusions(makeRow({ safetyGrade: "C+" }), input)).toBeNull();
  });

  it("safety-resilience-floor: 49 excluded, 51 passes", () => {
    expect(
      evaluateExclusions(makeRow({ safetyResilienceScore: 49 }), input),
    ).toEqual(expect.objectContaining({ reason: "safety-resilience-floor" }));
    expect(
      evaluateExclusions(makeRow({ safetyResilienceScore: 51 }), input),
    ).toBeNull();
  });

  it("dews-ceiling: 65 excluded, 55 passes", () => {
    expect(evaluateExclusions(makeRow({ dewsScore: 65 }), input)).toEqual(
      expect.objectContaining({ reason: "dews-ceiling" }),
    );
    expect(evaluateExclusions(makeRow({ dewsScore: 55 }), input)).toBeNull();
  });

  it("depeg-event-count: 2 excluded", () => {
    expect(evaluateExclusions(makeRow({ depegEventCount: 2 }), input)).toEqual(
      expect.objectContaining({ reason: "depeg-event-count" }),
    );
  });

  it("bluechip-d-or-f: D excluded, null passes", () => {
    expect(evaluateExclusions(makeRow({ bluechipGrade: "D" }), input)).toEqual(
      expect.objectContaining({ reason: "bluechip-d-or-f" }),
    );
    expect(evaluateExclusions(makeRow({ bluechipGrade: null }), input)).toBeNull();
  });
});

describe("yield exclusions", () => {
  const input = makeInput({ profile: "yield" });

  it("yield grade floor: D excluded, C- passes", () => {
    expect(evaluateExclusions(makeRow({ safetyGrade: "D" }), input)).toEqual(
      expect.objectContaining({ reason: "safety-grade-floor" }),
    );
    expect(evaluateExclusions(makeRow({ safetyGrade: "C-" }), input)).toBeNull();
  });

  it("pys-null excluded", () => {
    expect(
      evaluateExclusions(makeRow({ pharosYieldScore: null }), input),
    ).toEqual(expect.objectContaining({ reason: "pys-null" }));
  });

  it("apy-below-floor: benchmark*0.75 floor", () => {
    // benchmark 4.5 → floor = 3.375
    expect(
      evaluateExclusions(makeRow({ apy30d: 3.0, benchmarkRate: 4.5 }), input),
    ).toEqual(expect.objectContaining({ reason: "apy-below-floor" }));
    expect(
      evaluateExclusions(makeRow({ apy30d: 4.0, benchmarkRate: 4.5 }), input),
    ).toBeNull();
  });

  it("yield-warning-unstable", () => {
    expect(
      evaluateExclusions(makeRow({ warningSignals: ["unstable-apy"] }), input),
    ).toEqual(expect.objectContaining({ reason: "yield-warning-unstable" }));
  });

  it("yield-warning-thin-tvl", () => {
    expect(
      evaluateExclusions(makeRow({ warningSignals: ["thin-tvl"] }), input),
    ).toEqual(expect.objectContaining({ reason: "yield-warning-thin-tvl" }));
  });

  it("high-venue-on-c-tier: high venue + C- excluded; high + B passes", () => {
    expect(
      evaluateExclusions(
        makeRow({ venueRiskTier: "high", safetyGrade: "C" }),
        input,
      ),
    ).toEqual(expect.objectContaining({ reason: "high-venue-on-c-tier" }));
    expect(
      evaluateExclusions(
        makeRow({ venueRiskTier: "high", safetyGrade: "B" }),
        input,
      ),
    ).toBeNull();
  });

  it("peg-stability-floor scales with depegTolerance (zero=65)", () => {
    const zero = makeInput({ profile: "yield", depegTolerance: "zero" });
    expect(evaluateExclusions(makeRow({ pegStabilityScore: 60 }), zero)).toEqual(
      expect.objectContaining({ reason: "peg-stability-floor" }),
    );
    expect(evaluateExclusions(makeRow({ pegStabilityScore: 70 }), zero)).toBeNull();
  });

  it("peg-stability-floor scales with depegTolerance (tight=55)", () => {
    const tight = makeInput({ profile: "yield", depegTolerance: "tight" });
    expect(evaluateExclusions(makeRow({ pegStabilityScore: 50 }), tight)).toEqual(
      expect.objectContaining({ reason: "peg-stability-floor" }),
    );
    expect(evaluateExclusions(makeRow({ pegStabilityScore: 60 }), tight)).toBeNull();
  });

  it("peg-stability-floor scales with depegTolerance (moderate=45)", () => {
    const moderate = makeInput({ profile: "yield", depegTolerance: "moderate" });
    expect(evaluateExclusions(makeRow({ pegStabilityScore: 40 }), moderate)).toEqual(
      expect.objectContaining({ reason: "peg-stability-floor" }),
    );
    expect(evaluateExclusions(makeRow({ pegStabilityScore: 50 }), moderate)).toBeNull();
  });
});

describe("trading exclusions", () => {
  const input = makeInput({ profile: "trading", exitSpeed: "any" });

  it("liquidity-floor: 45 excluded, 55 passes", () => {
    expect(evaluateExclusions(makeRow({ liquidityScore: 45 }), input)).toEqual(
      expect.objectContaining({ reason: "liquidity-floor" }),
    );
    expect(evaluateExclusions(makeRow({ liquidityScore: 55 }), input)).toBeNull();
  });

  it("peg-stability-floor (trading): 70 excluded, 80 passes", () => {
    expect(evaluateExclusions(makeRow({ pegStabilityScore: 70 }), input)).toEqual(
      expect.objectContaining({ reason: "peg-stability-floor" }),
    );
    expect(evaluateExclusions(makeRow({ pegStabilityScore: 80 }), input)).toBeNull();
  });

  it("dews-ceiling × 1h: 36 excluded, 30 passes", () => {
    const fast = makeInput({ profile: "trading", exitSpeed: "1h" });
    expect(
      evaluateExclusions(makeRow({ dewsScore: 36, effectiveTvlUsd: 50_000_000, liquidityScore: 70 }), fast),
    ).toEqual(expect.objectContaining({ reason: "dews-ceiling" }));
    expect(
      evaluateExclusions(makeRow({ dewsScore: 30, effectiveTvlUsd: 50_000_000, liquidityScore: 70 }), fast),
    ).toBeNull();
  });

  it("dews-ceiling × 24h: 46 excluded, 40 passes", () => {
    const day = makeInput({ profile: "trading", exitSpeed: "24h" });
    expect(evaluateExclusions(makeRow({ dewsScore: 46 }), day)).toEqual(
      expect.objectContaining({ reason: "dews-ceiling" }),
    );
    expect(evaluateExclusions(makeRow({ dewsScore: 40 }), day)).toBeNull();
  });

  it("dews-ceiling × any: 56 excluded, 50 passes", () => {
    expect(evaluateExclusions(makeRow({ dewsScore: 56 }), input)).toEqual(
      expect.objectContaining({ reason: "dews-ceiling" }),
    );
    expect(evaluateExclusions(makeRow({ dewsScore: 50 }), input)).toBeNull();
  });

  it("supply-tvl-floor-1h: <$25M effective TVL excluded under 1h", () => {
    const fast = makeInput({ profile: "trading", exitSpeed: "1h" });
    expect(
      evaluateExclusions(
        makeRow({ effectiveTvlUsd: 20_000_000, liquidityScore: 70 }),
        fast,
      ),
    ).toEqual(expect.objectContaining({ reason: "supply-tvl-floor-1h" }));
    expect(
      evaluateExclusions(
        makeRow({ effectiveTvlUsd: 30_000_000, liquidityScore: 70 }),
        fast,
      ),
    ).toBeNull();
  });

  it("effective-exit-floor under 24h: 45 excluded, 55 passes", () => {
    const day = makeInput({ profile: "trading", exitSpeed: "24h" });
    expect(
      evaluateExclusions(makeRow({ effectiveExitScore: 45 }), day),
    ).toEqual(expect.objectContaining({ reason: "effective-exit-floor" }));
    expect(
      evaluateExclusions(makeRow({ effectiveExitScore: 55 }), day),
    ).toBeNull();
  });
});

describe("input-driven exclusions", () => {
  it("decentralization=required + canBeBlacklisted=true", () => {
    expect(
      applyInputDrivenExclusions(
        makeRow({ canBeBlacklisted: true }),
        makeInput({ decentralization: "required" }),
      ),
    ).toEqual(expect.objectContaining({ reason: "decentralization-required-violation" }));
  });

  it("custody=onchain-only + institutional-top excluded", () => {
    expect(
      applyInputDrivenExclusions(
        makeRow({ custodyModel: "institutional-top" }),
        makeInput({ custodyOk: "onchain-only" }),
      ),
    ).toEqual(expect.objectContaining({ reason: "custody-onchain-only-violation" }));
  });

  it("yieldNativeOnly + lending deployment excluded", () => {
    expect(
      applyInputDrivenExclusions(
        makeRow({ deploymentPlace: "lending" }),
        makeInput({ profile: "yield", yieldNativeOnly: true }),
      ),
    ).toEqual(expect.objectContaining({ reason: "yield-native-only-violation" }));
  });
});

describe("hasRequiredSignals", () => {
  it("Treasury coverage all-present", () => {
    expect(hasRequiredSignals(makeRow(), "treasury")).toEqual({
      ok: true,
      missing: [],
    });
  });

  it("Treasury surfaces missing signals", () => {
    const row = makeRow({ safetyResilienceScore: null, dewsScore: null });
    const result = hasRequiredSignals(row, "treasury");
    expect(result.ok).toBe(false);
    expect(result.missing.sort()).toEqual(["dewsScore", "safetyResilienceScore"]);
  });

  it("Yield required set", () => {
    const row = makeRow({ pharosYieldScore: null });
    expect(hasRequiredSignals(row, "yield").missing).toContain("pharosYieldScore");
  });

  it("Trading required set", () => {
    const row = makeRow({ liquidityScore: null });
    expect(hasRequiredSignals(row, "trading").missing).toContain("liquidityScore");
  });
});
