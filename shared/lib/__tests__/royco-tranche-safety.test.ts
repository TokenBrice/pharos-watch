import { describe, expect, it } from "vitest";
import { computeRoycoDawnTrancheSafetyScore } from "../royco-tranche-safety";
import type { YieldSourceRisk } from "../../types/yield";

const baseRisk: YieldSourceRisk = {
  deploymentPlace: "structured-tranche",
  venueProtocol: "royco-dawn",
  venueChain: "ethereum",
  venueRiskTier: "medium",
  marketStatus: "normal",
  marketCoverageRatio: 0.36,
  marketMinCoverageRatio: 0.15,
  marketUtilizationRatio: 0.41,
  marketUtilizationLimitRatio: 0.9,
  marketDrawdownRatio: 0,
  marketTvlUsd: 4_600_000,
  trancheTvlUsd: 2_900_000,
  kycRequired: true,
  accessRestricted: true,
  investabilityFlags: ["kyc-required", "us-persons-restricted", "withdrawals-underlying-dependent"],
};

describe("computeRoycoDawnTrancheSafetyScore", () => {
  it("caps senior tranche safety below the underlying score without first-loss uplift", () => {
    const result = computeRoycoDawnTrancheSafetyScore({
      underlyingSafetyScore: 82,
      sourceRisk: {
        ...baseRisk,
        trancheSide: "senior",
      },
    });

    expect(result).not.toBeNull();
    expect(result?.score).toBeLessThanOrEqual(82);
    expect(result?.score).toBe(76);
    expect(result?.penalty).toBe(6);
  });

  it("materially penalizes junior tranche safety when utilization is high", () => {
    const result = computeRoycoDawnTrancheSafetyScore({
      underlyingSafetyScore: 82,
      sourceRisk: {
        ...baseRisk,
        trancheSide: "junior",
        marketCoverageRatio: 0.08,
        marketMinCoverageRatio: 0.1,
        marketUtilizationRatio: 0.78,
        marketUtilizationLimitRatio: 0.9,
        trancheTvlUsd: 600_000,
      },
    });

    expect(result).not.toBeNull();
    expect(result?.score).toBe(22);
    expect(result?.penalty).toBe(60);
  });

  it("returns null for non-tranche rows", () => {
    expect(
      computeRoycoDawnTrancheSafetyScore({
        underlyingSafetyScore: 82,
        sourceRisk: {
          ...baseRisk,
          trancheSide: null,
        },
      }),
    ).toBeNull();
  });

  it("returns null when tranche side is present without Royco tranche markers", () => {
    expect(
      computeRoycoDawnTrancheSafetyScore({
        underlyingSafetyScore: 82,
        sourceRisk: {
          ...baseRisk,
          deploymentPlace: "lending-market",
          venueProtocol: "other-protocol",
          trancheSide: "senior",
        },
      }),
    ).toBeNull();
  });
});
