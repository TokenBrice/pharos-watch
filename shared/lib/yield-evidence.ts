import type { YieldEvidenceClass, YieldScoreQualification } from "@shared/types/yield";

export interface YieldEvidenceAssessmentInput {
  evidenceClass: YieldEvidenceClass;
  safetyObserved: boolean;
  sourceFreshness: "fresh" | "stale" | "unknown";
  benchmarkFreshness: "healthy" | "degraded" | "stale";
  hasSourceDepth: boolean;
  hasVenueRisk: boolean;
  hasHistory: boolean;
  hasYieldDecomposition: boolean;
}

export interface YieldEvidenceAssessment {
  evidenceCompleteness: number;
  scoreQualification: YieldScoreQualification;
}

const EVIDENCE_FIELD_COUNT = 7;

export function assessYieldEvidence(input: YieldEvidenceAssessmentInput): YieldEvidenceAssessment {
  const measuredFieldCount = [
    input.safetyObserved,
    input.sourceFreshness === "fresh",
    input.benchmarkFreshness !== "stale",
    input.hasSourceDepth,
    input.hasVenueRisk,
    input.hasHistory,
    input.hasYieldDecomposition,
  ].filter(Boolean).length;
  const evidenceCompleteness = Number((measuredFieldCount / EVIDENCE_FIELD_COUNT).toFixed(4));

  if (!input.safetyObserved || input.sourceFreshness !== "fresh" || input.benchmarkFreshness === "stale") {
    return { evidenceCompleteness, scoreQualification: "NR" };
  }

  if (
    input.evidenceClass === "modeled-proxy" ||
    input.evidenceClass === "fallback" ||
    input.benchmarkFreshness === "degraded"
  ) {
    return { evidenceCompleteness, scoreQualification: "estimated" };
  }

  return {
    evidenceCompleteness,
    scoreQualification: evidenceCompleteness === 1 ? "rated" : "partial",
  };
}
