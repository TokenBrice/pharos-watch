import type { CaseStudyOutcome } from "./content/types";

export const CASE_STUDY_OUTCOME_LABELS: Record<CaseStudyOutcome, string> = {
  survived: "Survived",
  wounded: "Wounded",
  died: "Died",
};

export const CASE_STUDY_OUTCOME_CHIPS: Record<CaseStudyOutcome, string> = {
  survived: "border-emerald-500/40 text-emerald-600 dark:text-emerald-400",
  wounded: "border-amber-500/40 text-amber-600 dark:text-amber-400",
  died: "border-rose-500/40 text-rose-600 dark:text-rose-400",
};
