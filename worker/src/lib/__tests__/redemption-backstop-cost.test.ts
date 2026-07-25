import { describe, expect, it } from "vitest";
import { getRedemptionBackstopConfig } from "@shared/lib/redemption-backstops";
import {
  REDEMPTION_FEE_SCORE_BREAKPOINTS,
  resolveCostScenarioScores,
  resolveBoundedFeeScore,
  resolveRedemptionStaticFields,
} from "../redemption-backstop-cost";

describe("resolveBoundedFeeScore", () => {
  it("scores 0 bps as 100", () => {
    expect(resolveBoundedFeeScore(0)).toBe(100);
  });

  it("scores exactly 10 bps as 100 (top of <=10 bucket)", () => {
    expect(resolveBoundedFeeScore(10)).toBe(100);
  });

  it("scores 11 bps as 80 (first step below 100)", () => {
    expect(resolveBoundedFeeScore(11)).toBe(80);
  });

  it("scores 25 bps as 80", () => {
    expect(resolveBoundedFeeScore(25)).toBe(80);
  });

  it("scores exactly 50 bps as 80 (top of <=50 bucket)", () => {
    expect(resolveBoundedFeeScore(50)).toBe(80);
  });

  it("scores 51 bps as 60 (first step below 80)", () => {
    expect(resolveBoundedFeeScore(51)).toBe(60);
  });

  it("scores 75 bps as 60", () => {
    expect(resolveBoundedFeeScore(75)).toBe(60);
  });

  it("scores exactly 100 bps as 60 (top of <=100 bucket)", () => {
    expect(resolveBoundedFeeScore(100)).toBe(60);
  });

  it("scores 101 bps as 40 (first step below 60)", () => {
    expect(resolveBoundedFeeScore(101)).toBe(40);
  });

  it("scores 200 bps as 40", () => {
    expect(resolveBoundedFeeScore(200)).toBe(40);
  });

  it("scores 500 bps as 40 (no floor below 40)", () => {
    expect(resolveBoundedFeeScore(500)).toBe(40);
  });
});

describe("REDEMPTION_FEE_SCORE_BREAKPOINTS", () => {
  it("drives resolveBoundedFeeScore consistently", () => {
    expect(resolveBoundedFeeScore(0)).toBe(100);
    for (const bp of REDEMPTION_FEE_SCORE_BREAKPOINTS) {
      expect(resolveBoundedFeeScore(bp.maxFeeBps)).toBe(bp.score);
    }
    const topBreakpoint =
      REDEMPTION_FEE_SCORE_BREAKPOINTS[REDEMPTION_FEE_SCORE_BREAKPOINTS.length - 1];
    expect(resolveBoundedFeeScore(topBreakpoint.maxFeeBps + 1)).toBe(40);
  });
});

describe("resolveCostScenarioScores", () => {
  it("makes high flat fees expensive for retail users", () => {
    const scores = resolveCostScenarioScores(
      {
        kind: "fee-bps",
        feeBps: 0,
        flatFeeUsd: 25,
      },
      0,
    );

    expect(scores?.retail).toBe(40);
    expect(scores?.activeUser).toBe(80);
    expect(scores?.institutional).toBe(100);
  });

  it("uses documented fee ranges for scenario scoring", () => {
    const scores = resolveCostScenarioScores(
      {
        kind: "dynamic-or-unclear",
        confidence: "formula",
        feeBpsMin: 5,
        feeBpsMax: 75,
        feeDescription: "5-75 bps depending on utilization",
      },
      null,
    );

    expect(scores?.activeUser).toBe(60);
    expect(scores?.institutional).toBe(60);
  });
});

describe("V8 compatibility", () => {
  it("does not apply V9-only USDT route terms to legacy cost scenarios", () => {
    const config = getRedemptionBackstopConfig("usdt-tether")!;
    const fields = resolveRedemptionStaticFields("usdt-tether", config, {
      accessScore: 100,
      settlementScore: 100,
      executionCertaintyScore: 100,
      outputAssetQualityScore: 100,
    });

    expect(config.costModel).not.toHaveProperty("minFeeUsd");
    expect(fields).toMatchObject({
      costScore: 100,
      feeBps: null,
      costScenarioScores: {
        retail: 100,
        activeUser: 100,
        institutional: 100,
      },
    });
  });
});
