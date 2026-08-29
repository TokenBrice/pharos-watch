import { describe, expect, it } from "vitest";
import { computeDEWS } from "../dews";
import { makeDewsInput } from "./dews.test-support";

describe("DEWS contagion amplifier", () => {
  it("defaults to 1.0 when contagionAmplifier is undefined", () => {
    const result = computeDEWS(makeDewsInput());
    expect(result?.amplifiers.contagion).toBe(1);
  });

  it("is clamped to the [1, 1.2] range", () => {
    const high = computeDEWS(makeDewsInput({ contagionAmplifier: 2.0 }));
    expect(high?.amplifiers.contagion).toBe(1.2);
    const low = computeDEWS(makeDewsInput({ contagionAmplifier: 0.5 }));
    expect(low?.amplifiers.contagion).toBe(1);
  });

  it("multiplies on top of PSI amplifier", () => {
    // Use an input with real stress signal so PSI + contagion actually change the score.
    const stressed = (contagionAmplifier: number) =>
      computeDEWS(
        makeDewsInput({
          circulatingCurrent: 4.5e9,
          circulatingPrevDay: 5e9,
          circulatingPrevWeek: 5e9,
          price: 0.99,
          dexPriceUsd: 0.99,
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
    const result = computeDEWS(makeDewsInput({ contagionAmplifier: 1.2 }));
    expect(result?.score).toBe(0);
  });
});
