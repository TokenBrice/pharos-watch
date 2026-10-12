import { CASE_STUDY_OUTCOME_CLASSES, type CaseStudyOutcomeKey } from "@shared/lib/classification";

export type CaseStudyOutcome = CaseStudyOutcomeKey;

export const CASE_STUDY_OUTCOME_LABELS: Record<CaseStudyOutcome, string> = {
  survived: "Survived",
  wounded: "Wounded",
  died: "Died",
};

// Light-mode text darkens to the -700 shades so the 12px chips clear WCAG AA
// on light surfaces (mirrors the severity ramp's amber-700-on-light rule).
export const CASE_STUDY_OUTCOME_CHIPS: Record<CaseStudyOutcome, string> = {
  survived: CASE_STUDY_OUTCOME_CLASSES.survived.chip,
  wounded: CASE_STUDY_OUTCOME_CLASSES.wounded.chip,
  died: CASE_STUDY_OUTCOME_CLASSES.died.chip,
};

export const CASE_STUDY_OUTCOME_CHIP_BASE =
  "inline-flex rounded-full border px-2.5 py-0.5 font-mono text-xs font-semibold uppercase tracking-wide";
