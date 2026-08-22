import { z } from "zod";

/**
 * Canonical Pharos safety-grade vocabulary.
 *
 * This list is the source of truth for the letter grades Pharos publishes.
 * It used to be derived from `BLUECHIP_GRADE_VALUES` in `./core`, which made
 * Pharos's own grade scale literally a projection of a third-party vendor's
 * enum: any future change to what Bluechip reports would have silently
 * re-shaped every Pharos grade type, schema, threshold table, and rank ladder.
 *
 * The dependency is now inverted. Pharos owns this vocabulary; the vendor enum
 * in `./core` stands on its own and merely *coincides* with it today, a
 * coincidence pinned by `shared/types/__tests__/report-card-grade.test.ts`.
 * If the vendor ever diverges, that test fails and the two scales separate
 * without touching Pharos scoring.
 */
export const SAFETY_GRADE_VALUES = ["A+", "A", "A-", "B+", "B", "B-", "C+", "C", "C-", "D", "F"] as const;
export type SafetyGrade = (typeof SAFETY_GRADE_VALUES)[number];

/** Published grade vocabulary plus the explicit "not rated" outcome. */
const REPORT_CARD_GRADE_VALUES = [...SAFETY_GRADE_VALUES, "NR"] as const;

export type ReportCardGrade = (typeof REPORT_CARD_GRADE_VALUES)[number];
export const ReportCardGradeSchema = z.enum(REPORT_CARD_GRADE_VALUES);

export type ReportCardGradeRange = "A" | "B" | "C" | "D" | "F" | "NR";
