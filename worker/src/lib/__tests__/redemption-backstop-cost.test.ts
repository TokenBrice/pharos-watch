import { describe, expect, it } from "vitest";
import { getRedemptionBackstopConfig, type RedemptionBackstopConfig, type RedemptionCostModel } from "@shared/lib/redemption-backstops";
import {
  resolveCostScenarioScores,
  resolveBoundedFeeScore,
  resolveRedemptionStaticFields,
} from "../redemption-backstop/cost";
import { readRedemptionBackstopLiveMetadata } from "../redemption-backstop/live-metadata";

describe("resolveBoundedFeeScore", () => {
  it.each([
    [0, 100], [10, 100], [11, 80], [50, 80],
    [51, 60], [100, 60], [101, 40], [500, 40],
  ])("scores %s bps as %s", (feeBps, score) => {
    expect(resolveBoundedFeeScore(feeBps)).toBe(score);
  });
});

describe("resolveCostScenarioScores", () => {
  it("makes high fixed network costs expensive for retail users", () => {
    const scores = resolveCostScenarioScores(
      {
        kind: "fee-bps",
        feeBps: 0,
        gasOrBridgeCostUsd: 25,
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

describe("fractional live fee precision", () => {
  const scores = { accessScore: 100, settlementScore: 100, executionCertaintyScore: 100, outputAssetQualityScore: 100 };
  const config = getRedemptionBackstopConfig("rusd-reservoir")!;

  describe.each([
    { kind: "dynamic-or-unclear", confidence: "formula" },
    { kind: "fee-bps", feeBps: 0 },
  ] satisfies RedemptionCostModel[])("$kind", (costModel) => {
    it.each([0.4, 10, 10.49, 50.49, 100.49])("preserves admitted %s bps in component and scenario scores", (feeBps) => {
      const now = 1_797_120_000;
      const fields = resolveRedemptionStaticFields(
        "rusd-reservoir", { ...config, costModel }, scores, null, now,
        { ...readRedemptionBackstopLiveMetadata("rusd-reservoir", null, now), canUseFee: true, redemptionFeeBps: feeBps },
      );
      const score = resolveBoundedFeeScore(feeBps);
      expect(fields.selectedLiveFee).toBe(true);
      expect(fields.feeBps).toBe(feeBps);
      expect(fields.costScore).toBe(score);
      expect(fields.costScenarioScores).toEqual({ retail: score, activeUser: score, institutional: score });
    });
  });
});

describe("component cost unavailable reasons", () => {
  const now = Date.UTC(2026, 6, 13) / 1_000;
  const scores = { accessScore: 100, settlementScore: 100, executionCertaintyScore: 100, outputAssetQualityScore: 100 };
  const fiatReferences = {
    clockSec: now,
    pegDataById: {
      captured: { pegCurrency: "EUR", pegReference: { valueUsd: 1.25, source: "fx" as const, contributorCount: 0, asOf: now } },
    },
  };
  const baseConfig: RedemptionBackstopConfig = {
    routeFamily: "offchain-issuer", accessModel: "issuer-api", settlementModel: "atomic",
    executionModel: "rules-based-nav", outputAssetType: "stable-single",
    capacityModel: { kind: "fixed-usd", amountUsd: 10_000_000, confidence: "documented-bound" },
    costModel: { kind: "fee-bps", feeBps: 0 },
    docs: [{ label: "Synthetic terms", url: "https://example.com/terms", supports: ["fees"] }],
    reviewedAt: "2026-07-01",
  };

  it.each([
    { currency: "USD", bounded: false, withFx: false, reason: "redemption-cost-percentage-ceiling-absent" },
    { currency: "EUR", bounded: false, withFx: true, reason: "redemption-cost-percentage-ceiling-absent" },
    { currency: "EUR", bounded: false, withFx: false, reason: "redemption-cost-percentage-ceiling-absent" },
    { currency: "EUR", bounded: true, withFx: false, reason: "redemption-cost-fiat-reference-unavailable" },
    { currency: "EUR", bounded: true, withFx: true, reason: null },
    { currency: "USD", bounded: true, withFx: false, reason: null },
  ])("names the cause for $currency, bounded=$bounded, withFx=$withFx", ({ currency, bounded, withFx, reason }) => {
    const costModel: RedemptionCostModel = {
      kind: "dynamic-or-unclear", confidence: "formula",
      feeBpsMin: 5,
      ...(bounded ? { feeBpsMax: 10 } : {}),
      feeComponents: [{ currency, terms: { flatAmount: 1 } }],
    };
    const fields = resolveRedemptionStaticFields(
      "synthetic-fiat-issuer", { ...baseConfig, costModel }, scores, null, now, undefined,
      withFx ? fiatReferences : undefined,
    );
    expect(fields.feeBps).toBeNull();
    expect(fields.notes).toEqual(reason ? [reason] : []);
    if (reason) {
      expect(fields.costScenarioScores).toBeUndefined();
      expect(fields.costScore).toBe(40);
    } else {
      expect(fields.costScenarioScores).toEqual({ retail: 80, activeUser: 80, institutional: 80 });
      expect(fields.costScore).toBe(80);
    }
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
