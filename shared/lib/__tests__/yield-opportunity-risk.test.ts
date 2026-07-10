import { describe, expect, it } from "vitest";
import {
  assessYieldOpportunityRisk,
  deriveYieldOpportunityClass,
  type YieldOpportunityRiskInput,
} from "../yield-opportunity-risk";

function completeInput(overrides: Partial<YieldOpportunityRiskInput> = {}): YieldOpportunityRiskInput {
  return {
    opportunityClass: "lending",
    underlyingSafetyScore: 80,
    venueRiskWeighted: 1.3,
    sourceTvlUsd: 5_000_000,
    sourceRisk: null,
    ...overrides,
  };
}

describe("deriveYieldOpportunityClass", () => {
  it("classifies external opportunity yield types", () => {
    expect(deriveYieldOpportunityClass("lending-opportunity")).toBe("lending");
    expect(deriveYieldOpportunityClass("fixed-yield")).toBe("fixed-yield");
    expect(deriveYieldOpportunityClass("structured-tranche")).toBe("structured-tranche");
  });

  it("returns null for holder yield types", () => {
    expect(deriveYieldOpportunityClass("lending-vault")).toBeNull();
    expect(deriveYieldOpportunityClass("rebase")).toBeNull();
    expect(deriveYieldOpportunityClass("nav-appreciation")).toBeNull();
    expect(deriveYieldOpportunityClass("governance-set")).toBeNull();
  });
});

describe("assessYieldOpportunityRisk", () => {
  it("keeps blue-chip venues with deep markets at the underlying safety", () => {
    const result = assessYieldOpportunityRisk(completeInput());
    expect(result).toEqual({
      opportunityClass: "lending",
      underlyingSafetyScore: 80,
      opportunitySafetyScore: 80,
      opportunitySafetyPenalty: 0,
      venueReviewed: true,
      missingCriticalEvidence: [],
    });
  });

  it("deducts safety points for venue risk above the blue-chip threshold", () => {
    const result = assessYieldOpportunityRisk(completeInput({ venueRiskWeighted: 4 }));
    // (4 - 2.0) * 5 = 10 points
    expect(result.opportunitySafetyScore).toBe(70);
    expect(result.opportunitySafetyPenalty).toBe(10);
  });

  it("deducts for thin market size", () => {
    const result = assessYieldOpportunityRisk(completeInput({ sourceTvlUsd: 90_000 }));
    expect(result.opportunitySafetyScore).toBe(74);
  });

  it("deducts for observed high utilization, access, and withdrawal constraints", () => {
    const result = assessYieldOpportunityRisk(
      completeInput({
        sourceRisk: {
          marketUtilizationRatio: 0.98,
          kycRequired: true,
          withdrawalDelaySeconds: 86_400,
          investabilityFlags: ["withdrawals-underlying-dependent"],
        },
      }),
    );
    // utilization 6 + access 2 + withdrawal 2 + underlying-dependent 1 = 11
    expect(result.opportunitySafetyScore).toBe(69);
    expect(result.opportunitySafetyPenalty).toBe(11);
  });

  it("reports an unreviewed venue as missing critical evidence without a score", () => {
    const result = assessYieldOpportunityRisk(completeInput({ venueRiskWeighted: null }));
    expect(result.opportunitySafetyScore).toBeNull();
    expect(result.opportunitySafetyPenalty).toBeNull();
    expect(result.venueReviewed).toBe(false);
    expect(result.missingCriticalEvidence).toEqual(["venue-review"]);
  });

  it("reports unknown market size as missing critical evidence", () => {
    const result = assessYieldOpportunityRisk(completeInput({ sourceTvlUsd: null }));
    expect(result.opportunitySafetyScore).toBeNull();
    expect(result.missingCriticalEvidence).toEqual(["market-size"]);
  });

  it("falls back to sourceRisk market TVL for market size", () => {
    const result = assessYieldOpportunityRisk(
      completeInput({ sourceTvlUsd: null, sourceRisk: { marketTvlUsd: 2_000_000 } }),
    );
    expect(result.opportunitySafetyScore).toBe(80);
    expect(result.missingCriticalEvidence).toEqual([]);
  });

  it("requires market status for structured tranches", () => {
    const missing = assessYieldOpportunityRisk(completeInput({ opportunityClass: "structured-tranche" }));
    expect(missing.missingCriticalEvidence).toEqual(["market-status"]);

    const complete = assessYieldOpportunityRisk(
      completeInput({ opportunityClass: "structured-tranche", sourceRisk: { marketStatus: "normal" } }),
    );
    expect(complete.missingCriticalEvidence).toEqual([]);
    expect(complete.opportunitySafetyScore).toBe(80);
  });

  it("clamps the opportunity safety score at zero", () => {
    const result = assessYieldOpportunityRisk(
      completeInput({ underlyingSafetyScore: 5, venueRiskWeighted: 5, sourceTvlUsd: 50_000 }),
    );
    expect(result.opportunitySafetyScore).toBe(0);
    expect(result.opportunitySafetyPenalty).toBe(5);
  });
});
