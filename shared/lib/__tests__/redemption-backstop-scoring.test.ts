import { describe, it, expect } from "vitest";
import {
  computeEffectiveExitScore,
  computeCapacityScore,
  computeRedemptionBackstopScore,
} from "../redemption-backstop-scoring";

describe("computeEffectiveExitScore", () => {
  it("returns null when both inputs are null", () => {
    expect(computeEffectiveExitScore(null, null)).toBeNull();
  });

  it("returns liquidity score when only liquidity available", () => {
    expect(computeEffectiveExitScore(80, null)).toBe(80);
    expect(computeEffectiveExitScore(0, null)).toBe(0);
  });

  it("caps redemption-only at 70 and applies 0.75 discount", () => {
    // min(70, 90 * 0.75) = min(70, 67.5) = 68
    expect(computeEffectiveExitScore(null, 90)).toBe(68);
    // min(70, 100 * 0.75) = min(70, 75) = 70
    expect(computeEffectiveExitScore(null, 100)).toBe(70);
    // min(70, 40 * 0.75) = min(70, 30) = 30
    expect(computeEffectiveExitScore(null, 40)).toBe(30);
  });

  it("returns max of pure-liquidity vs blend", () => {
    // liquidity=80, redemption=60 → blend = 80*0.55 + 60*0.45 = 44+27 = 71
    // max(80, 71) = 80
    expect(computeEffectiveExitScore(80, 60)).toBe(80);
  });

  it("returns blend when blend exceeds pure liquidity", () => {
    // liquidity=40, redemption=90 → blend = 40*0.55 + 90*0.45 = 22+40.5 = 62.5 → 63
    // max(40, 63) = 63
    expect(computeEffectiveExitScore(40, 90)).toBe(63);
  });

  it("handles edge case where blend equals liquidity", () => {
    // liquidity=100, redemption=100 → blend = 100*0.55 + 100*0.45 = 100
    // max(100, 100) = 100
    expect(computeEffectiveExitScore(100, 100)).toBe(100);
  });

  it("clamps inputs to 0-100", () => {
    expect(computeEffectiveExitScore(150, null)).toBe(100);
    expect(computeEffectiveExitScore(-10, null)).toBe(0);
  });

  it("handles non-finite inputs as null", () => {
    expect(computeEffectiveExitScore(NaN, null)).toBeNull();
    expect(computeEffectiveExitScore(null, Infinity)).toBeNull();
    expect(computeEffectiveExitScore(undefined, undefined)).toBeNull();
  });
});

describe("computeCapacityScore", () => {
  it("returns null when both inputs are null", () => {
    const result = computeCapacityScore({ immediateCapacityUsd: null, immediateCapacityRatio: null });
    expect(result.score).toBeNull();
    expect(result.coverageRatioScore).toBeNull();
    expect(result.absoluteCapacityScore).toBeNull();
  });

  it("scores exact breakpoints for coverage ratio", () => {
    // ratio=0 → 0, ratio=0.5 → 100
    const zero = computeCapacityScore({ immediateCapacityUsd: null, immediateCapacityRatio: 0 });
    expect(zero.coverageRatioScore).toBe(0);

    const full = computeCapacityScore({ immediateCapacityUsd: null, immediateCapacityRatio: 0.5 });
    expect(full.coverageRatioScore).toBe(100);

    const quarter = computeCapacityScore({ immediateCapacityUsd: null, immediateCapacityRatio: 0.25 });
    expect(quarter.coverageRatioScore).toBe(80);
  });

  it("interpolates between breakpoints", () => {
    // ratio=0.075 → between 0.05(40) and 0.10(60), midpoint = 50
    const mid = computeCapacityScore({ immediateCapacityUsd: null, immediateCapacityRatio: 0.075 });
    expect(mid.coverageRatioScore).toBe(50);
  });

  it("blends ratio (60%) and absolute (40%)", () => {
    // ratio=0.5→100, usd=250M→100 → 100*0.6 + 100*0.4 = 100
    const result = computeCapacityScore({ immediateCapacityUsd: 250_000_000, immediateCapacityRatio: 0.5 });
    expect(result.score).toBe(100);

    // ratio=0→0, usd=0→0 → 0
    const low = computeCapacityScore({ immediateCapacityUsd: 0, immediateCapacityRatio: 0 });
    expect(low.score).toBe(0);
  });

  it("uses available score when only one dimension exists", () => {
    // Only ratio: coverage=score, absolute=score (fallback), blend = score
    const ratioOnly = computeCapacityScore({ immediateCapacityUsd: null, immediateCapacityRatio: 0.25 });
    expect(ratioOnly.score).toBe(80); // 80*0.6 + 80*0.4 = 80
    expect(ratioOnly.absoluteCapacityScore).toBeNull();
  });
});

describe("computeRedemptionBackstopScore", () => {
  it("returns null when capacity is null", () => {
    const result = computeRedemptionBackstopScore({
      routeFamily: "stablecoin-redeem",
      accessScore: 100, settlementScore: 100, executionCertaintyScore: 100,
      capacityScore: null, outputAssetQualityScore: 100, costScore: 100,
    });
    expect(result.score).toBeNull();
    expect(result.capsApplied).toEqual([]);
  });

  it("computes weighted score correctly", () => {
    // All 100 → 100*0.20 + 100*0.15 + 100*0.15 + 100*0.25 + 100*0.15 + 100*0.10 = 100
    const result = computeRedemptionBackstopScore({
      routeFamily: "stablecoin-redeem",
      accessScore: 100, settlementScore: 100, executionCertaintyScore: 100,
      capacityScore: 100, outputAssetQualityScore: 100, costScore: 100,
    });
    expect(result.score).toBe(100);
  });

  it("applies queue-redeem cap at 70", () => {
    const result = computeRedemptionBackstopScore({
      routeFamily: "queue-redeem",
      accessScore: 100, settlementScore: 100, executionCertaintyScore: 100,
      capacityScore: 100, outputAssetQualityScore: 100, costScore: 100,
    });
    expect(result.score).toBe(70);
    expect(result.capsApplied).toContain("queue-route-cap");
  });

  it("applies offchain-issuer cap at 65", () => {
    const result = computeRedemptionBackstopScore({
      routeFamily: "offchain-issuer",
      accessScore: 100, settlementScore: 100, executionCertaintyScore: 100,
      capacityScore: 100, outputAssetQualityScore: 100, costScore: 100,
    });
    expect(result.score).toBe(65);
    expect(result.capsApplied).toContain("offchain-route-cap");
  });

  it("applies config-level cap", () => {
    const result = computeRedemptionBackstopScore({
      routeFamily: "stablecoin-redeem",
      accessScore: 100, settlementScore: 100, executionCertaintyScore: 100,
      capacityScore: 100, outputAssetQualityScore: 100, costScore: 100,
      totalScoreCap: 50,
    });
    expect(result.score).toBe(50);
    expect(result.capsApplied).toContain("config-cap");
  });

  it("does not apply caps when score is below threshold", () => {
    const result = computeRedemptionBackstopScore({
      routeFamily: "queue-redeem",
      accessScore: 20, settlementScore: 20, executionCertaintyScore: 20,
      capacityScore: 20, outputAssetQualityScore: 20, costScore: 20,
    });
    expect(result.score).toBe(20);
    expect(result.capsApplied).toEqual([]);
  });

  it("does not apply route cap to uncapped families", () => {
    const families = ["stablecoin-redeem", "basket-redeem", "collateral-redeem", "psm-swap"] as const;
    for (const routeFamily of families) {
      const result = computeRedemptionBackstopScore({
        routeFamily,
        accessScore: 100, settlementScore: 100, executionCertaintyScore: 100,
        capacityScore: 100, outputAssetQualityScore: 100, costScore: 100,
      });
      expect(result.capsApplied).toEqual([]);
    }
  });
});
