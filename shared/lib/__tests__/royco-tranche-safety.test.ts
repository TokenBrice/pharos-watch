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
    // senior slope=0.6, cap=20; junior slope=1.2, cap=30
    it("applies senior drawdown penalty: slope 0.6 per 1% drawdown, capped at 20", () => {
      // 10% drawdown → 10 * 0.6 = 6 penalty contribution (below cap)
      const r6 = computeRoycoDawnTrancheSafetyScore({
        underlyingSafetyScore: 100,
        sourceRisk: { ...baseRisk, trancheSide: "senior", marketDrawdownRatio: 0.1 },
      });
      expect(r6).not.toBeNull();
      // Record base penalty (no drawdown) then diff
      const rBase = computeRoycoDawnTrancheSafetyScore({
        underlyingSafetyScore: 100,
        sourceRisk: { ...baseRisk, trancheSide: "senior", marketDrawdownRatio: 0 },
      });
      expect(r6!.penalty - rBase!.penalty).toBe(6);

      // 40% drawdown → would be 24 but capped at 20
      const rCap = computeRoycoDawnTrancheSafetyScore({
        underlyingSafetyScore: 100,
        sourceRisk: { ...baseRisk, trancheSide: "senior", marketDrawdownRatio: 0.4 },
      });
      expect(rCap!.penalty - rBase!.penalty).toBe(20);
    });

    it("applies junior drawdown penalty: slope 1.2 per 1% drawdown, capped at 30", () => {
      // 10% drawdown → 10 * 1.2 = 12 penalty contribution (below cap)
      const rBase = computeRoycoDawnTrancheSafetyScore({
        underlyingSafetyScore: 100,
        sourceRisk: { ...baseRisk, trancheSide: "junior", marketDrawdownRatio: 0 },
      });
      const r12 = computeRoycoDawnTrancheSafetyScore({
        underlyingSafetyScore: 100,
        sourceRisk: { ...baseRisk, trancheSide: "junior", marketDrawdownRatio: 0.1 },
      });
      expect(r12!.penalty - rBase!.penalty).toBe(12);

      // 30% drawdown → would be 36 but capped at 30
      const rCap = computeRoycoDawnTrancheSafetyScore({
        underlyingSafetyScore: 100,
        sourceRisk: { ...baseRisk, trancheSide: "junior", marketDrawdownRatio: 0.3 },
      });
      expect(rCap!.penalty - rBase!.penalty).toBe(30);
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
