import { describe, expect, it } from "vitest";
import { computeDEWS } from "../dews";
import type { DEWSInput } from "../dews";

function baseInput(overrides: Partial<DEWSInput> = {}): DEWSInput {
  return {
    stablecoinId: "usdt-tether",
    mcapUsd: 5e9,
    pegType: "peggedUSD",
    circulatingCurrent: 5e9,
    circulatingPrevDay: 5e9,
    circulatingPrevWeek: 5e9,
    weightedBalanceRatio: null,
    avgPoolStress: null,
    topPools: null,
    liquidityScore: null,
    liquidityScore7dAgo: null,
    tvlCurrent: null,
    tvl7dAgo: null,
    priceConfidence: "high",
    prevPriceConfidence: null,
    price: 1.0,
    pegRef: 1.0,
    dexPriceUsd: null,
    blacklistEvents24h: 0,
    blacklistEvents7d: 0,
    hasBlacklistTracking: false,
    burnVolume24hUsd: null,
    mintVolume24hUsd: null,
    burnBaseline30dUsd: null,
    flowDataAgeDays: 0,
    yieldWarnings: [],
    psiScore: null,
    ...overrides,
  };
}

describe("DEWS contagion amplifier", () => {
  it("defaults to 1.0 when contagionAmplifier is undefined", () => {
    const result = computeDEWS(baseInput());
    expect(result?.amplifiers.contagion).toBe(1);
  });

  it("is clamped to the [1, 1.2] range", () => {
    const high = computeDEWS(baseInput({ contagionAmplifier: 2.0 }));
    expect(high?.amplifiers.contagion).toBe(1.2);
    const low = computeDEWS(baseInput({ contagionAmplifier: 0.5 }));
    expect(low?.amplifiers.contagion).toBe(1);
  });

  it("multiplies on top of PSI amplifier", () => {
    // Use an input with real stress signal so PSI + contagion actually change the score.
    const stressed = (contagionAmplifier: number) =>
      computeDEWS(
        baseInput({
          circulatingCurrent: 4.5e9,
          circulatingPrevDay: 5e9,
          circulatingPrevWeek: 5e9,
          psiScore: 50,
          contagionAmplifier,
        }),
      );

    const base = stressed(1);
    const amplified = stressed(1.15);
    expect(amplified!.score).toBeGreaterThan(base!.score);
    expect(amplified!.amplifiers.psi).toBeGreaterThan(1);
    expect(amplified!.amplifiers.contagion).toBe(1.15);
  });

  it("preserves 0 score when baseline weighted sum is 0", () => {
    // With all stress signals at 0 (default baseline), amplifying 0 is still 0.
    const result = computeDEWS(baseInput({ contagionAmplifier: 1.2 }));
    expect(result?.score).toBe(0);
  });
});
