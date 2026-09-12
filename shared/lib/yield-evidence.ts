import type { YieldEvidenceClass, YieldScoreQualification } from "../types/yield";

export interface YieldEvidenceAssessmentInput {
  evidenceClass: YieldEvidenceClass;
  safetyObserved: boolean;
  sourceFreshness: "fresh" | "stale" | "unknown";
  benchmarkFreshness: "healthy" | "degraded" | "stale";
  hasSourceDepth: boolean;
  hasVenueRisk: boolean;
  hasHistory: boolean;
  hasYieldDecomposition: boolean;
  /**
   * False when an external opportunity is missing critical market-risk
   * evidence (yield v8.32). Omitted/true for holder yield and complete
   * opportunities. Not counted in evidence completeness — the seven-field
   * denominator is shared by all rows regardless of opportunity class.
   */
  opportunityEvidenceComplete?: boolean;
  /**
   * Freshness of the USD reference rate a non-USD row's hurdle is re-based onto
   * (yield v8.43, A3). Omitted for USD-benchmarked rows, whose own
   * `benchmarkFreshness` already classifies the same entry. A degraded reference
   * caps the row at `estimated`; a stale one makes the re-based hurdle
   * meaningless, so the row cannot be scored. Not counted in evidence
   * completeness: the reference is a cross-cutting scoring input, not a per-row
   * evidence family.
   */
  referenceBenchmarkFreshness?: "healthy" | "degraded" | "stale";
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

  if (
    input.sourceFreshness !== "fresh" ||
    input.benchmarkFreshness === "stale" ||
    input.referenceBenchmarkFreshness === "stale"
  ) {
    return { evidenceCompleteness, scoreQualification: "NR" };
  }

  if (
    !input.safetyObserved ||
    input.opportunityEvidenceComplete === false ||
    input.evidenceClass === "modeled-proxy" ||
    input.evidenceClass === "fallback" ||
    input.benchmarkFreshness === "degraded" ||
    input.referenceBenchmarkFreshness === "degraded"
  ) {
    return { evidenceCompleteness, scoreQualification: "estimated" };
  }

  return {
    evidenceCompleteness,
    scoreQualification: evidenceCompleteness === 1 ? "rated" : "partial",
  };
}
