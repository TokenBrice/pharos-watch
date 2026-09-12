import { describe, expect, it } from "vitest";
import {
  formatYieldWarningSignal,
  getPysColor,
  formatYieldRatioPercent,
  resolveYieldScoreQualification,
  computePysBreakdown,
} from "@/lib/yield-constants";
import { computePysComponents, yieldStabilityToApyVarianceScore } from "@shared/lib/yield-scoring";

describe("formatYieldWarningSignal", () => {
  it("returns the mapped label for known signals", () => {
    expect(formatYieldWarningSignal("yield-spike")).toBe("Yield spike");
    expect(formatYieldWarningSignal("tvl-outflow")).toBe("TVL outflow");
    expect(formatYieldWarningSignal("opportunity-evidence-missing")).toBe("Opportunity evidence incomplete");
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

  it("includes v8 source-risk penalty in the displayed breakdown", () => {
    const breakdown = computePysBreakdown(8, 80, 0.9, 4, 2);
    const expected = computePysComponents({
      apy30d: 8,
      safetyScore: 80,
      apyVarianceScore: yieldStabilityToApyVarianceScore(0.9),
      benchmarkRate: 4,
      sourceRiskPenalty: 2,
    });


    expect(breakdown.sourceRiskPenalty).toBe(2);
    expect(breakdown.rowUtility).toBeCloseTo(expected.rowUtility, 6);
    expect(breakdown.yieldEfficiency).toBeCloseTo(expected.yieldEfficiency, 6);
  });
});

describe("computePysBreakdown benchmarkCurrency (USD_EFFR re-base)", () => {
  it("re-bases a foreign-benchmark row onto the USD reference", () => {
    const { hurdleRebase } = computePysBreakdown(5, 80, 0.9, 0.4, null, 3.95, "CHF");
    expect(hurdleRebase).toBeCloseTo(3.55, 6);
  });

  it("takes no re-base on a USD-benchmarked row (USD_EFFR key)", () => {
    // EFFR row: benchmarkRate and the USD reference are both USD rates, so
    // the spread between them must not be credited as excess yield.
    const { hurdleRebase, effectiveYield } = computePysBreakdown(4.32, 80, 0.9, 4.32, null, 3.95, "USD");
    expect(hurdleRebase).toBe(0);
    expect(effectiveYield).toBeCloseTo(4.32, 6);
  });
});

describe("formatYieldRatioPercent", () => {
  it("scales a 0-1 ratio to a whole-number percent and fails unknowns closed", () => {
    expect(formatYieldRatioPercent(0.923)).toBe(92);
    expect(formatYieldRatioPercent(null)).toBe("unknown");
    expect(formatYieldRatioPercent(undefined)).toBe("unknown");
    expect(formatYieldRatioPercent(Number.NaN)).toBe("unknown");
  });
});

describe("resolveYieldScoreQualification", () => {
  it("falls back to NR/rated from score presence", () => {
    expect(resolveYieldScoreQualification({ pharosYieldScore: null })).toBe("NR");
    expect(resolveYieldScoreQualification({ pharosYieldScore: 50 })).toBe("rated");
    expect(
      resolveYieldScoreQualification({ pharosYieldScore: 50, provenance: { scoreQualification: "partial" } }),
    ).toBe("partial");
  });
});
