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

export function getSafetyGradeMetadata(grade: ReportCardGrade | SafetyGradeRange | null): SafetyGradeRangeMetadata {
  if (grade === null) return {
    ...REPORT_CARD_GRADE_RANGE_METADATA.NR,
    sectionDescription: "Pipeline gap — no Safety Score published",
    pulse: { ...REPORT_CARD_GRADE_RANGE_METADATA.NR.pulse, tagline: "Pipeline gap — no Safety Score published." },
  };
  const range = getSafetyGradeRange(grade as ReportCardGrade);
  return REPORT_CARD_GRADE_RANGE_METADATA[range];
}

export function getSafetyGradeBadgeClassName(grade: ReportCardGrade | null): string {
  return grade === null ? "bg-muted text-muted-foreground border-border" : REPORT_CARD_GRADE_COLORS[grade];
}
