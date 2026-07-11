import { describe, expect, it } from "vitest";
import { assessYieldEvidence, type YieldEvidenceAssessmentInput } from "../yield-evidence";

function completeEvidence(overrides: Partial<YieldEvidenceAssessmentInput> = {}): YieldEvidenceAssessmentInput {
  return {
    evidenceClass: "direct-onchain",
    safetyObserved: true,
    sourceFreshness: "fresh",
    benchmarkFreshness: "healthy",
    hasSourceDepth: true,
    hasVenueRisk: true,
    hasHistory: true,
    hasYieldDecomposition: true,
    ...overrides,
  };
}

describe("assessYieldEvidence", () => {
  it("rates complete direct evidence", () => {
    expect(assessYieldEvidence(completeEvidence())).toEqual({
      evidenceCompleteness: 1,
      scoreQualification: "rated",
    });
  });

  it("labels complete modeled evidence as estimated", () => {
    expect(assessYieldEvidence(completeEvidence({ evidenceClass: "modeled-proxy" }))).toEqual({
      evidenceCompleteness: 1,
      scoreQualification: "estimated",
    });
  });

  it("uses partial for noncritical evidence debt", () => {
    expect(assessYieldEvidence(completeEvidence({ hasVenueRisk: false }))).toEqual({
      evidenceCompleteness: 0.8571,
      scoreQualification: "partial",
    });
  });

  it.each([
    { safetyObserved: false },
    { sourceFreshness: "unknown" as const },
    { sourceFreshness: "stale" as const },
    { benchmarkFreshness: "stale" as const },
    { opportunityEvidenceComplete: false },
  ])("does not rate missing critical evidence: $safetyObserved$sourceFreshness$benchmarkFreshness$opportunityEvidenceComplete", (gap) => {
    expect(assessYieldEvidence(completeEvidence(gap)).scoreQualification).toBe("NR");
  });

  it("keeps complete opportunity evidence rated without changing completeness", () => {
    expect(assessYieldEvidence(completeEvidence({ opportunityEvidenceComplete: true }))).toEqual({
      evidenceCompleteness: 1,
      scoreQualification: "rated",
    });
  });
});
