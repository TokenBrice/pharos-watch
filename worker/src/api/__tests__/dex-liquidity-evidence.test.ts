import { describe, expect, it } from "vitest";
import { classifyLiquidityEvidence } from "../dex-liquidity-evidence";

describe("classifyLiquidityEvidence", () => {
  it("uses one coverage-confidence basis for live and history liquidity evidence", () => {
    expect(classifyLiquidityEvidence(0, "primary", 1)).toEqual({
      liquidityEvidenceClass: "unobserved",
      hasMeasuredLiquidityEvidence: false,
      trendworthy: false,
    });
    expect(classifyLiquidityEvidence(1_000_000, "primary", 0.9)).toEqual({
      liquidityEvidenceClass: "measured",
      hasMeasuredLiquidityEvidence: true,
      trendworthy: true,
    });
    expect(classifyLiquidityEvidence(1_000_000, "mixed", 0.9)).toEqual({
      liquidityEvidenceClass: "partial_measured",
      hasMeasuredLiquidityEvidence: true,
      trendworthy: true,
    });
    expect(classifyLiquidityEvidence(1_000_000, "fallback", 0.5)).toEqual({
      liquidityEvidenceClass: "observed_unmeasured",
      hasMeasuredLiquidityEvidence: false,
      trendworthy: false,
    });
  });
});
