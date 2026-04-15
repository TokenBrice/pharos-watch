import { describe, it, expect } from "vitest";
import {
  computeEffectiveExitScore,
  computeCapacityScore,
  computeRedemptionBackstopScore,
  isStrongLiveDirectRoute,
} from "../redemption-backstop-scoring";

describe("computeEffectiveExitScore", () => {
  it("returns null when both inputs are null", () => {
    expect(computeEffectiveExitScore(null, null)).toBeNull();
  });

  it("returns liquidity score when only liquidity available", () => {
    expect(computeEffectiveExitScore(80, null)).toBe(80);
    expect(computeEffectiveExitScore(0, null)).toBe(0);
  });

  it("returns redemption score directly when only redemption available (no cap)", () => {
    expect(computeEffectiveExitScore(null, 90)).toBe(90);
    expect(computeEffectiveExitScore(null, 100)).toBe(100);
    expect(computeEffectiveExitScore(null, 40)).toBe(40);
    // Route family caps (65/70) are applied upstream, not here
    expect(computeEffectiveExitScore(null, 70)).toBe(70);
  });

  it("uses best path + diversification bonus when both exist", () => {
    // dex=80, redemption=60 → best=80, bonus=60*0.10=6 → 86
    expect(computeEffectiveExitScore(80, 60)).toBe(86);
    // dex=40, redemption=90 → best=90, bonus=40*0.10=4 → 94
    expect(computeEffectiveExitScore(40, 90)).toBe(94);
    // dex=51, redemption=90 → best=90, bonus=51*0.10=5.1 → 95
    expect(computeEffectiveExitScore(51, 90)).toBe(95);
  });

  it("caps effective score at 100", () => {
    // dex=95, redemption=98 → best=98, bonus=95*0.10=9.5 → 107.5 → capped at 100
    expect(computeEffectiveExitScore(95, 98)).toBe(100);
    expect(computeEffectiveExitScore(100, 100)).toBe(100);
  });

  it("is monotonic — adding any path never lowers the score", () => {
    // Strong redemption, adding weak DEX should only help
    const redeemOnly = computeEffectiveExitScore(null, 80)!;
    const withWeakDex = computeEffectiveExitScore(15, 80)!;
    expect(withWeakDex).toBeGreaterThanOrEqual(redeemOnly);

    // Strong DEX, adding weak redemption should only help
    const dexOnly = computeEffectiveExitScore(70, null)!;
    const withWeakRedeem = computeEffectiveExitScore(70, 20)!;
    expect(withWeakRedeem).toBeGreaterThanOrEqual(dexOnly);
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

  it("clamps ratio > 1 to the top breakpoint", () => {
    const result = computeCapacityScore({ immediateCapacityUsd: null, immediateCapacityRatio: 2 });
    expect(result.coverageRatioScore).toBe(100);
  });

  it("returns null for negative ratio", () => {
    const result = computeCapacityScore({ immediateCapacityUsd: null, immediateCapacityRatio: -0.1 });
    expect(result.coverageRatioScore).toBeNull();
    expect(result.score).toBeNull();
  });

  it("returns null for negative USD", () => {
    const result = computeCapacityScore({ immediateCapacityUsd: -1000, immediateCapacityRatio: null });
    expect(result.absoluteCapacityScore).toBeNull();
    expect(result.score).toBeNull();
  });

  it("returns null for non-finite inputs", () => {
    const nan = computeCapacityScore({ immediateCapacityUsd: NaN, immediateCapacityRatio: null });
    expect(nan.score).toBeNull();
    const inf = computeCapacityScore({ immediateCapacityUsd: Infinity, immediateCapacityRatio: null });
    expect(inf.score).toBeNull();
  });

  it("scores exact ratio breakpoints", () => {
    const bp001 = computeCapacityScore({ immediateCapacityUsd: null, immediateCapacityRatio: 0.01 });
    expect(bp001.coverageRatioScore).toBe(20);
    const bp005 = computeCapacityScore({ immediateCapacityUsd: null, immediateCapacityRatio: 0.05 });
    expect(bp005.coverageRatioScore).toBe(40);
    const bp010 = computeCapacityScore({ immediateCapacityUsd: null, immediateCapacityRatio: 0.10 });
    expect(bp010.coverageRatioScore).toBe(60);
    const bp025 = computeCapacityScore({ immediateCapacityUsd: null, immediateCapacityRatio: 0.25 });
    expect(bp025.coverageRatioScore).toBe(80);
  });

  it("scores exact USD breakpoints", () => {
    const bp100k = computeCapacityScore({ immediateCapacityUsd: 100_000, immediateCapacityRatio: null });
    expect(bp100k.absoluteCapacityScore).toBe(20);
    const bp1m = computeCapacityScore({ immediateCapacityUsd: 1_000_000, immediateCapacityRatio: null });
    expect(bp1m.absoluteCapacityScore).toBe(40);
    const bp10m = computeCapacityScore({ immediateCapacityUsd: 10_000_000, immediateCapacityRatio: null });
    expect(bp10m.absoluteCapacityScore).toBe(60);
    const bp50m = computeCapacityScore({ immediateCapacityUsd: 50_000_000, immediateCapacityRatio: null });
    expect(bp50m.absoluteCapacityScore).toBe(80);
    const bp250m = computeCapacityScore({ immediateCapacityUsd: 250_000_000, immediateCapacityRatio: null });
    expect(bp250m.absoluteCapacityScore).toBe(100);
  });

  it("handles USD beyond top breakpoint without overflow", () => {
    const huge = computeCapacityScore({ immediateCapacityUsd: 1_000_000_000_000, immediateCapacityRatio: null });
    expect(huge.absoluteCapacityScore).toBe(100);
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

  it("queue-redeem cap is NOT applied when weighted score is exactly 70", () => {
    const result = computeRedemptionBackstopScore({
      routeFamily: "queue-redeem",
      accessScore: 70, settlementScore: 70, executionCertaintyScore: 70,
      capacityScore: 70, outputAssetQualityScore: 70, costScore: 70,
    });
    expect(result.score).toBe(70);
    expect(result.capsApplied).toEqual([]);
  });

  it("queue-redeem cap is applied when weighted score is 71", () => {
    const result = computeRedemptionBackstopScore({
      routeFamily: "queue-redeem",
      accessScore: 71, settlementScore: 71, executionCertaintyScore: 71,
      capacityScore: 71, outputAssetQualityScore: 71, costScore: 71,
    });
    expect(result.score).toBe(70);
    expect(result.capsApplied).toContain("queue-route-cap");
  });

  it("offchain-issuer cap is NOT applied when weighted score is exactly 65", () => {
    const result = computeRedemptionBackstopScore({
      routeFamily: "offchain-issuer",
      accessScore: 65, settlementScore: 65, executionCertaintyScore: 65,
      capacityScore: 65, outputAssetQualityScore: 65, costScore: 65,
    });
    expect(result.score).toBe(65);
    expect(result.capsApplied).toEqual([]);
  });

  it("offchain-issuer cap is applied when weighted score is 66", () => {
    const result = computeRedemptionBackstopScore({
      routeFamily: "offchain-issuer",
      accessScore: 66, settlementScore: 66, executionCertaintyScore: 66,
      capacityScore: 66, outputAssetQualityScore: 66, costScore: 66,
    });
    expect(result.score).toBe(65);
    expect(result.capsApplied).toContain("offchain-route-cap");
  });
});

describe("isStrongLiveDirectRoute", () => {
  const strongInput = {
    capacityConfidence: "live-direct" as const,
    sourceMode: "dynamic" as const,
    accessModel: "permissionless-onchain" as const,
    settlementModel: "atomic" as const,
  };

  it("returns true for live-direct dynamic permissionless atomic", () => {
    expect(isStrongLiveDirectRoute(strongInput)).toBe(true);
  });

  it("returns true for live-direct dynamic permissionless immediate", () => {
    expect(isStrongLiveDirectRoute({ ...strongInput, settlementModel: "immediate" })).toBe(true);
  });

  it("returns false for live-proxy capacity confidence", () => {
    expect(isStrongLiveDirectRoute({ ...strongInput, capacityConfidence: "live-proxy" })).toBe(false);
  });

  it("returns false for documented-bound capacity confidence", () => {
    expect(isStrongLiveDirectRoute({ ...strongInput, capacityConfidence: "documented-bound" })).toBe(false);
  });

  it("returns false for heuristic capacity confidence", () => {
    expect(isStrongLiveDirectRoute({ ...strongInput, capacityConfidence: "heuristic" })).toBe(false);
  });

  it("returns false for dynamic legacy capacity confidence", () => {
    expect(isStrongLiveDirectRoute({ ...strongInput, capacityConfidence: "dynamic" })).toBe(false);
  });

  it("returns false for estimated source mode", () => {
    expect(isStrongLiveDirectRoute({ ...strongInput, sourceMode: "estimated" })).toBe(false);
  });

  it("returns false for static source mode", () => {
    expect(isStrongLiveDirectRoute({ ...strongInput, sourceMode: "static" })).toBe(false);
  });

  it("returns false for whitelisted-onchain access", () => {
    expect(isStrongLiveDirectRoute({ ...strongInput, accessModel: "whitelisted-onchain" })).toBe(false);
  });

  it("returns false for issuer-api access", () => {
    expect(isStrongLiveDirectRoute({ ...strongInput, accessModel: "issuer-api" })).toBe(false);
  });

  it("returns false for manual access", () => {
    expect(isStrongLiveDirectRoute({ ...strongInput, accessModel: "manual" })).toBe(false);
  });

  it("returns false for same-day settlement", () => {
    expect(isStrongLiveDirectRoute({ ...strongInput, settlementModel: "same-day" })).toBe(false);
  });

  it("returns false for queued settlement", () => {
    expect(isStrongLiveDirectRoute({ ...strongInput, settlementModel: "queued" })).toBe(false);
  });

  it("returns false for days settlement", () => {
    expect(isStrongLiveDirectRoute({ ...strongInput, settlementModel: "days" })).toBe(false);
  });
});
