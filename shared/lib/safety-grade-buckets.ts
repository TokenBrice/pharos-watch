import type { V9Grade } from "../types/safety-score-v9";
import { REPORT_CARD_GRADE_RANK } from "./report-card-core";

/**
 * Single shared source of truth for the "safe / neutral / risky / unavailable"
 * V9 grade bucketing used by both the worker's flight-to-quality
 * classification (`worker/src/lib/flight-to-quality-classification.ts`) and
 * the frontend V9 consumer helpers (`src/lib/safety-score-v9-consumers.ts`).
 * Previously each side hand-copied its own version of these boundaries.
 */
export const SAFE_GRADES: ReadonlySet<V9Grade> = new Set<V9Grade>(["A+", "A", "A-", "B+", "B", "B-"]);
export const RISKY_GRADES: ReadonlySet<V9Grade> = new Set<V9Grade>(["D", "F"]);

export type V9GradeRiskBucket = "safe" | "neutral" | "risky" | "unavailable";

export function getV9GradeRiskBucket(grade: V9Grade): V9GradeRiskBucket {
  if (grade === "NR") return "unavailable";
  if (REPORT_CARD_GRADE_RANK[grade] >= REPORT_CARD_GRADE_RANK["B-"]) return "safe";
  if (REPORT_CARD_GRADE_RANK[grade] >= REPORT_CARD_GRADE_RANK["C-"]) return "neutral";
  return "risky";
}
