export type CaseStudyOutcome = "survived" | "wounded" | "died";

export const CASE_STUDY_OUTCOME_LABELS: Record<CaseStudyOutcome, string> = {
  survived: "Survived",
  wounded: "Wounded",
  died: "Died",
};

// Light-mode text darkens to the -700 shades so the 12px chips clear WCAG AA
// on light surfaces (mirrors the severity ramp's amber-700-on-light rule).
export const CASE_STUDY_OUTCOME_CHIPS: Record<CaseStudyOutcome, string> = {
  survived: "border-emerald-500/40 text-emerald-700 dark:text-emerald-400",
  wounded: "border-amber-500/40 text-amber-700 dark:text-amber-400",
  died: "border-rose-500/40 text-rose-600 dark:text-rose-400",
};

export const CASE_STUDY_OUTCOME_CHIP_BASE =
  "inline-flex rounded-full border px-2.5 py-0.5 font-mono text-xs font-semibold uppercase tracking-wide";
