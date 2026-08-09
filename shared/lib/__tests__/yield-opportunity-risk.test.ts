import { describe, expect, it } from "vitest";
import {
  assessYieldOpportunityRisk,
  deriveYieldOpportunityClass,
  resolveYieldRowSafety,
  type YieldOpportunityRiskInput,
  type YieldRowSafetyInput,
} from "../yield-opportunity-risk";
import type { YieldSourceRisk } from "../../types/yield";

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

describe("resolveYieldRowSafety — canonical ladder (yield v8.33)", () => {
  const lendingRisk: YieldSourceRisk = {
    venueProtocol: "aave-v3",
    venueRiskWeighted: 4,
    marketTvlUsd: 5_000_000,
  };

  function ladderInput(overrides: Partial<YieldRowSafetyInput> = {}): YieldRowSafetyInput {
    return {
      yieldType: "lending-opportunity",
      underlyingSafety: { score: 80, grade: "B" },
      defaultSafetyScore: 40,
      sourceRisk: lendingRisk,
      sourceTvlUsd: 5_000_000,
      ratedProvenance: "cached-publish",
      ...overrides,
    };
  }

  it("substitutes the opportunity score over an observed, rated report card", () => {
    const result = resolveYieldRowSafety(ladderInput());
    // (4 - 2.0) * 5 = 10 points off 80
    expect(result.safetyScore).toBe(70);
    expect(result.safetyProvenance).toBe("opportunity-safety");
    expect(result.safetyReason).toBeNull();
    expect(result.safetyEvidenceObserved).toBe(true);
    expect(result.opportunityEvidenceComplete).toBe(true);
  });

  it("NR-substitution guard: an NR-graded underlying keeps its own unrating", () => {
    const result = resolveYieldRowSafety(ladderInput({ underlyingSafety: { score: 80, grade: "NR" } }));
    expect(result.safetyScore).toBe(80);
    expect(result.safetyGrade).toBe("NR");
    expect(result.safetyProvenance).toBe("cached-publish");
    expect(result.safetyReason).toBe("report-card-grade-not-rated");
    expect(result.safetyEvidenceObserved).toBe(false);
    // The contract is still published, it just does not move the grade.
    expect(result.opportunityRisk?.opportunitySafetyScore).toBe(70);
  });

  it("NR-substitution guard: a missing report card keeps the default safety", () => {
    const result = resolveYieldRowSafety(ladderInput({ underlyingSafety: null }));
    expect(result.safetyScore).toBe(40);
    expect(result.safetyProvenance).toBe("default-safety");
    expect(result.safetyReason).toBe("report-card-score-missing");
  });

  it("venue fallback: an unscored row resolves its venue from the reviewed registry", () => {
    const result = resolveYieldRowSafety(
      ladderInput({ sourceRisk: { marketTvlUsd: 5_000_000 }, venueProtocolHint: "aave-v3" }),
    );
    expect(result.venueRiskWeighted).not.toBeNull();
    expect(result.venueRiskTier).not.toBe("unknown");
    expect(result.opportunityRisk?.venueReviewed).toBe(true);
  });

  it("venue fallback: an unreviewed venue stays unrated rather than guessing", () => {
    const result = resolveYieldRowSafety(
      ladderInput({ sourceRisk: { marketTvlUsd: 5_000_000 }, venueProtocolHint: "obscure-unreviewed-venue" }),
    );
    expect(result.venueRiskTier).toBe("unknown");
    expect(result.safetyScore).toBe(80);
    expect(result.safetyProvenance).toBe("cached-publish");
    expect(result.opportunityEvidenceComplete).toBe(false);
    expect(result.opportunityRisk?.missingCriticalEvidence).toEqual(["venue-review"]);
  });

  it("entry gate: every external-opportunity row is assessed, published contract or not", () => {
    const result = resolveYieldRowSafety(ladderInput({ sourceRisk: null }));
    expect(result.opportunityRisk).not.toBeNull();
    expect(result.sourceRisk?.opportunityRisk).toBe(result.opportunityRisk);
  });

  it("entry gate: holder yield types carry no opportunity contract at all", () => {
    const result = resolveYieldRowSafety(ladderInput({ yieldType: "lending-vault" }));
    expect(result.opportunityRisk).toBeNull();
    expect(result.safetyScore).toBe(80);
    expect(result.safetyProvenance).toBe("cached-publish");
    expect(result.opportunityEvidenceComplete).toBe(true);
  });

  it("routes Royco Dawn tranches through the bespoke engine and publishes one contract", () => {
    const result = resolveYieldRowSafety(
      ladderInput({
        yieldType: "structured-tranche",
        sourceRisk: {
          trancheSide: "junior",
          venueProtocol: "royco-dawn",
          venueRiskWeighted: 3,
          marketStatus: "normal",
          marketTvlUsd: 2_000_000,
        },
      }),
    );
    expect(result.safetyProvenance).toBe("opportunity-safety");
    expect(result.safetyScore).toBeLessThan(80);
    expect(result.sourceRisk?.trancheSafetyScore).toBe(result.safetyScore);
    expect(result.opportunityRisk?.opportunitySafetyScore).toBe(result.safetyScore);
    expect(result.opportunityRisk?.missingCriticalEvidence).toEqual([]);
  });

  it("an unavailable safety snapshot strips every safety-derived field", () => {
    const result = resolveYieldRowSafety(
      ladderInput({ underlyingSafety: undefined, safetySnapshotUnavailable: true }),
    );
    expect(result.safetyProvenance).toBe("safety-snapshot-unavailable");
    expect(result.safetyReason).toBe("safety-snapshot-unavailable");
    expect(result.safetyGrade).toBe("NR");
    expect(result.opportunityRisk).toBeNull();
    expect(result.sourceRisk?.trancheSafetyScore).toBeNull();
    expect(result.sourceRisk?.underlyingSafetyScore).toBeNull();
  });

  it("differs between write and read paths only in the rated provenance label", () => {
    const write = resolveYieldRowSafety(
      ladderInput({ underlyingSafety: { score: 80, grade: "NR" }, ratedProvenance: "cached-publish" }),
    );
    const read = resolveYieldRowSafety(
      ladderInput({ underlyingSafety: { score: 80, grade: "NR" }, ratedProvenance: "live-report-card" }),
    );
    expect(write.safetyProvenance).toBe("cached-publish");
    expect(read.safetyProvenance).toBe("live-report-card");
    expect({ ...write, safetyProvenance: null }).toEqual({ ...read, safetyProvenance: null });
  });
});
