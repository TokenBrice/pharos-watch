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

/**
 * Neutral public provenance for an external grade: the original successful observation date, or
 * an explicit unavailable date. Operator observation states (retained, stale, unknown) and the
 * 48h Selector admission window in `@shared/lib/bluechip-freshness` are not reader warnings.
 */
export function bluechipObservationText(lastObservedAt: number | null | undefined, nowSeconds: number): string {
  if (lastObservedAt == null || !Number.isFinite(lastObservedAt) || lastObservedAt > nowSeconds) {
    return "Observation date unavailable";
  }
  return `Observed ${new Date(lastObservedAt * 1000).toISOString().slice(0, 10)}`;
}
