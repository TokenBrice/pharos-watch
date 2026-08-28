import { describe, it, expect } from "vitest";
import {
  PYS_BENCHMARK_SPREAD_WEIGHT,
  PYS_RISK_PENALTY_FLOOR,
  PYS_RISK_PENALTY_EXPONENT,
  PYS_SUSTAINABILITY_FLOOR,
  PYS_MAX_SOURCE_RISK_PENALTY,
  computePysComponents,
  computePysRewardShare,
  computePYS,
  computeSourceRiskScoreFromPenalty,
  computeVenuePenaltyFromWeighted,
  computeVenueRiskWeighted,
  derivePysSourceRiskPenalty,
  deriveVenueRiskTier,
  resolvePysSourceRiskPenalty,
  PYS_VENUE_PENALTY_SLOPE,
  PYS_VENUE_PENALTY_THRESHOLD,
} from "../yield-scoring";
import { SOURCE_RISK_GOLDEN_ROWS } from "@shared/test-utils/yield-source-risk-golden-fixtures";

describe("PYS constants", () => {
  it("exports benchmark spread weight of 0.25", () => {
    expect(PYS_BENCHMARK_SPREAD_WEIGHT).toBe(0.25);
  });
  it("exports risk penalty floor of 0.5", () => {
    expect(PYS_RISK_PENALTY_FLOOR).toBe(0.5);
  });
  it("exports risk penalty exponent of 1.75", () => {
    expect(PYS_RISK_PENALTY_EXPONENT).toBe(1.75);
  });
  it("exports sustainability floor of 0.3", () => {
    expect(PYS_SUSTAINABILITY_FLOOR).toBe(0.3);
  });
  it("exports max source-risk penalty of 2.5", () => {
    expect(PYS_MAX_SOURCE_RISK_PENALTY).toBe(2.5);
  });
});

describe("computeSourceRiskScoreFromPenalty", () => {
  it("returns null for missing or non-finite penalties", () => {
    expect(computeSourceRiskScoreFromPenalty(null)).toBeNull();
    expect(computeSourceRiskScoreFromPenalty(undefined)).toBeNull();
    expect(computeSourceRiskScoreFromPenalty(Number.NaN)).toBeNull();
    expect(computeSourceRiskScoreFromPenalty(Number.POSITIVE_INFINITY)).toBeNull();
  });

  it("maps neutral penalty (1) to 0 and max penalty (2.5) to 100", () => {
    expect(computeSourceRiskScoreFromPenalty(1)).toBe(0);
    expect(computeSourceRiskScoreFromPenalty(PYS_MAX_SOURCE_RISK_PENALTY)).toBe(100);
  });

  it("scales midpoints linearly between neutral and max", () => {
    expect(computeSourceRiskScoreFromPenalty(1.75)).toBe(50);
    expect(computeSourceRiskScoreFromPenalty(1.375)).toBe(25);
  });

  it("clamps below-neutral and above-max penalties to the 0-100 range", () => {
    expect(computeSourceRiskScoreFromPenalty(0)).toBe(0);
    expect(computeSourceRiskScoreFromPenalty(5)).toBe(100);
  });
});

describe("resolvePysSourceRiskPenalty", () => {
  it("keeps missing and invalid penalties neutral", () => {
    expect(resolvePysSourceRiskPenalty(null)).toEqual({
      penalty: 1,
      reason: "missing-neutral",
      provided: false,
    });
    expect(resolvePysSourceRiskPenalty(Number.NaN)).toEqual({
      penalty: 1,
      reason: "invalid-neutral",
      provided: false,
    });
  });

  it("clamps explicit penalties to the supported range", () => {
    expect(resolvePysSourceRiskPenalty(0.25)).toEqual({
      penalty: 1,
      reason: "below-min-clamped",
      provided: true,
    });
    expect(resolvePysSourceRiskPenalty(3)).toEqual({
      penalty: PYS_MAX_SOURCE_RISK_PENALTY,
      reason: "above-max-clamped",
      provided: true,
    });
  });
});

describe("computePysRewardShare", () => {
  it("clamps reward-heavy rows when reward APY exceeds current APY", () => {
    expect(computePysRewardShare(12, 8)).toBe(1);
    expect(computePysRewardShare(4, 8)).toBe(0.5);
  });

  it("keeps invalid or non-positive current APY unmeasured", () => {
    expect(computePysRewardShare(null, 8)).toBeNull();
    expect(computePysRewardShare(1, 0)).toBeNull();
    expect(computePysRewardShare(-1, 8)).toBeNull();
  });
});

describe("derivePysSourceRiskPenalty", () => {
  it("keeps unknown source-risk inputs neutral", () => {
    expect(derivePysSourceRiskPenalty({})).toBe(1);
  });

  it("matches source-risk golden row penalties", () => {
    for (const row of SOURCE_RISK_GOLDEN_ROWS) {
      expect(derivePysSourceRiskPenalty(row.input), row.label).toBeCloseTo(row.expectedDerivedPenalty, 6);
    }
  });

  it("adds measured reward, depth, freshness, switch, bootstrap, and venue penalties", () => {
    expect(derivePysSourceRiskPenalty({
      rewardShare: 0.9,
      sourceDepthRatio: 0.0005,
      sourceAgeSeconds: 7 * 60 * 60,
      sourceSwitchCount30d: 2,
      observationCount30d: 3,
      venueRiskTier: "high",
    })).toBeCloseTo(2.5, 6);
  });
});

describe("PYS source-risk golden rows", () => {
  it("never improves PYS from source-risk penalty alone", () => {
    for (const row of SOURCE_RISK_GOLDEN_ROWS) {
      const apy30d = row.apy30d ?? 8;
      const safetyScore = row.safetyScore === undefined ? 80 : row.safetyScore;
      const neutral = computePYS({
        apy30d,
        safetyScore,
        apyVarianceScore: 0.1,
        scalingFactor: 8,
        sourceRiskPenalty: 1,
      });
      const penalized = computePYS({
        apy30d,
        safetyScore,
        apyVarianceScore: 0.1,
        scalingFactor: 8,
        sourceRiskPenalty: derivePysSourceRiskPenalty(row.input),
      });

      expect(penalized, row.label).toBeLessThanOrEqual(neutral);
    }
  });

  it("keeps missing source-risk evidence neutral and caps extreme derived penalties", () => {
    expect(derivePysSourceRiskPenalty({
      rewardShare: null,
      sourceDepthRatio: null,
      sourceAgeSeconds: null,
      sourceSwitchCount30d: null,
      observationCount30d: null,
      venueRiskTier: "unknown",
    })).toBe(1);
    expect(derivePysSourceRiskPenalty({
      rewardShare: 1,
      sourceDepthRatio: 0.0001,
      sourceAgeSeconds: 24 * 60 * 60,
      sourceSwitchCount30d: 10,
      observationCount30d: 1,
      venueRiskTier: "high",
    })).toBe(PYS_MAX_SOURCE_RISK_PENALTY);
  });

  it("keeps zero and negative APY at PYS 0 even with source-risk penalties", () => {
    for (const apy30d of [0, -1]) {
      expect(computePYS({
        apy30d,
        safetyScore: 80,
        apyVarianceScore: 0,
        scalingFactor: 8,
        sourceRiskPenalty: PYS_MAX_SOURCE_RISK_PENALTY,
      })).toBe(0);
    }
  });
});

describe("venue-risk rubric (yield v8.3)", () => {
  it("exports the calibration-preserving penalty curve constants", () => {
    expect(PYS_VENUE_PENALTY_THRESHOLD).toBe(2.0);
    expect(PYS_VENUE_PENALTY_SLOPE).toBe(0.15);
  });

  it("weights the five category sub-scores per the Yearn rubric", () => {
    expect(
      computeVenueRiskWeighted({ audits: 5, centralization: 5, fundsManagement: 5, liquidity: 5, operational: 5 }),
    ).toBeCloseTo(5, 6);
    expect(
      computeVenueRiskWeighted({ audits: 1, centralization: 1, fundsManagement: 1, liquidity: 1, operational: 1 }),
    ).toBeCloseTo(1, 6);
    // 0.2*2 + 0.3*4 + 0.3*3 + 0.15*2 + 0.05*2 = 2.9 (morpho-blue shape)
    expect(
      computeVenueRiskWeighted({ audits: 2, centralization: 4, fundsManagement: 3, liquidity: 2, operational: 2 }),
    ).toBeCloseTo(2.9, 6);
  });

  it("maps weighted scores to the coarse tier (Minimal+Low→low, Medium→medium, Elevated+High→high)", () => {
    expect(deriveVenueRiskTier(1.3)).toBe("low");
    expect(deriveVenueRiskTier(2.49)).toBe("low");
    expect(deriveVenueRiskTier(2.5)).toBe("medium");
    expect(deriveVenueRiskTier(3.49)).toBe("medium");
    expect(deriveVenueRiskTier(3.5)).toBe("high");
    expect(deriveVenueRiskTier(4.7)).toBe("high");
    expect(deriveVenueRiskTier(null)).toBe("unknown");
    expect(deriveVenueRiskTier(Number.NaN)).toBe("unknown");
  });

  it("applies a continuous, calibration-preserving penalty curve", () => {
    expect(computeVenuePenaltyFromWeighted(1.5)).toBe(0); // blue-chip no-op
    expect(computeVenuePenaltyFromWeighted(2.0)).toBe(0); // threshold
    expect(computeVenuePenaltyFromWeighted(3.0)).toBeCloseTo(0.15, 6); // legacy medium
    expect(computeVenuePenaltyFromWeighted(4.0)).toBeCloseTo(0.3, 6);
    expect(computeVenuePenaltyFromWeighted(5.0)).toBeCloseTo(0.45, 6);
    expect(computeVenuePenaltyFromWeighted(null)).toBe(0);
  });

  it("prefers the weighted curve over the legacy tier branch when a weighted score is present", () => {
    // weighted 4.4 (clearpool) → +0.36 even though tier would coarsely be "high"
    expect(derivePysSourceRiskPenalty({ venueRiskWeighted: 4.4 })).toBeCloseTo(1.36, 6);
    // absent weighted → legacy tier branch still applies (rollback-safe)
    expect(derivePysSourceRiskPenalty({ venueRiskTier: "high" })).toBeCloseTo(1.35, 6);
    expect(derivePysSourceRiskPenalty({ venueRiskTier: "medium" })).toBeCloseTo(1.15, 6);
  });

  it("adds reviewer-set dependency-concentration penalties", () => {
    expect(derivePysSourceRiskPenalty({ dependencyConcentrationSeverity: "low" })).toBe(1);
    expect(derivePysSourceRiskPenalty({ dependencyConcentrationSeverity: "medium" })).toBeCloseTo(1.1, 6);
    expect(derivePysSourceRiskPenalty({ dependencyConcentrationSeverity: "high" })).toBeCloseTo(1.2, 6);
  });
});

describe("computePysComponents", () => {
  it("computes riskPenalty from safety score", () => {
    const result = computePysComponents({ apy30d: 5, safetyScore: 80, apyVarianceScore: 0.2 });
    expect(result.riskPenalty).toBeCloseTo((101 - 80) / 20); // 1.05
  });

  it("raises the risk penalty by the configured exponent before computing yield efficiency", () => {
    const result = computePysComponents({ apy30d: 5, safetyScore: 80, apyVarianceScore: 0.2 });
    expect(result.adjustedRiskPenalty).toBeCloseTo(Math.pow(1.05, 1.75), 6);
    expect(result.yieldEfficiency).toBeCloseTo(5 / Math.pow(1.05, 1.75), 6);
  });

  it("adds a weighted slice of benchmark spread to the effective yield", () => {
    const result = computePysComponents({ apy30d: 4.1, benchmarkRate: 1.9358, safetyScore: 68, apyVarianceScore: 0.09 });
    expect(result.benchmarkSpread).toBeCloseTo(2.1642, 4);
    expect(result.benchmarkAdjustment).toBeCloseTo(2.1642 * 0.25, 4);
    expect(result.effectiveYield).toBeCloseTo(4.1 + 2.1642 * 0.25, 4);
  });

  it("floors riskPenalty at 0.5", () => {
    const result = computePysComponents({ apy30d: 5, safetyScore: 100, apyVarianceScore: 0 });
    expect(result.riskPenalty).toBe(0.5); // (101-100)/20 = 0.05, floored to 0.5
  });

  it("defaults null safetyScore to 40", () => {
    const result = computePysComponents({ apy30d: 5, safetyScore: null, apyVarianceScore: 0 });
    expect(result.riskPenalty).toBeCloseTo((101 - 40) / 20); // 3.05
  });

  it("floors sustainabilityMultiplier at 0.3", () => {
    const result = computePysComponents({ apy30d: 5, safetyScore: 80, apyVarianceScore: 0.9 });
    expect(result.sustainabilityMultiplier).toBe(0.3); // 1.0 - 0.9 = 0.1, floored to 0.3
  });

  it("applies explicit source-risk penalty after effective yield and before safety scaling", () => {
    const neutral = computePysComponents({ apy30d: 8, safetyScore: 80, apyVarianceScore: 0.1 });
    const penalized = computePysComponents({
      apy30d: 8,
      safetyScore: 80,
      apyVarianceScore: 0.1,
      sourceRiskPenalty: 2,
    });

    expect(neutral.sourceRiskPenalty).toBe(1);
    expect(neutral.sourceRiskPenaltyReason).toBe("missing-neutral");
    expect(penalized.sourceRiskPenalty).toBe(2);
    expect(penalized.rowUtility).toBeCloseTo(neutral.effectiveYield / 2, 6);
    expect(penalized.yieldEfficiency).toBeCloseTo(neutral.yieldEfficiency / 2, 6);
  });
});

describe("computePYS", () => {
  it("returns 0 for non-positive APY", () => {
    expect(computePYS({ apy30d: 0, safetyScore: 80, apyVarianceScore: 0, scalingFactor: 1 })).toBe(0);
    expect(computePYS({ apy30d: -1, safetyScore: 80, apyVarianceScore: 0, scalingFactor: 1 })).toBe(0);
    expect(computePYS({ apy30d: Number.NaN, safetyScore: 80, apyVarianceScore: 0, scalingFactor: 1 })).toBe(0);
  });

  it("caps at 100", () => {
    const result = computePYS({ apy30d: 500, safetyScore: 100, apyVarianceScore: 0, scalingFactor: 10 });
    expect(result).toBe(100);
  });

  it("keeps missing source-risk neutral and applies capped explicit penalties", () => {
    const neutral = computePYS({ apy30d: 12, safetyScore: 80, apyVarianceScore: 0.1, scalingFactor: 8 });
    const missing = computePYS({
      apy30d: 12,
      safetyScore: 80,
      apyVarianceScore: 0.1,
      scalingFactor: 8,
      sourceRiskPenalty: null,
    });
    const penalized = computePYS({
      apy30d: 12,
      safetyScore: 80,
      apyVarianceScore: 0.1,
      scalingFactor: 8,
      sourceRiskPenalty: 2.5,
    });
    const overCap = computePYS({
      apy30d: 12,
      safetyScore: 80,
      apyVarianceScore: 0.1,
      scalingFactor: 8,
      sourceRiskPenalty: 99,
    });

    expect(missing).toBe(neutral);
    expect(penalized).toBeLessThan(neutral);
    expect(overCap).toBe(penalized);
  });

  it("rewards rows that outperform their benchmark", () => {
    const base = computePYS({ apy30d: 4.1, safetyScore: 68, apyVarianceScore: 0.09, scalingFactor: 8 });
    const benchmarkAware = computePYS({
      apy30d: 4.1,
      safetyScore: 68,
      apyVarianceScore: 0.09,
      scalingFactor: 8,
      benchmarkRate: 1.9358,
    });
    expect(benchmarkAware).toBeGreaterThan(base);
  });

  it("drops to zero when benchmark adjustment makes effective yield non-positive", () => {
    const result = computePYS({
      apy30d: 1,
      safetyScore: 80,
      apyVarianceScore: 0,
      scalingFactor: 8,
      benchmarkRate: 8,
    });
    expect(result).toBe(0);
  });

  it("handles non-USD benchmark rows and missing safety with neutral source risk", () => {
    const result = computePYS({
      apy30d: 3,
      safetyScore: null,
      apyVarianceScore: 0.2,
      scalingFactor: 8,
      benchmarkRate: 0.5,
    });

    expect(result).toBeGreaterThan(0);
    expect(result).toBeLessThanOrEqual(100);
  });

  it("returns 0 for non-positive or invalid scaling", () => {
    expect(computePYS({ apy30d: 5, safetyScore: 80, apyVarianceScore: 0, scalingFactor: 0 })).toBe(0);
    expect(computePYS({ apy30d: 5, safetyScore: 80, apyVarianceScore: 0, scalingFactor: Number.NaN })).toBe(0);
  });

  it("applies scaling factor", () => {
    const base = computePYS({ apy30d: 5, safetyScore: 80, apyVarianceScore: 0.1, scalingFactor: 1 });
    const scaled = computePYS({ apy30d: 5, safetyScore: 80, apyVarianceScore: 0.1, scalingFactor: 2 });
    expect(scaled).toBeGreaterThan(base);
  });

  it("matches the published methodology example for benchmark-aware source-risk PYS", () => {
    expect(computePYS({
      apy30d: 8.4,
      benchmarkRate: 4.25,
      safetyScore: 72,
      sourceRiskPenalty: 1.2,
      apyVarianceScore: 0.18,
      scalingFactor: 8,
    })).toBe(27);
  });
});
