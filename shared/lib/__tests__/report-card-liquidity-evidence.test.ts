import { describe, expect, it } from "vitest";
import { applyReportCardDexEvidencePolicy } from "../report-card-liquidity-evidence";

describe("report-card DEX evidence policy", () => {
  it("keeps legacy snapshots neutral until evidence fields are republished", () => {
    expect(applyReportCardDexEvidencePolicy({ liquidityScore: 92 })).toEqual({
      observedScore: 92,
      effectiveScore: 92,
      evidenceKind: null,
      scoreCeiling: null,
      reason: null,
      legacyNeutral: true,
    });

    expect(
      applyReportCardDexEvidencePolicy({
        liquidityScore: 92,
        coverageClass: "legacy",
        coverageConfidence: 0.5,
        liquidityEvidenceClass: "observed_unmeasured",
        hasMeasuredLiquidityEvidence: false,
      }),
    ).toEqual({
      observedScore: 92,
      effectiveScore: 92,
      evidenceKind: null,
      scoreCeiling: null,
      reason: null,
      legacyNeutral: true,
    });
  });

  it("caps fallback and generic TVL proxy observations", () => {
    expect(
      applyReportCardDexEvidencePolicy({
        liquidityScore: 90,
        coverageClass: "fallback",
        coverageConfidence: 0.9,
        liquidityEvidenceClass: "observed_unmeasured",
        hasMeasuredLiquidityEvidence: false,
      }),
    ).toMatchObject({
      effectiveScore: 55,
      evidenceKind: "synthetic-or-fallback",
      scoreCeiling: 55,
    });

    expect(
      applyReportCardDexEvidencePolicy({
        liquidityScore: 90,
        coverageClass: "mixed",
        coverageConfidence: 0.7,
        liquidityEvidenceClass: "observed_unmeasured",
        hasMeasuredLiquidityEvidence: false,
      }),
    ).toMatchObject({
      effectiveScore: 60,
      evidenceKind: "generic-tvl-proxy",
      scoreCeiling: 60,
    });
  });

  it("recognizes measured reserve simulation without calling it executable depth", () => {
    expect(
      applyReportCardDexEvidencePolicy({
        liquidityScore: 93,
        coverageClass: "primary",
        coverageConfidence: 0.95,
        liquidityEvidenceClass: "measured",
        hasMeasuredLiquidityEvidence: true,
        balanceMeasuredTvlUsd: 10_000_000,
      }),
    ).toMatchObject({
      effectiveScore: 85,
      evidenceKind: "reserve-based-amm-simulation",
      scoreCeiling: 85,
    });
  });

  it("applies the inaccessible-only ceiling without penalizing partial deployment gaps", () => {
    const base = {
      liquidityScore: 80,
      coverageClass: "primary" as const,
      coverageConfidence: 0.95,
      liquidityEvidenceClass: "measured" as const,
      hasMeasuredLiquidityEvidence: true,
      balanceMeasuredTvlUsd: 1_000_000,
    };
    expect(
      applyReportCardDexEvidencePolicy({
        ...base,
        deploymentCoverage: { observedPools: 0, verifiedNoPools: 0, providerInaccessible: 2 },
      }).effectiveScore,
    ).toBe(45);
    expect(
      applyReportCardDexEvidencePolicy({
        ...base,
        deploymentCoverage: { observedPools: 1, verifiedNoPools: 0, providerInaccessible: 2 },
      }).effectiveScore,
    ).toBe(80);
    expect(
      applyReportCardDexEvidencePolicy({
        ...base,
        deploymentCoverage: { observedPools: 0, verifiedNoPools: 1, providerInaccessible: 2 },
      }).effectiveScore,
    ).toBe(80);
  });
});
