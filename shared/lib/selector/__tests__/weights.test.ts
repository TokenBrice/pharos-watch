import { describe, expect, it } from "vitest";
import { SELECTOR_PROFILES } from "../types";
import { SELECTOR_VERSION } from "../version";
import {
  WEIGHTS_VERSION,
  WEIGHT_VECTORS,
  assertWeightsSumTo100,
  getWeightVectorForInput,
} from "../weights";
import { makeInput } from "./fixture";

describe("weights", () => {
  it.each(SELECTOR_PROFILES)("%s weights sum to 100", (profile) => {
    const vector = WEIGHT_VECTORS[profile];
    const total = Object.values(vector).reduce<number>(
      (acc, value) => acc + (typeof value === "number" ? value : 0),
      0,
    );
    expect(total).toBe(100);
  });

  it("assertWeightsSumTo100 throws on mutation", () => {
    const bad = { ...WEIGHT_VECTORS.treasury, safetyOverall: 31 };
    expect(() => assertWeightsSumTo100("treasury", bad)).toThrow();
  });

  it("WEIGHTS_VERSION matches the central selector version", () => {
    expect(WEIGHTS_VERSION).toBe(SELECTOR_VERSION);
  });

  it("Treasury weights match the design", () => {
    expect(WEIGHT_VECTORS.treasury).toEqual({
      safetyOverall: 55,
      pegStabilityHistory: 22,
      dewsInverted: 13,
      bluechip: 10,
      supplyLog: 0,
    });
  });

  it("Yield weights match the design", () => {
    expect(WEIGHT_VECTORS.yield).toEqual({
      pharosYieldScore: 28,
      safetyOverall: 19,
      yieldVariance: 16,
      sourceRiskInverted: 13,
      excessApy: 10,
      pegStabilityLive: 8,
      liquidity: 6,
    });
  });

  it("Trading weights match the design", () => {
    expect(WEIGHT_VECTORS.trading).toEqual({
      liquidity: 30,
      pegScoreNow: 30,
      dewsInverted: 15,
      safetyOverall: 14,
      supplyLog: 8,
      liquidityDiversification: 3,
    });
  });

  it("no vector prices a V9 pillar beside the composite that contains it", () => {
    for (const profile of SELECTOR_PROFILES) {
      const vector = WEIGHT_VECTORS[profile] as Record<string, number | undefined>;
      for (const retired of ["resilience", "dependencyRisk", "decentralization", "effectiveExit"]) {
        expect(vector[retired], `${profile}.${retired}`).toBeUndefined();
      }
    }
  });

  it("no vector spends its peg budget on two slots reading the same PegScore", () => {
    const pegSlots = ["pegStabilityHistory", "pegStabilityLive", "pegScoreNow"] as const;
    for (const profile of SELECTOR_PROFILES) {
      const vector = WEIGHT_VECTORS[profile] as Record<string, number | undefined>;
      const allocated = pegSlots.filter((slot) => (vector[slot] ?? 0) > 0);
      expect(allocated.length, profile).toBeLessThanOrEqual(1);
    }
  });

  it("overlays never revive a retired slot", () => {
    const inputs = [
      makeInput({ profile: "treasury", exitSpeed: "1h" }),
      makeInput({ profile: "treasury", horizon: "6mplus" }),
      makeInput({ profile: "treasury", composability: "high" }),
      makeInput({ profile: "treasury", depegTolerance: "zero" }),
      makeInput({ profile: "yield", exitSpeed: "1h", composability: "high", venuePreferences: ["dex"] }),
      makeInput({ profile: "trading", exitSpeed: "1h", depegTolerance: "zero", composability: "high" }),
    ];
    for (const input of inputs) {
      const vector = getWeightVectorForInput(input) as Record<string, number | undefined>;
      for (const retired of ["resilience", "dependencyRisk", "decentralization", "effectiveExit"]) {
        expect(vector[retired] ?? 0, `${input.profile}.${retired}`).toBe(0);
      }
    }
  });

  it("answer-conditioned overlays keep sums at 100 and move zero tolerance toward peg stability", () => {
    const base = getWeightVectorForInput(makeInput({ profile: "yield", depegTolerance: "tight" }));
    const strict = getWeightVectorForInput(makeInput({ profile: "yield", depegTolerance: "zero" }));
    assertWeightsSumTo100("yield", strict);
    expect(strict.pegStabilityLive).toBeGreaterThan(base.pegStabilityLive ?? 0);
  });

  it("venue and exit overlays preserve deterministic sums", () => {
    const vector = getWeightVectorForInput(makeInput({
      profile: "yield",
      exitSpeed: "1h",
      composability: "high",
      venuePreferences: ["dex"],
    }));
    assertWeightsSumTo100("yield", vector);
    expect(vector.liquidity).toBeGreaterThan(WEIGHT_VECTORS.yield.liquidity ?? 0);
  });

  it("Treasury active DeFi intent materially shifts toward live liquidity and stress", () => {
    const activeByComposability = getWeightVectorForInput(makeInput({
      profile: "treasury",
      composability: "high",
    }));
    const activeByVenue = getWeightVectorForInput(makeInput({
      profile: "treasury",
      composability: "moderate",
      venuePreferences: ["active"],
    }));

    assertWeightsSumTo100("treasury", activeByComposability);
    expect(activeByVenue).toEqual(activeByComposability);
    expect(activeByComposability.liquidity).toBeGreaterThanOrEqual(10);
    expect(activeByComposability.dewsInverted ?? 0).toBeGreaterThan(
      WEIGHT_VECTORS.treasury.dewsInverted ?? 0,
    );
    expect(activeByComposability.bluechip).toBe(0);
    expect(activeByComposability.safetyOverall).toBeLessThan(
      WEIGHT_VECTORS.treasury.safetyOverall ?? 0,
    );
  });

  it("Treasury 1h exit emphasis buys live liquidity without touching peg history", () => {
    const vector = getWeightVectorForInput(makeInput({
      profile: "treasury",
      exitSpeed: "1h",
    }));
    assertWeightsSumTo100("treasury", vector);
    expect(vector.pegStabilityHistory).toBe(WEIGHT_VECTORS.treasury.pegStabilityHistory);
    expect(vector.liquidity).toBeGreaterThan(0);
  });
});
