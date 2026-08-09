import type { V9Grade } from "./safety-score-v9";

/**
 * The published grade bands. Single definition — `shared/lib/report-card-core.ts`
 * re-exports this table as `GRADE_THRESHOLDS` rather than restating it.
 */
export const V9_GRADE_THRESHOLDS = [
  { grade: "A+", min: 87 },
  { grade: "A", min: 83 },
  { grade: "A-", min: 80 },
  { grade: "B+", min: 75 },
  { grade: "B", min: 70 },
  { grade: "B-", min: 65 },
  { grade: "C+", min: 60 },
  { grade: "C", min: 55 },
  { grade: "C-", min: 50 },
  { grade: "D", min: 40 },
  { grade: "F", min: 0 },
] as const satisfies readonly {
  grade: Exclude<V9Grade, "NR">;
  min: number;
}[];

export type V9GradeRange = "A" | "B" | "C" | "D" | "F" | "NR";

export function scoreToV9Grade(score: number | null): V9Grade {
  if (score === null) return "NR";
  return (
    V9_GRADE_THRESHOLDS.find((threshold) => score >= threshold.min)?.grade ??
    "F"
  );
}

export function v9GradeRange(grade: V9Grade): V9GradeRange {
  if (grade === "NR") return "NR";
  return grade[0] as Exclude<V9GradeRange, "NR">;
}
