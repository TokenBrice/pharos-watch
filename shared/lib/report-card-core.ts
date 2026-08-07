import type { ReportCardGrade } from "../types";
import { bandFromThresholds, clampScore } from "./math";

export type ReportCardGradeRange = "A" | "B" | "C" | "D" | "F" | "NR";

export const GRADE_THRESHOLDS: { grade: ReportCardGrade; min: number }[] = [
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
];

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

export const REPORT_CARD_GRADE_COLORS: Record<ReportCardGrade, string> = {
  "A+": "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border-emerald-500/20",
  A: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border-emerald-500/20",
  "A-": "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border-emerald-500/20",
  "B+": "bg-blue-500/10 text-blue-700 dark:text-blue-400 border-blue-500/20",
  B: "bg-blue-500/10 text-blue-700 dark:text-blue-400 border-blue-500/20",
  "B-": "bg-blue-500/10 text-blue-700 dark:text-blue-400 border-blue-500/20",
  "C+": "bg-amber-500/10 text-amber-700 dark:text-amber-400 border-amber-500/20",
  C: "bg-amber-500/10 text-amber-700 dark:text-amber-400 border-amber-500/20",
  "C-": "bg-amber-500/10 text-amber-700 dark:text-amber-400 border-amber-500/20",
  D: "bg-orange-500/10 text-orange-700 dark:text-orange-400 border-orange-500/20",
  F: "bg-red-500/10 text-red-700 dark:text-red-400 border-red-500/20",
  NR: "bg-muted text-muted-foreground border-muted",
};

export const GRADE_RADAR_COLORS: Record<ReportCardGradeRange, string> = {
  A: "#10b981",
  B: "#3b82f6",
  C: "#f59e0b",
  D: "#f97316",
  F: "#ef4444",
  NR: "#71717a",
};

export function scoreToGrade(score: number | null): ReportCardGrade {
  if (score === null) return "NR";
  return bandFromThresholds(clampScore(score), GRADE_THRESHOLDS, { grade: "F" as const, min: 0 }).grade;
}

export function gradeRange(grade: ReportCardGrade): ReportCardGradeRange {
  if (grade === "NR") return "NR";
  if (grade === "A+" || grade === "A" || grade === "A-") return "A";
  if (grade === "B+" || grade === "B" || grade === "B-") return "B";
  if (grade === "C+" || grade === "C" || grade === "C-") return "C";
  return grade;
}
