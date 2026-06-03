import { describe, expect, it } from "vitest";
import { resolveReportCardYieldRiskAdjustment } from "../report-card-yield-risk";

describe("resolveReportCardYieldRiskAdjustment", () => {
  it("keeps non-yield-bearing assets neutral", () => {
    const adjustment = resolveReportCardYieldRiskAdjustment({
      flags: { yieldBearing: false, navToken: false },
      sourceRisk: {
        sourceRiskPenalty: 1.8,
        rewardShare: 0.95,
        venueRiskTier: "high",
      },
    });

    expect(adjustment).toMatchObject({
      appliesToBaseScore: false,
      scoreModifier: null,
      resilienceCap: null,
      dependencyRiskCap: null,
      reason: "not-yield-bearing",
    });
  });

  it("keeps external lending opportunities out of the base Safety Score", () => {
    const adjustment = resolveReportCardYieldRiskAdjustment({
      flags: { yieldBearing: false, navToken: false },
      yieldType: "lending-opportunity",
      sourceRisk: {
        sourceRiskPenalty: 1.8,
        rewardShare: 0.95,
        venueRiskTier: "high",
      },
    });

    expect(adjustment).toMatchObject({
      appliesToBaseScore: false,
      scoreModifier: null,
      resilienceCap: null,
      dependencyRiskCap: null,
      reason: "external-lending-opportunity",
    });
  });

  it("keeps external structured tranches out of the base Safety Score", () => {
    const adjustment = resolveReportCardYieldRiskAdjustment({
      flags: { yieldBearing: true, navToken: true },
      yieldType: "structured-tranche",
      sourceRisk: {
        sourceRiskPenalty: 1.2,
        trancheSide: "senior",
        trancheSafetyScore: 60,
      },
    });

    expect(adjustment).toMatchObject({
      appliesToBaseScore: false,
      scoreModifier: null,
      resilienceCap: null,
      dependencyRiskCap: null,
      reason: "external-structured-tranche",
    });
  });

  it("keeps yield-bearing rows without a yield config neutral", () => {
    const adjustment = resolveReportCardYieldRiskAdjustment({
      flags: { yieldBearing: true, navToken: false },
      sourceRisk: {
        sourceRiskPenalty: 1.4,
        rewardShare: 0.9,
        venueRiskTier: "medium",
      },
    });

    expect(adjustment).toMatchObject({
      appliesToBaseScore: false,
      scoreModifier: null,
      resilienceCap: null,
      dependencyRiskCap: null,
      reason: "missing-yield-config",
    });
  });

  it("returns explicit null behavior for legacy yield-bearing rows without source risk", () => {
    const adjustment = resolveReportCardYieldRiskAdjustment({
      flags: { yieldBearing: true, navToken: false },
      yieldConfig: { yieldType: "rebase" },
      sourceRisk: null,
    });

    expect(adjustment).toMatchObject({
      appliesToBaseScore: false,
      scoreModifier: null,
      resilienceCap: null,
      dependencyRiskCap: null,
      reason: "missing-source-risk",
    });
  });

  it("does not apply wrapper or NAV modifiers while source-risk methodology is unimplemented", () => {
    const adjustment = resolveReportCardYieldRiskAdjustment({
      flags: { yieldBearing: true, navToken: true },
      yieldConfig: { yieldType: "nav-appreciation" },
      sourceRisk: {
        sourceRiskPenalty: 1.6,
        rewardShare: 0.8,
        sourceAgeSeconds: 14 * 24 * 60 * 60,
        venueRiskTier: "high",
        investabilityFlags: ["reward-heavy", "stale-source"],
      },
    });

    expect(adjustment).toMatchObject({
      appliesToBaseScore: false,
      scoreModifier: null,
      resilienceCap: null,
      dependencyRiskCap: null,
      reason: "source-risk-unconsumed",
    });
  });
});
