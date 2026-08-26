import candidatePolicyAsset from "../data/safety-score-v9/methodology-policy-candidate-v1.json";
import type { ReportCardGrade } from "./report-card-grade";
import { V9MethodologyPolicySchema, type V9Grade } from "./safety-score-v9";

// This helper is consumed by the public schemas, so it stays in shared/types;
// importing shared/lib here would invert the shared boundary. The checked-in
// policy asset remains the single source for the threshold values.
const V9_POLICY = V9MethodologyPolicySchema.parse(candidatePolicyAsset);

/** Grade thresholds projected from the versioned V9 methodology policy asset. */
export const V9_GRADE_THRESHOLDS: readonly { grade: Exclude<V9Grade, "NR">; min: number }[] = Object.freeze(
  V9_POLICY.semantic.formula.gradeThresholds.map(({ grade, minScore }) => ({ grade, min: minScore })),
);

export function scoreToGrade(score: number | null): ReportCardGrade {
  if (score === null) return "NR";
  const clampedScore = !Number.isFinite(score)
    ? score !== score
      ? 0
      : score > 0
        ? 100
        : 0
    : Math.max(0, Math.min(100, score));
  return V9_GRADE_THRESHOLDS.find((threshold) => clampedScore >= threshold.min)?.grade ?? "F";
}
