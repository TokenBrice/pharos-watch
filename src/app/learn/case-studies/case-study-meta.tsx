import Link from "next/link";
import { formatUtcDayLabel } from "@shared/lib/format";
import type { CaseStudy } from "@shared/types/editorial-content";
import { estimateCaseStudyReadingMinutes } from "./case-study-reading-time";
import { CaseStudyShare } from "./case-study-share";

/**
 * Article byline and share control rendered inside `LearnPageShell.headerMeta`.
 * Preserves the authored `Published <time>` UTC contract (never renders an
 * "Updated" byline) and links to Pharos's editorial AI policy.
 */
export function CaseStudyArticleMeta({ study }: { study: CaseStudy }) {
  const minutes = estimateCaseStudyReadingMinutes(study);
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-y border-border/50 py-3">
      <p className="pharos-meta">
        By{" "}
        <Link href="/about/#editorial-ai-policy" className="pharos-prose-link">
          Pharos
        </Link>
        {" · Published "}
        <time dateTime={study.datePublished}>
          <span className="pharos-numeric text-foreground/85">
            {formatUtcDayLabel(new Date(study.datePublished))}
          </span>
        </time>
        {" · "}
        <span className="pharos-numeric text-foreground/85">~{minutes}</span> min read
      </p>
      <CaseStudyShare />
    </div>
  );
}
