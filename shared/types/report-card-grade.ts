import { z } from "zod";

/**
 * Canonical Pharos safety-grade vocabulary.
 *
 * This list is the source of truth for the letter grades Pharos publishes.
 * Pharos owns this vocabulary; it is not derived from any third-party scale.
 */
export const SAFETY_GRADE_VALUES = ["A+", "A", "A-", "B+", "B", "B-", "C+", "C", "C-", "D", "F"] as const;
export type SafetyGrade = (typeof SAFETY_GRADE_VALUES)[number];

/** Published grade vocabulary plus the explicit "not rated" outcome. */
const REPORT_CARD_GRADE_VALUES = [...SAFETY_GRADE_VALUES, "NR"] as const;

export type ReportCardGrade = (typeof REPORT_CARD_GRADE_VALUES)[number];
export const ReportCardGradeSchema = z.enum(REPORT_CARD_GRADE_VALUES);

export type ReportCardGradeRange = "A" | "B" | "C" | "D" | "F" | "NR";
