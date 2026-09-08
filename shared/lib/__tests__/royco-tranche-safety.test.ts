import { describe, expect, it } from "vitest";
import { computeRoycoDawnTrancheSafetyScore } from "../royco-tranche-safety";
import type { YieldSourceRisk } from "../../types/yield";

const baseRisk: YieldSourceRisk = {
  deploymentPlace: "structured-tranche",
  venueProtocol: "royco-dawn",
  venueChain: "ethereum",
  // Venue risk is priced from the canonical weighted score (yield v8.33); the
  // coarse tier is derived from it, never read from storage.
  venueRiskTier: "medium",
  venueRiskWeighted: 3,
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

  it("returns null when tranche side is present without the Royco venue marker", () => {
    expect(
      computeRoycoDawnTrancheSafetyScore({
        underlyingSafetyScore: 82,
        sourceRisk: {
          ...baseRisk,
          deploymentPlace: "structured-tranche",
          venueProtocol: "other-protocol",
          trancheSide: "senior",
        },
      }),
    ).toBeNull();
  });

  describe("venue derivation (yield v8.33)", () => {
    it("prices the venue from the weighted score, ignoring a stored tier that disagrees", () => {
      const derived = computeRoycoDawnTrancheSafetyScore({
        underlyingSafetyScore: 82,
        sourceRisk: { ...baseRisk, trancheSide: "senior", venueRiskTier: "low", venueRiskWeighted: 3 },
      });
      const explicit = computeRoycoDawnTrancheSafetyScore({
        underlyingSafetyScore: 82,
        sourceRisk: { ...baseRisk, trancheSide: "senior" },
      });
      expect(derived?.penalty).toBe(explicit?.penalty);
    });

    it("treats an unbacked tier as unknown when no weighted score resolves", () => {
      // Royco Dawn is not in the reviewed venue registry, so production rows
      // (which publish `venueRiskTier: "unknown"` and no weighted score) land on
      // the unknown band — 1 point below the medium band for a senior tranche.
      const unknownVenue = computeRoycoDawnTrancheSafetyScore({
        underlyingSafetyScore: 82,
        sourceRisk: { ...baseRisk, trancheSide: "senior", venueRiskTier: "medium", venueRiskWeighted: null },
      });
      expect(unknownVenue?.penalty).toBe(5);
    });

    it("accepts an explicitly resolved weighted score from the caller", () => {
      const highVenue = computeRoycoDawnTrancheSafetyScore({
        underlyingSafetyScore: 82,
        sourceRisk: { ...baseRisk, trancheSide: "senior", venueRiskWeighted: null },
        venueRiskWeighted: 4,
      });
      expect(highVenue?.penalty).toBe(11);
    });
  });

  describe("drawdown penalty arithmetic", () => {
    it.each([
      ["senior", 6, 0.4, 20],
      ["junior", 12, 0.3, 30],
    ] as const)("applies %s drawdown slope and cap", (trancheSide, contribution, capRatio, capContribution) => {
      const baseline = computeRoycoDawnTrancheSafetyScore({
        underlyingSafetyScore: 100,
        sourceRisk: { ...baseRisk, trancheSide, marketDrawdownRatio: 0 },
      });
      const uncapped = computeRoycoDawnTrancheSafetyScore({
        underlyingSafetyScore: 100,
        sourceRisk: { ...baseRisk, trancheSide, marketDrawdownRatio: 0.1 },
      });
      const capped = computeRoycoDawnTrancheSafetyScore({
        underlyingSafetyScore: 100,
        sourceRisk: { ...baseRisk, trancheSide, marketDrawdownRatio: capRatio },
      });
      expect(uncapped!.penalty - baseline!.penalty).toBe(contribution);
      expect(capped!.penalty - baseline!.penalty).toBe(capContribution);
    });

    it("returns zero drawdown penalty when marketDrawdownRatio is null", () => {
      const rBase = computeRoycoDawnTrancheSafetyScore({
        underlyingSafetyScore: 100,
        sourceRisk: { ...baseRisk, trancheSide: "senior", marketDrawdownRatio: 0 },
      });
      const rNull = computeRoycoDawnTrancheSafetyScore({
        underlyingSafetyScore: 100,
        sourceRisk: { ...baseRisk, trancheSide: "senior", marketDrawdownRatio: null },
      });
      expect(rNull!.penalty).toBe(rBase!.penalty);
    });
  });
});
