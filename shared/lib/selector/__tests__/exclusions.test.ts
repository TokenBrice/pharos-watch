import { describe, expect, it } from "vitest";
import {
  HOWEY_UNCERTAIN_ASSETS,
  activeDepegThresholdBps,
  applyInputDrivenExclusions,
  evaluateExclusions,
  hasRequiredSignals,
  treasuryPegScoreFloor,
  tradingDewsCeiling,
  tradingPegScoreFloor,
  yieldPegScoreFloor,
} from "../exclusions";
import type { MergedRow } from "../types";
import { makeInput, makeMergedRowWithIdentity } from "./fixture";

function makeRow(overrides: Partial<MergedRow> = {}): MergedRow {
  return makeMergedRowWithIdentity({ id: "test-coin", symbol: "TEST", name: "Test Stable" }, {
    protocolSlug: "test",
    mechanismArchetype: "cdp",
    pegScore: 95,
    dewsScore: 25,
    safetyScore: 90,
    safetyDecentralizationScore: 70,
    safetyLiquidityScore: 75,
    concentrationHhi: 0.3,
    chainTvl: { ethereum: 40_000_000, base: 10_000_000 },
    yieldProtocolSlug: "aave-v3",
    yieldVenueChain: "ethereum",
    yieldFreshness: { capturedAt: 0, ageSeconds: 60 },
    pegSummaryAgeSec: 30,
    dexTvlAgeSec: 120,
    dewsAgeSec: 200,
    ...overrides,
  });
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

  it("treasuryPegScoreFloor scales with depeg tolerance", () => {
    expect(treasuryPegScoreFloor("zero")).toBe(80);
    expect(treasuryPegScoreFloor("tight")).toBe(70);
    expect(treasuryPegScoreFloor("moderate")).toBe(60);
  });

  it("yieldPegScoreFloor scales with depeg tolerance", () => {
    expect(yieldPegScoreFloor("zero")).toBe(65);
    expect(yieldPegScoreFloor("tight")).toBe(55);
    expect(yieldPegScoreFloor("moderate")).toBe(45);
  });

  it("tradingPegScoreFloor scales with depeg tolerance", () => {
    expect(tradingPegScoreFloor("zero")).toBe(85);
    expect(tradingPegScoreFloor("tight")).toBe(80);
    expect(tradingPegScoreFloor("moderate")).toBe(70);
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

  it("historical depeg count does not exclude DeFi rows when PegScore passes", () => {
    expect(
      evaluateExclusions(
        makeRow({
          id: "bold-liquity-like",
          symbol: "BOLD",
          governance: "decentralized",
          custodyModel: "onchain",
          canBeBlacklisted: false,
          depegEventCount: 4,
          pegScore: 93,
          safetyDecentralizationScore: 88,
        }),
        makeInput({ profile: "treasury", depegTolerance: "zero" }),
      ),
    ).toBeNull();
    expect(
      evaluateExclusions(
        makeRow({
          id: "lusd-liquity-like",
          symbol: "LUSD",
          governance: "decentralized",
          custodyModel: "onchain",
          canBeBlacklisted: false,
          depegEventCount: 565,
          pegScore: 76,
          safetyDecentralizationScore: 90,
        }),
        makeInput({ profile: "treasury", depegTolerance: "tight" }),
      ),
    ).toBeNull();
  });

  it("historical depeg count is not a hard Treasury gate when peg data is missing", () => {
    expect(evaluateExclusions(makeRow({ depegEventCount: 2, pegScore: null }), input)).toBeNull();
  });

  it("weak PegScore fails Treasury by tolerance", () => {
    expect(
      evaluateExclusions(
        makeRow({ pegScore: 95, depegEventCount: 2 }),
        input,
      ),
    ).toBeNull();
    expect(
      evaluateExclusions(
        makeRow({ pegScore: 69, depegEventCount: 2 }),
        input,
      ),
    ).toEqual(expect.objectContaining({ reason: "peg-score-floor" }));
    expect(
      evaluateExclusions(
        makeRow({ pegScore: 59 }),
        makeInput({ profile: "treasury", depegTolerance: "moderate" }),
      ),
    ).toEqual(expect.objectContaining({ reason: "peg-score-floor" }));
    expect(
      evaluateExclusions(
        makeRow({ pegScore: 60 }),
        makeInput({ profile: "treasury", depegTolerance: "moderate" }),
      ),
    ).toBeNull();
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

  it("Yield depeg tolerance uses PegScore, not depeg event count", () => {
    const tight = makeInput({ profile: "yield", depegTolerance: "tight" });
    expect(
      evaluateExclusions(makeRow({ depegEventCount: 6, pegScore: 100 }), tight),
    ).toBeNull();
    expect(evaluateExclusions(makeRow({ pegScore: 54 }), tight)).toEqual(
      expect.objectContaining({ reason: "peg-score-floor" }),
    );
  });

  it("peg-score-floor scales with depegTolerance (zero=65)", () => {
    const zero = makeInput({ profile: "yield", depegTolerance: "zero" });
    expect(evaluateExclusions(makeRow({ pegScore: 60 }), zero)).toEqual(
      expect.objectContaining({ reason: "peg-score-floor" }),
    );
    expect(evaluateExclusions(makeRow({ pegScore: 70 }), zero)).toBeNull();
  });

  it("peg-score-floor scales with depegTolerance (tight=55)", () => {
    const tight = makeInput({ profile: "yield", depegTolerance: "tight" });
    expect(evaluateExclusions(makeRow({ pegScore: 50 }), tight)).toEqual(
      expect.objectContaining({ reason: "peg-score-floor" }),
    );
    expect(evaluateExclusions(makeRow({ pegScore: 60 }), tight)).toBeNull();
  });

  it("peg-score-floor scales with depegTolerance (moderate=45)", () => {
    const moderate = makeInput({ profile: "yield", depegTolerance: "moderate" });
    expect(evaluateExclusions(makeRow({ pegScore: 40 }), moderate)).toEqual(
      expect.objectContaining({ reason: "peg-score-floor" }),
    );
    expect(evaluateExclusions(makeRow({ pegScore: 50 }), moderate)).toBeNull();
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

  it("Trading depeg tolerance uses PegScore", () => {
    expect(evaluateExclusions(makeRow({ pegScore: 79 }), input)).toEqual(
      expect.objectContaining({ reason: "peg-score-floor" }),
    );
    expect(evaluateExclusions(makeRow({ pegScore: 80 }), input)).toBeNull();
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

  // Since `selector-v2.1` the floor reads the published V9 Exit pillar
  // (`safetyLiquidityScore`) directly; the duplicate `effectiveExitScore` row
  // field that carried a character-identical copy of it is gone.
  it("effective-exit-floor under 24h: 45 excluded, 55 passes", () => {
    const day = makeInput({ profile: "trading", exitSpeed: "24h" });
    expect(
      evaluateExclusions(makeRow({ safetyLiquidityScore: 45 }), day),
    ).toEqual(expect.objectContaining({ reason: "effective-exit-floor" }));
    expect(
      evaluateExclusions(makeRow({ safetyLiquidityScore: 55 }), day),
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

  it("custody=onchain-only requires known on-chain custody", () => {
    expect(
      applyInputDrivenExclusions(
        makeRow({ custodyModel: "onchain" }),
        makeInput({ custodyOk: "onchain-only" }),
      ),
    ).toBeNull();
    expect(
      applyInputDrivenExclusions(
        makeRow({ custodyModel: null }),
        makeInput({ custodyOk: "onchain-only" }),
      ),
    ).toEqual(expect.objectContaining({ reason: "custody-onchain-only-violation" }));
  });

  it("custody=regulated-only allows regulated custody and excludes on-chain custody", () => {
    expect(
      applyInputDrivenExclusions(
        makeRow({ custodyModel: "institutional-regulated" }),
        makeInput({ custodyOk: "regulated-only" }),
      ),
    ).toBeNull();
    expect(
      applyInputDrivenExclusions(
        makeRow({ custodyModel: "institutional-top" }),
        makeInput({ custodyOk: "regulated-only" }),
      ),
    ).toBeNull();
    expect(
      applyInputDrivenExclusions(
        makeRow({ custodyModel: "onchain" }),
        makeInput({ custodyOk: "regulated-only" }),
      ),
    ).toEqual(expect.objectContaining({ reason: "custody-regulated-only-violation" }));
    expect(
      applyInputDrivenExclusions(
        makeRow({ custodyModel: null }),
        makeInput({ custodyOk: "regulated-only" }),
      ),
    ).toEqual(expect.objectContaining({ reason: "custody-regulated-only-violation" }));
  });

  // `selector-v2.1`. Before the row read curated custody, the only two custody
  // models it could ever carry were `onchain` and `institutional-regulated` —
  // the entire range of the V8 `backing × governance` inference table. An
  // exchange-custodied coin was therefore inferred `onchain` and cleared the
  // "on-chain only" rail; unregulated institutional custody was inferred
  // `institutional-regulated` and cleared the "regulated only" rail. Both rails
  // now see the reviewed value, so `cex` fails each of them.
  it("cex custody fails both custody rails", () => {
    expect(
      applyInputDrivenExclusions(
        makeRow({ custodyModel: "cex" }),
        makeInput({ custodyOk: "onchain-only" }),
      ),
    ).toEqual(expect.objectContaining({ reason: "custody-onchain-only-violation" }));
    expect(
      applyInputDrivenExclusions(
        makeRow({ custodyModel: "cex" }),
        makeInput({ custodyOk: "regulated-only" }),
      ),
    ).toEqual(expect.objectContaining({ reason: "custody-regulated-only-violation" }));
    expect(
      applyInputDrivenExclusions(
        makeRow({ custodyModel: "cex" }),
        makeInput({ custodyOk: "any" }),
      ),
    ).toBeNull();
  });

  it("unregulated and sanctioned institutional custody fail the regulated rail", () => {
    for (const custodyModel of ["institutional-unregulated", "institutional-sanctioned"] as const) {
      expect(
        applyInputDrivenExclusions(
          makeRow({ custodyModel }),
          makeInput({ custodyOk: "regulated-only" }),
        ),
      ).toEqual(expect.objectContaining({ reason: "custody-regulated-only-violation" }));
    }
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

  it("PegScore coverage does not require peg-stability history", () => {
    const row = makeRow({ pegScore: 95 });
    expect(hasRequiredSignals(row, "treasury")).toEqual({ ok: true, missing: [] });
    expect(hasRequiredSignals(row, "yield")).toEqual({ ok: true, missing: [] });
    expect(hasRequiredSignals(row, "trading")).toEqual({ ok: true, missing: [] });
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

  it("treats V9 NR as a coverage skip and preserves the public reason", () => {
    const row = makeRow({
      safetyGrade: "NR",
      safetyScore: null,
      safetyNrReasons: ["Critical V9 evidence remains unresolved."],
    });

    for (const profile of ["treasury", "yield", "trading"] as const) {
      expect(hasRequiredSignals(row, profile)).toEqual(expect.objectContaining({
        ok: false,
        missing: expect.arrayContaining([
          "safetyScore",
          "safety-nr: Critical V9 evidence remains unresolved.",
        ]),
      }));
    }
  });

  it("requires V9 provenance even when another model supplies a score", () => {
    const row = makeRow({ safetyProvenance: "yield-opportunity" });
    expect(hasRequiredSignals(row, "yield").missing).toContain("safety-score-v9");
  });
});
