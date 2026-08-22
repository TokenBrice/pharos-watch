import {
  REPORT_CARD_GRADE_COLORS,
  REPORT_CARD_GRADE_RANGE_METADATA,
  type ReportCardGradeRangeMetadata,
} from "@shared/lib/classification";
import { gradeRange, type ReportCardGradeRange } from "@shared/lib/report-card-core";
import type { ReportCardGrade } from "@shared/types";

export type SafetyGradeRange = ReportCardGradeRange;
export type SafetyGradeRangeMetadata = ReportCardGradeRangeMetadata;

function getSafetyGradeRange(grade: ReportCardGrade): SafetyGradeRange {
  return gradeRange(grade);
}

export function getSafetyGradeMetadata(grade: ReportCardGrade | SafetyGradeRange): SafetyGradeRangeMetadata {
  const range = getSafetyGradeRange(grade as ReportCardGrade);
  return REPORT_CARD_GRADE_RANGE_METADATA[range];
}

export function getSafetyGradeBadgeClassName(grade: ReportCardGrade): string {
  return REPORT_CARD_GRADE_COLORS[grade];
}
