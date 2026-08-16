import { describe, expect, it } from "vitest";
import { deriveAuthoritativePegSignal } from "../authoritative-peg-signal";

describe("deriveAuthoritativePegSignal", () => {
  it("rejects a thin non-USD peer median before deriving deviation", () => {
    expect(deriveAuthoritativePegSignal({
      price: 0.18,
      pegCurrency: "BRL",
      pegType: "peggedREAL",
      pegRates: { peggedREAL: 0.19 },
      pegRateSources: { peggedREAL: "median" },
      pegRateCounts: { peggedREAL: 2 },
    })).toEqual({
      kind: "rejected",
      reason: "non-authoritative-reference",
      evidence: {
        pegType: "peggedREAL",
        source: "median",
        contributorCount: 2,
      },
    });
  });

  it("returns the reference, deviation, and source evidence for an authoritative signal", () => {
    const result = deriveAuthoritativePegSignal({
      price: 0.18,
      pegCurrency: "BRL",
      pegType: "peggedREAL",
      pegRates: { peggedREAL: 0.19 },
      pegRateSources: { peggedREAL: "fx" },
      pegRateCounts: { peggedREAL: 1 },
    });

    expect(result).toMatchObject({
      kind: "signal",
      pegReference: 0.19,
      deviationBps: -526,
      evidence: {
        pegType: "peggedREAL",
        source: "fx",
        contributorCount: 1,
      },
    });
  });
});
