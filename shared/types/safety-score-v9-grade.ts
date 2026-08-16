import candidatePolicyAsset from "../data/safety-score-v9/methodology-policy-candidate-v1.json";
import { V9MethodologyPolicySchema, type V9Grade } from "./safety-score-v9";

// This helper is consumed by the public schemas, so it stays in shared/types;
// importing shared/lib here would invert the shared boundary. The checked-in
// policy asset remains the single source for the threshold values.
const V9_POLICY = V9MethodologyPolicySchema.parse(candidatePolicyAsset);

/** Grade thresholds projected from the versioned V9 methodology policy asset. */
export const V9_GRADE_THRESHOLDS: readonly { grade: Exclude<V9Grade, "NR">; min: number }[] = Object.freeze(
  V9_POLICY.semantic.formula.gradeThresholds.map(({ grade, minScore }) => ({ grade, min: minScore })),
);

export type V9GradeRange = "A" | "B" | "C" | "D" | "F" | "NR";

export function scoreToV9Grade(score: number | null): V9Grade {
  if (score === null) return "NR";
  return V9_GRADE_THRESHOLDS.find((threshold) => score >= threshold.min)?.grade ?? "F";
}

export function v9GradeRange(grade: V9Grade): V9GradeRange {
  if (grade === "NR") return "NR";
  return grade[0] as Exclude<V9GradeRange, "NR">;
}
