import { describe, it, expect } from "vitest";
import {
  PYS_RISK_PENALTY_FLOOR,
  PYS_RISK_PENALTY_EXPONENT,
  PYS_SUSTAINABILITY_FLOOR,
  computePysComponents,
  computePYS,
} from "../yield-scoring";

describe("PYS constants", () => {
  it("exports risk penalty floor of 0.5", () => {
    expect(PYS_RISK_PENALTY_FLOOR).toBe(0.5);
  });
  it("exports risk penalty exponent of 1.75", () => {
    expect(PYS_RISK_PENALTY_EXPONENT).toBe(1.75);
  });
  it("exports sustainability floor of 0.3", () => {
    expect(PYS_SUSTAINABILITY_FLOOR).toBe(0.3);
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
});

describe("computePYS", () => {
  it("returns 0 for non-positive APY", () => {
    expect(computePYS({ apy30d: 0, safetyScore: 80, apyVarianceScore: 0, scalingFactor: 1 })).toBe(0);
    expect(computePYS({ apy30d: -1, safetyScore: 80, apyVarianceScore: 0, scalingFactor: 1 })).toBe(0);
  });

  it("caps at 100", () => {
    const result = computePYS({ apy30d: 500, safetyScore: 100, apyVarianceScore: 0, scalingFactor: 10 });
    expect(result).toBe(100);
  });

  it("applies scaling factor", () => {
    const base = computePYS({ apy30d: 5, safetyScore: 80, apyVarianceScore: 0.1, scalingFactor: 1 });
    const scaled = computePYS({ apy30d: 5, safetyScore: 80, apyVarianceScore: 0.1, scalingFactor: 2 });
    expect(scaled).toBeGreaterThan(base);
  });

  it("matches the published methodology example for the steeper safety curve", () => {
    expect(computePYS({ apy30d: 8.4, safetyScore: 72, apyVarianceScore: 0.18, scalingFactor: 8 })).toBe(29);
  });
});
