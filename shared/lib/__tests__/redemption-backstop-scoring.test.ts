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

describe("computeCapacityScore", () => {
  it("returns null when both inputs are null", () => {
    const result = computeCapacityScore({ immediateCapacityUsd: null, immediateCapacityRatio: null });
    expect(result.score).toBeNull();
    expect(result.coverageRatioScore).toBeNull();
    expect(result.absoluteCapacityScore).toBeNull();
  });

  it.each([[0, 0], [0.01, 20], [0.05, 40], [0.1, 60], [0.25, 80], [0.5, 100]])(
    "scores coverage ratio %s as %s",
    (immediateCapacityRatio, expected) => {
      expect(computeCapacityScore({ immediateCapacityUsd: null, immediateCapacityRatio }).coverageRatioScore).toBe(expected);
    },
  );

  it("interpolates between breakpoints", () => {
    // ratio=0.075 → between 0.05(40) and 0.10(60), midpoint = 50
    const mid = computeCapacityScore({ immediateCapacityUsd: null, immediateCapacityRatio: 0.075 });
    expect(mid.coverageRatioScore).toBe(50);
  });

  it.each([
    [250_000_000, 0, 40],
    [0, 0.5, 60],
    [1_000_000, 0.25, 64],
  ])("blends USD %s and ratio %s into %s", (immediateCapacityUsd, immediateCapacityRatio, expected) => {
    expect(computeCapacityScore({ immediateCapacityUsd, immediateCapacityRatio }).score).toBe(expected);
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

  it.each([[100_000, 20], [1_000_000, 40], [10_000_000, 60], [50_000_000, 80], [250_000_000, 100]])(
    "scores absolute capacity %s as %s",
    (immediateCapacityUsd, expected) => {
      expect(computeCapacityScore({ immediateCapacityUsd, immediateCapacityRatio: null }).absoluteCapacityScore).toBe(expected);
    },
  );

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

    // 80 × .75 × .65 × .9 × .85 = 29.835, rounded only at the end.
    expect(result.score).toBe(30);
    expect(result.capsApplied).toEqual([
      "settlement-delay-penalty",
      "queue-depth-penalty",
      "minimum-size-penalty",
      "live-holder-eligibility-penalty",
    ]);
  });

  it.each([
    [3_600, 100, []],
    [3_601, 90, ["settlement-delay-penalty"]],
    [86_401, 75, ["settlement-delay-penalty"]],
    [604_801, 60, ["settlement-delay-penalty"]],
  ])("applies delay %s at its band", (settlementDelaySec, score, capsApplied) => {
    expect(applyCapacityConstraintScoreEffects({
      capacityScore: 100, scoringCapacityUsd: 10_000_000, settlementDelaySec,
    })).toEqual({ score, capsApplied });
  });

  it.each([
    [9_999, 100, []],
    [10_000, 90, ["minimum-size-penalty"]],
    [1_000_000, 75, ["minimum-size-penalty"]],
  ])("applies minimum %s at its band", (minRedeemUsd, score, capsApplied) => {
    expect(applyCapacityConstraintScoreEffects({
      capacityScore: 100, scoringCapacityUsd: 10_000_000, minRedeemUsd,
    })).toEqual({ score, capsApplied });
  });

  it("applies queue depth independently of other telemetry", () => {
    expect(applyCapacityConstraintScoreEffects({
      capacityScore: 80, scoringCapacityUsd: 10_000_000, queueDepthUsd: 12_000_000,
    })).toEqual({ score: 52, capsApplied: ["queue-depth-penalty"] });
  });

  it("applies holder eligibility independently of other telemetry", () => {
    expect(applyCapacityConstraintScoreEffects({
      capacityScore: 80, scoringCapacityUsd: 10_000_000, liveHolderEligibility: "whitelisted-primary",
    })).toEqual({ score: 68, capsApplied: ["live-holder-eligibility-penalty"] });
  });

  it.each([null, 0])("does not divide queue depth by capacity %s", (scoringCapacityUsd) => {
    expect(applyCapacityConstraintScoreEffects({
      capacityScore: 80, scoringCapacityUsd, queueDepthUsd: 12_000_000,
    })).toEqual({ score: 80, capsApplied: [] });
  });

  it("preserves an unrated capacity under adverse telemetry", () => {
    expect(applyCapacityConstraintScoreEffects({
      capacityScore: null, scoringCapacityUsd: 10_000_000,
      settlementDelaySec: 172_800, queueDepthUsd: 12_000_000,
      minRedeemUsd: 100_000, liveHolderEligibility: "whitelisted-primary",
    })).toEqual({ score: null, capsApplied: [] });
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

  it.each([
    ["accessScore", 20],
    ["settlementScore", 15],
    ["executionCertaintyScore", 15],
    ["capacityScore", 25],
    ["outputAssetQualityScore", 15],
    ["costScore", 10],
  ] as const)("weights %s independently", (component, expected) => {
    expect(computeRedemptionBackstopScore({
      routeFamily: "stablecoin-redeem",
      accessScore: 0, settlementScore: 0, executionCertaintyScore: 0,
      capacityScore: 0, outputAssetQualityScore: 0, costScore: 0,
      [component]: 100,
    })).toEqual({ score: expected, capsApplied: [] });
  });

  it("floors a measured zero-capacity route at zero", () => {
    const result = computeRedemptionBackstopScore({
      routeFamily: "stablecoin-redeem",
      accessScore: 100,
      settlementScore: 100,
      executionCertaintyScore: 100,
      capacityScore: 0,
      outputAssetQualityScore: 100,
      costScore: 100,
      executableCapacityUsd: 0,
      modeledExitSizeUsd: 1_000_000,
    });
    expect(result).toEqual({ score: 0, capsApplied: ["zero-executable-capacity"] });
  });

  it("floors capacity below both shared materiality bands at zero", () => {
    const result = computeRedemptionBackstopScore({
      routeFamily: "stablecoin-redeem",
      accessScore: 100,
      settlementScore: 100,
      executionCertaintyScore: 100,
      capacityScore: 10,
      outputAssetQualityScore: 100,
      costScore: 100,
      executableCapacityUsd: 9_999,
      modeledExitSizeUsd: 1_000_000,
    });
    expect(result).toEqual({ score: 0, capsApplied: ["immaterial-executable-capacity"] });
  });

  it("admits capacity reaching the shared relative materiality band", () => {
    const result = computeRedemptionBackstopScore({
      routeFamily: "stablecoin-redeem",
      accessScore: 100,
      settlementScore: 100,
      executionCertaintyScore: 100,
      capacityScore: 20,
      outputAssetQualityScore: 100,
      costScore: 100,
      executableCapacityUsd: 10_000,
      modeledExitSizeUsd: 1_000_000,
    });
    expect(result.score).toBeGreaterThan(0);
    expect(result.capsApplied).not.toContain("immaterial-executable-capacity");
  });

  it("uses the absolute materiality band when supply cannot define a modeled request", () => {
    const below = computeRedemptionBackstopScore({
      routeFamily: "stablecoin-redeem",
      accessScore: 100,
      settlementScore: 100,
      executionCertaintyScore: 100,
      capacityScore: 10,
      outputAssetQualityScore: 100,
      costScore: 100,
      executableCapacityUsd: 99_999,
      modeledExitSizeUsd: null,
    });
    const atFloor = computeRedemptionBackstopScore({
      routeFamily: "stablecoin-redeem",
      accessScore: 100,
      settlementScore: 100,
      executionCertaintyScore: 100,
      capacityScore: 20,
      outputAssetQualityScore: 100,
      costScore: 100,
      executableCapacityUsd: 100_000,
      modeledExitSizeUsd: null,
    });
    expect(below).toEqual({ score: 0, capsApplied: ["immaterial-executable-capacity"] });
    expect(atFloor.score).toBeGreaterThan(0);
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
      accessScore: 10,
      settlementScore: 20,
      executionCertaintyScore: 30,
      capacityScore: 40,
      outputAssetQualityScore: 50,
      costScore: 60,
    });
    expect(result.score).toBe(33);
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

  it.each([
    ["queue-redeem", 70, 70, []],
    ["queue-redeem", 71, 70, ["queue-route-cap"]],
    ["offchain-issuer", 65, 65, []],
    ["offchain-issuer", 66, 65, ["offchain-route-cap"]],
  ] as const)("caps %s at input %s", (routeFamily, input, score, capsApplied) => {
    expect(computeRedemptionBackstopScore({
      routeFamily,
      accessScore: input, settlementScore: input, executionCertaintyScore: input,
      capacityScore: input, outputAssetQualityScore: input, costScore: input,
    })).toEqual({ score, capsApplied });
  });

  it.each([
    [50, undefined, 50, ["queue-route-cap", "config-cap"]],
    [90, undefined, 70, ["queue-route-cap"]],
    [50, 0, 0, ["zero-executable-capacity"]],
  ])("resolves config cap %s with executable capacity %s", (totalScoreCap, executableCapacityUsd, score, capsApplied) => {
    expect(computeRedemptionBackstopScore({
      routeFamily: "queue-redeem",
      accessScore: 100, settlementScore: 100, executionCertaintyScore: 100,
      capacityScore: 100, outputAssetQualityScore: 100, costScore: 100,
      totalScoreCap, executableCapacityUsd,
    })).toEqual({ score, capsApplied });
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

  it.each([
    { capacityKind: undefined },
    { capacityKind: "live-proxy-validated" },
    { capacityKind: "live-queue" },
    { capacityConfidence: "live-proxy" },
    { capacityConfidence: "documented-bound" },
    { capacityConfidence: "heuristic" },
    { capacityConfidence: "dynamic" },
    { sourceMode: "estimated" },
    { sourceMode: "static" },
    { accessModel: "whitelisted-onchain" },
    { accessModel: "issuer-api" },
    { accessModel: "manual" },
    { settlementModel: "same-day" },
    { settlementModel: "queued" },
    { settlementModel: "days" },
  ] as const)("rejects independently adverse route evidence %j", (override) => {
    expect(isStrongLiveDirectRoute({ ...strongInput, ...override })).toBe(false);
  });
});
