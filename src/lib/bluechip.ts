import type { BluechipGrade } from "@shared/types";
import { getReportCardGradeRank } from "@shared/lib/report-card-core";

export const BLUECHIP_REPORT_BASE = "https://bluechip.org/en/coins";

// Higher = better, used for sort ordering; derived from the canonical
// grade rank so a vendor-scale change can't fork the ordering.
export const GRADE_ORDER: Record<BluechipGrade, number> = Object.fromEntries(
  (["A+", "A", "A-", "B+", "B", "B-", "C+", "C", "C-", "D", "F"] as const).map((grade) => [
    grade,
    getReportCardGradeRank(grade),
  ]),
) as Record<BluechipGrade, number>;
