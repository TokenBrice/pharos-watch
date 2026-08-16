import type { CaseStudy } from "@/lib/case-studies/types";

export const CASE_STUDY_WORDS_PER_MINUTE = 200;

function caseStudyReadableText(study: CaseStudy): string {
  return [
    ...study.lead,
    ...(study.takeaways ?? []),
    ...study.sections.flatMap((section) => section.paragraphs),
    ...study.timeline.map((entry) => `${entry.headline} ${entry.body}`),
    ...study.watchpoints,
  ].join(" ");
}

export function caseStudyWordCount(study: CaseStudy): number {
  return caseStudyReadableText(study).split(/\s+/).filter(Boolean).length;
}

export function estimateCaseStudyReadingMinutes(study: CaseStudy): number {
  return Math.max(1, Math.round(caseStudyWordCount(study) / CASE_STUDY_WORDS_PER_MINUTE));
}
