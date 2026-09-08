import { describe, expect, it } from "vitest";
import { getRedemptionBackstopConfig } from "@shared/lib/redemption-backstops";
import {
  resolveCostScenarioScores,
  resolveBoundedFeeScore,
  resolveRedemptionStaticFields,
} from "../redemption-backstop/cost";

describe("resolveBoundedFeeScore", () => {
  it.each([
    [0, 100], [10, 100], [11, 80], [50, 80],
    [51, 60], [100, 60], [101, 40], [500, 40],
  ])("scores %s bps as %s", (feeBps, score) => {
    expect(resolveBoundedFeeScore(feeBps)).toBe(score);
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
