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

  it("rejects a commodity peg when its derived rate is missing", () => {
    expect(deriveAuthoritativePegSignal({
      price: 3_000,
      pegCurrency: "GOLD",
      pegType: "peggedGOLD",
      pegRates: {},
      pegRateSources: {},
      pegRateCounts: {},
    })).toMatchObject({
      kind: "rejected",
      reason: "non-authoritative-reference",
    });
  });

  it("rejects unusable references despite authoritative FX evidence", () => {
    for (const reference of [0, -1, NaN, Infinity]) {
      expect(deriveAuthoritativePegSignal({
        price: 0.18, pegCurrency: "BRL", pegType: "peggedREAL",
        pegRates: { peggedREAL: reference },
        pegRateSources: { peggedREAL: "fx" }, pegRateCounts: { peggedREAL: 1 },
      })).toMatchObject({ kind: "rejected", reason: "invalid-reference" });
    }
  });

  it("rejects absent and nonfinite prices with a valid authoritative reference", () => {
    for (const price of [null, undefined, NaN, Infinity]) {
      expect(deriveAuthoritativePegSignal({
        price, pegCurrency: "BRL", pegType: "peggedREAL",
        pegRates: { peggedREAL: 0.19 },
        pegRateSources: { peggedREAL: "fx" }, pegRateCounts: { peggedREAL: 1 },
      })).toMatchObject({ kind: "rejected", reason: "invalid-price" });
    }
  });

  it("normalizes aliases before selecting rate and authority evidence", () => {
    expect(deriveAuthoritativePegSignal({
      price: 0.18, pegCurrency: "BRL", pegType: "peggedBRL",
      pegRates: { peggedREAL: 0.19, peggedBRL: 1 },
      pegRateSources: { peggedREAL: "fx", peggedBRL: "median" },
      pegRateCounts: { peggedREAL: 1, peggedBRL: 0 },
    })).toMatchObject({
      kind: "signal", pegReference: 0.19, deviationBps: -526,
      evidence: { pegType: "peggedREAL", source: "fx", contributorCount: 1 },
    });
  });
});
