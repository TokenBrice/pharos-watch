import { describe, expect, it } from "vitest";
import { SELECTOR_PROFILES } from "../types";
import { WEIGHTS_VERSION, WEIGHT_VECTORS, assertWeightsSumTo100 } from "../weights";

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

  it("WEIGHTS_VERSION is selector-v1.0", () => {
    expect(WEIGHTS_VERSION).toBe("selector-v1.0");
  });

  it("Treasury R2-final weights match the design", () => {
    expect(WEIGHT_VECTORS.treasury).toMatchObject({
      safetyOverall: 30,
      resilience: 20,
      dependencyRisk: 17,
      pegStabilityHistory: 12,
      decentralization: 10,
      dewsInverted: 6,
      bluechip: 5,
      supplyLog: 0,
    });
  });

  it("Yield R2-final weights match the design", () => {
    expect(WEIGHT_VECTORS.yield).toMatchObject({
      pharosYieldScore: 28,
      yieldVariance: 16,
      safetyOverall: 14,
      sourceRiskInverted: 13,
      excessApy: 10,
      pegStabilityLive: 8,
      liquidity: 6,
      resilience: 5,
    });
  });

  it("Trading R2-final weights match the design", () => {
    expect(WEIGHT_VECTORS.trading).toMatchObject({
      liquidity: 30,
      pegScoreNow: 20,
      dewsInverted: 15,
      pegStabilityLive: 10,
      effectiveExit: 10,
      supplyLog: 8,
      safetyOverall: 4,
      liquidityDiversification: 3,
    });
  });
});
