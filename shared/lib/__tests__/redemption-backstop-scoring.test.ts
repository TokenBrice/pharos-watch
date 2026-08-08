import { describe, it, expect } from "vitest";
import {
  applyCapacityConstraintScoreEffects,
  computeCapacityScore,
  computeModeledExitSizeUsd,
  computeRedemptionBackstopScore,
  isStrongLiveDirectRoute,
} from "../redemption-backstop-scoring";

describe("computeModeledExitSizeUsd", () => {
  it("models exit size as five percent of supply with floor and cap", () => {
    expect(computeModeledExitSizeUsd(1_000_000)).toBe(100_000);
    expect(computeModeledExitSizeUsd(100_000_000)).toBe(5_000_000);
    expect(computeModeledExitSizeUsd(10_000_000_000)).toBe(25_000_000);
  });

  it("returns null modeled exit size for missing, non-finite, or non-positive supply", () => {
    expect(computeModeledExitSizeUsd(null)).toBeNull();
    expect(computeModeledExitSizeUsd(0)).toBeNull();
    expect(computeModeledExitSizeUsd(-1)).toBeNull();
    expect(computeModeledExitSizeUsd(Number.POSITIVE_INFINITY)).toBeNull();
  });
});

describe("isStrongLiveDirectRoute", () => {
  it("requires direct live capacity, dynamic source mode, and immediate exercisability", () => {
    const base = {
      capacityConfidence: "live-direct",
      capacityKind: "live-direct-bounded",
      sourceMode: "dynamic",
      accessModel: "permissionless-onchain",
      settlementModel: "atomic",
    } as const;

    expect(isStrongLiveDirectRoute(base)).toBe(true);
    expect(isStrongLiveDirectRoute({ ...base, capacityConfidence: "live-proxy" })).toBe(false);
    expect(isStrongLiveDirectRoute({ ...base, sourceMode: "static" })).toBe(false);
    expect(isStrongLiveDirectRoute({ ...base, accessModel: "issuer-api" })).toBe(false);
    expect(isStrongLiveDirectRoute({ ...base, settlementModel: "days" })).toBe(false);
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
    const bp010 = computeCapacityScore({ immediateCapacityUsd: null, immediateCapacityRatio: 0.1 });
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

  it("uses tier-floor scoring for fixed USD capacity when supply is missing", () => {
    const result = computeCapacityScore({
      immediateCapacityUsd: 5_000_000,
      immediateCapacityRatio: null,
      absoluteOnlyMode: "tier-floor",
    });
    expect(result.absoluteCapacityScore).toBe(40);
    expect(result.score).toBe(40);
  });
});

describe("applyCapacityConstraintScoreEffects", () => {
  it("does not penalize missing optional telemetry", () => {
    expect(
      applyCapacityConstraintScoreEffects({
        capacityScore: 80,
        scoringCapacityUsd: 10_000_000,
      }),
    ).toEqual({ score: 80, capsApplied: [] });
  });

  it("penalizes adverse live queue, delay, minimum size, and eligibility telemetry", () => {
    const result = applyCapacityConstraintScoreEffects({
      capacityScore: 80,
      scoringCapacityUsd: 10_000_000,
      settlementDelaySec: 172_800,
      queueDepthUsd: 12_000_000,
      minRedeemUsd: 100_000,
      liveHolderEligibility: "whitelisted-primary",
    });

    expect(result.score).toBeLessThan(80);
    expect(result.capsApplied).toEqual([
      "settlement-delay-penalty",
      "queue-depth-penalty",
      "minimum-size-penalty",
      "live-holder-eligibility-penalty",
    ]);
  });

  it("applies settlement-delay penalties only above each threshold", () => {
    expect(
      applyCapacityConstraintScoreEffects({
        capacityScore: 100,
        scoringCapacityUsd: 10_000_000,
        settlementDelaySec: 3_600,
      }),
    ).toEqual({
      score: 100,
      capsApplied: [],
    });
    expect(
      applyCapacityConstraintScoreEffects({
        capacityScore: 100,
        scoringCapacityUsd: 10_000_000,
        settlementDelaySec: 3_601,
      }),
    ).toEqual({
      score: 90,
      capsApplied: ["settlement-delay-penalty"],
    });
    expect(
      applyCapacityConstraintScoreEffects({
        capacityScore: 100,
        scoringCapacityUsd: 10_000_000,
        settlementDelaySec: 86_401,
      }),
    ).toEqual({
      score: 75,
      capsApplied: ["settlement-delay-penalty"],
    });
    expect(
      applyCapacityConstraintScoreEffects({
        capacityScore: 100,
        scoringCapacityUsd: 10_000_000,
        settlementDelaySec: 604_801,
      }),
    ).toEqual({
      score: 60,
      capsApplied: ["settlement-delay-penalty"],
    });
  });

  it("applies minimum-size penalties from the threshold upward", () => {
    expect(
      applyCapacityConstraintScoreEffects({
        capacityScore: 100,
        scoringCapacityUsd: 10_000_000,
        minRedeemUsd: 9_999,
      }),
    ).toEqual({
      score: 100,
      capsApplied: [],
    });
    // Boundary values belong to their own band (unified at-or-above matching).
    expect(
      applyCapacityConstraintScoreEffects({
        capacityScore: 100,
        scoringCapacityUsd: 10_000_000,
        minRedeemUsd: 10_000,
      }),
    ).toEqual({
      score: 90,
      capsApplied: ["minimum-size-penalty"],
    });
    expect(
      applyCapacityConstraintScoreEffects({
        capacityScore: 100,
        scoringCapacityUsd: 10_000_000,
        minRedeemUsd: 1_000_000,
      }),
    ).toEqual({
      score: 75,
      capsApplied: ["minimum-size-penalty"],
    });
  });
});

describe("computeRedemptionBackstopScore", () => {
  it("returns null when capacity is null", () => {
    const result = computeRedemptionBackstopScore({
      routeFamily: "stablecoin-redeem",
      accessScore: 100,
      settlementScore: 100,
      executionCertaintyScore: 100,
      capacityScore: null,
      outputAssetQualityScore: 100,
      costScore: 100,
    });
    expect(result.score).toBeNull();
    expect(result.capsApplied).toEqual([]);
  });

  it("computes weighted score correctly", () => {
    // All 100 → 100*0.20 + 100*0.15 + 100*0.15 + 100*0.25 + 100*0.15 + 100*0.10 = 100
    const result = computeRedemptionBackstopScore({
      routeFamily: "stablecoin-redeem",
      accessScore: 100,
      settlementScore: 100,
      executionCertaintyScore: 100,
      capacityScore: 100,
      outputAssetQualityScore: 100,
      costScore: 100,
    });
    expect(result.score).toBe(100);
  });

  it("applies queue-redeem cap at 70", () => {
    const result = computeRedemptionBackstopScore({
      routeFamily: "queue-redeem",
      accessScore: 100,
      settlementScore: 100,
      executionCertaintyScore: 100,
      capacityScore: 100,
      outputAssetQualityScore: 100,
      costScore: 100,
    });
    expect(result.score).toBe(70);
    expect(result.capsApplied).toContain("queue-route-cap");
  });

  it("applies offchain-issuer cap at 65", () => {
    const result = computeRedemptionBackstopScore({
      routeFamily: "offchain-issuer",
      accessScore: 100,
      settlementScore: 100,
      executionCertaintyScore: 100,
      capacityScore: 100,
      outputAssetQualityScore: 100,
      costScore: 100,
    });
    expect(result.score).toBe(65);
    expect(result.capsApplied).toContain("offchain-route-cap");
  });

  it("applies config-level cap", () => {
    const result = computeRedemptionBackstopScore({
      routeFamily: "stablecoin-redeem",
      accessScore: 100,
      settlementScore: 100,
      executionCertaintyScore: 100,
      capacityScore: 100,
      outputAssetQualityScore: 100,
      costScore: 100,
      totalScoreCap: 50,
    });
    expect(result.score).toBe(50);
    expect(result.capsApplied).toContain("config-cap");
  });

  it("does not apply caps when score is below threshold", () => {
    const result = computeRedemptionBackstopScore({
      routeFamily: "queue-redeem",
      accessScore: 20,
      settlementScore: 20,
      executionCertaintyScore: 20,
      capacityScore: 20,
      outputAssetQualityScore: 20,
      costScore: 20,
    });
    expect(result.score).toBe(20);
    expect(result.capsApplied).toEqual([]);
  });

  it("does not apply route cap to uncapped families", () => {
    const families = ["stablecoin-redeem", "basket-redeem", "collateral-redeem", "psm-swap"] as const;
    for (const routeFamily of families) {
      const result = computeRedemptionBackstopScore({
        routeFamily,
        accessScore: 100,
        settlementScore: 100,
        executionCertaintyScore: 100,
        capacityScore: 100,
        outputAssetQualityScore: 100,
        costScore: 100,
      });
      expect(result.capsApplied).toEqual([]);
    }
  });

  it("queue-redeem cap is NOT applied when weighted score is exactly 70", () => {
    const result = computeRedemptionBackstopScore({
      routeFamily: "queue-redeem",
      accessScore: 70,
      settlementScore: 70,
      executionCertaintyScore: 70,
      capacityScore: 70,
      outputAssetQualityScore: 70,
      costScore: 70,
    });
    expect(result.score).toBe(70);
    expect(result.capsApplied).toEqual([]);
  });

  it("queue-redeem cap is applied when weighted score is 71", () => {
    const result = computeRedemptionBackstopScore({
      routeFamily: "queue-redeem",
      accessScore: 71,
      settlementScore: 71,
      executionCertaintyScore: 71,
      capacityScore: 71,
      outputAssetQualityScore: 71,
      costScore: 71,
    });
    expect(result.score).toBe(70);
    expect(result.capsApplied).toContain("queue-route-cap");
  });

  it("offchain-issuer cap is NOT applied when weighted score is exactly 65", () => {
    const result = computeRedemptionBackstopScore({
      routeFamily: "offchain-issuer",
      accessScore: 65,
      settlementScore: 65,
      executionCertaintyScore: 65,
      capacityScore: 65,
      outputAssetQualityScore: 65,
      costScore: 65,
    });
    expect(result.score).toBe(65);
    expect(result.capsApplied).toEqual([]);
  });

  it("offchain-issuer cap is applied when weighted score is 66", () => {
    const result = computeRedemptionBackstopScore({
      routeFamily: "offchain-issuer",
      accessScore: 66,
      settlementScore: 66,
      executionCertaintyScore: 66,
      capacityScore: 66,
      outputAssetQualityScore: 66,
      costScore: 66,
    });
    expect(result.score).toBe(65);
    expect(result.capsApplied).toContain("offchain-route-cap");
  });
});

describe("isStrongLiveDirectRoute", () => {
  const strongInput = {
    capacityConfidence: "live-direct" as const,
    capacityKind: "live-direct" as const,
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

  it("returns true for explicit bounded live-direct capacity kind", () => {
    expect(isStrongLiveDirectRoute({ ...strongInput, capacityKind: "live-direct-bounded" })).toBe(true);
  });

  it("returns false when the live capacity kind is missing", () => {
    expect(
      isStrongLiveDirectRoute({
        capacityConfidence: "live-direct",
        sourceMode: "dynamic",
        accessModel: "permissionless-onchain",
        settlementModel: "atomic",
      }),
    ).toBe(false);
  });

  it("returns false when the live capacity kind is proxy or queue evidence", () => {
    expect(isStrongLiveDirectRoute({ ...strongInput, capacityKind: "live-proxy-validated" })).toBe(false);
    expect(isStrongLiveDirectRoute({ ...strongInput, capacityKind: "live-queue" })).toBe(false);
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
