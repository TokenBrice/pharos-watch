import type { ReportCardGrade } from "../types";
import { V9_GRADE_THRESHOLDS } from "../types/safety-score-v9-grade";
import type { ReportCardGradeRange } from "../types/report-card-grade";

export { V9_GRADE_THRESHOLDS, scoreToGrade } from "../types/safety-score-v9-grade";
export { GRADE_RADAR_COLORS, REPORT_CARD_GRADE_COLORS } from "./classification";
export type { ReportCardGradeRange } from "../types/report-card-grade";

/**
 * Presentation uses the grade thresholds projected from the active V9 policy
 * so a policy change cannot leave report-card labels on a different threshold set.
 */
export const GRADE_THRESHOLDS: readonly { grade: ReportCardGrade; min: number }[] = V9_GRADE_THRESHOLDS;

export const REPORT_CARD_GRADE_RANK: Record<ReportCardGrade, number> = {
  NR: -1,
  F: 0,
  D: 1,
  "C-": 2,
  C: 3,
  "C+": 4,
  "B-": 5,
  B: 6,
  "B+": 7,
  "A-": 8,
  A: 9,
  "A+": 10,
};

export const UNKNOWN_REPORT_CARD_GRADE_RANK = -2;

export function getReportCardGradeRank(
  grade: string | null | undefined,
  fallback: number | null = null,
): number | null {
  if (!grade) return fallback;
  return (REPORT_CARD_GRADE_RANK as Record<string, number | undefined>)[grade] ?? fallback;
}

export function gradeRange(grade: ReportCardGrade): ReportCardGradeRange {
  if (grade === "NR") return "NR";
  if (grade === "A+" || grade === "A" || grade === "A-") return "A";
  if (grade === "B+" || grade === "B" || grade === "B-") return "B";
  if (grade === "C+" || grade === "C" || grade === "C-") return "C";
  return grade;
}
