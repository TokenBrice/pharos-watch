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
  });

  it("caps redemption-only to 70", () => {
    const result = computeEffectiveExitScore(null, 90);
    expect(result).toBeLessThanOrEqual(70);
  });

  it("returns max of pure-liquidity vs blend when both available", () => {
    const result = computeEffectiveExitScore(80, 60);
    expect(result).toBe(80);
  });

  it("returns blend when blend exceeds pure liquidity", () => {
    const result = computeEffectiveExitScore(40, 90);
    expect(result).toBeGreaterThan(40);
  });
});

describe("computeCapacityScore", () => {
  it("returns null when both inputs are null", () => {
    const result = computeCapacityScore({ immediateCapacityUsd: null, immediateCapacityRatio: null });
    expect(result.score).toBeNull();
  });

  it("scores high for >50% coverage ratio and >$250M capacity", () => {
    const result = computeCapacityScore({ immediateCapacityUsd: 300_000_000, immediateCapacityRatio: 0.6 });
    expect(result.score).toBeGreaterThanOrEqual(90);
  });

  it("scores low for minimal capacity", () => {
    const result = computeCapacityScore({ immediateCapacityUsd: 50_000, immediateCapacityRatio: 0.001 });
    expect(result.score).toBeLessThan(30);
  });
});

describe("computeRedemptionBackstopScore", () => {
  it("applies route family caps", () => {
    const result = computeRedemptionBackstopScore({
      routeFamily: "queue-redeem",
      accessScore: 100, settlementScore: 100, executionCertaintyScore: 100,
      capacityScore: 100, outputAssetQualityScore: 100, costScore: 100,
    });
    expect(result.score).toBeLessThanOrEqual(70);
    expect(result.capsApplied).toContain("queue-route-cap");
  });
});
