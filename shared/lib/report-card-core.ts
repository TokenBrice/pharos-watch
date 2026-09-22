import type { ReportCardGrade } from "../types";
import type { ReportCardGradeRange } from "../types/report-card-grade";

export { V9_GRADE_THRESHOLDS, scoreToGrade } from "../types/safety-score-v9-grade";
export type { ReportCardGradeRange } from "../types/report-card-grade";
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
