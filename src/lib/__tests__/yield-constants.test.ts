import { describe, expect, it } from "vitest";
import {
  formatYieldWarningSignal,
  getPysColor,
  computePysBreakdown,
} from "@/lib/yield-constants";

describe("formatYieldWarningSignal", () => {
  it("returns the mapped label for known signals", () => {
    expect(formatYieldWarningSignal("yield-spike")).toBe("Yield spike");
    expect(formatYieldWarningSignal("tvl-outflow")).toBe("TVL outflow");
  });

  it("converts unknown signals from kebab-case to space-separated", () => {
    expect(formatYieldWarningSignal("some-new-signal")).toBe("some new signal");
  });
});

describe("getPysColor", () => {
  it("returns muted for null", () => {
    expect(getPysColor(null)).toBe("text-muted-foreground");
  });

  it("returns emerald for scores above 40", () => {
    expect(getPysColor(41)).toContain("emerald");
  });

  it("returns amber for scores between 21 and 40", () => {
    expect(getPysColor(30)).toContain("amber");
  });

  it("returns red for scores 20 or below", () => {
    expect(getPysColor(10)).toContain("red");
  });
});

describe("computePysBreakdown", () => {
  it("computes correct breakdown for typical inputs", () => {
    const {
      riskPenalty,
      adjustedRiskPenalty,
      benchmarkSpread,
      benchmarkAdjustment,
      effectiveYield,
      yieldEfficiency,
      sustainabilityMult,
    } = computePysBreakdown(10, 80, 0.9, 4);
    expect(riskPenalty).toBeCloseTo(1.05, 2);
    expect(adjustedRiskPenalty).toBeCloseTo(Math.pow(1.05, 1.75), 2);
    expect(benchmarkSpread).toBeCloseTo(6, 2);
    expect(benchmarkAdjustment).toBeCloseTo(1.5, 2);
    expect(effectiveYield).toBeCloseTo(11.5, 2);
    expect(yieldEfficiency).toBeCloseTo(11.5 / Math.pow(1.05, 1.75), 1);
    expect(sustainabilityMult).toBeCloseTo(0.9, 2);
  });

  it("uses default safety score of 40 when null", () => {
    const { riskPenalty } = computePysBreakdown(5, null, 0.8);
    expect(riskPenalty).toBeCloseTo((101 - 40) / 20, 2);
  });

  it("clamps risk penalty floor to 0.5", () => {
    const { riskPenalty } = computePysBreakdown(5, 100, 0.8);
    expect(riskPenalty).toBe(0.5);
  });

  it("defaults sustainability to 1.0 when stability is null", () => {
    const { sustainabilityMult } = computePysBreakdown(5, 80, null);
    expect(sustainabilityMult).toBe(1.0);
  });

  it("clamps sustainability floor to 0.3 when stability is very low", () => {
    const { sustainabilityMult } = computePysBreakdown(5, 80, 0.1);
    expect(sustainabilityMult).toBe(0.3);
  });

  it("omits benchmark adjustment when the row has no benchmark metadata", () => {
    const { benchmarkSpread, benchmarkAdjustment, effectiveYield } = computePysBreakdown(5, 80, 0.8);
    expect(benchmarkSpread).toBeNull();
    expect(benchmarkAdjustment).toBe(0);
    expect(effectiveYield).toBe(5);
  });
});
