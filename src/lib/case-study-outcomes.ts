import { CASE_STUDY_OUTCOME_CLASSES, SEVERITY_NAMED_TONE_CLASSES } from "@shared/lib/classification";
import type { CaseStudyOutcome } from "@shared/types/editorial-content";

export const CASE_STUDY_OUTCOME_LABELS: Record<CaseStudyOutcome, string> = {
  survived: "Survived",
  wounded: "Wounded",
  died: "Died",
};

// Light-mode text darkens to the -700 shades so the 11px chips clear WCAG AA
// on light surfaces (mirrors the severity ramp's amber-700-on-light rule).
export const CASE_STUDY_OUTCOME_CHIPS: Record<CaseStudyOutcome, string> = {
  survived: CASE_STUDY_OUTCOME_CLASSES.survived.chip,
  wounded: CASE_STUDY_OUTCOME_CLASSES.wounded.chip,
  died: CASE_STUDY_OUTCOME_CLASSES.died.chip,
};

export const CASE_STUDY_OUTCOME_BARS: Record<CaseStudyOutcome, string> = {
  survived: "bg-state-positive-solid",
  wounded: "bg-state-warn-solid",
  died: SEVERITY_NAMED_TONE_CLASSES.rose.bar,
};

export const CASE_STUDY_OUTCOME_CHIP_BASE =
  "inline-flex items-center rounded-full border px-2 py-0.5 text-2xs font-semibold";
