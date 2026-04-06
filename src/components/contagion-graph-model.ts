import { GRADE_RADAR_COLORS, gradeRange } from "@shared/lib/report-cards";
import type { ReportCardGrade, DependencyType } from "@shared/types";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const TYPE_COLORS: Record<DependencyType, string> = {
  collateral: "#64748b",
  mechanism: "#f59e0b",
  wrapper: "#8b5cf6",
};

export const TYPE_DASH: Record<DependencyType, string | undefined> = {
  collateral: undefined,
  mechanism: "6 3",
  wrapper: "2 3",
};

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

export function gradeColor(grade: string): string {
  return GRADE_RADAR_COLORS[gradeRange(grade as ReportCardGrade)] ?? GRADE_RADAR_COLORS.NR;
}
