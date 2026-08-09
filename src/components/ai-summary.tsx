import Link from "next/link";
import { buildAiDisclosureLine } from "@/components/ai-disclosure";
import { AiSummaryProse } from "@/components/ai-summary-prose";
import { Card, CardHeader, CardContent } from "@/components/ui/card";
import { DetailSectionTitle } from "@/components/stablecoin-detail/section-title";
import { TermText } from "@/components/term-text";
import type { StablecoinAiSummary } from "@shared/types";
import { formatLongDate } from "@shared/lib/format";

export function AiSummary({
  title,
  text,
  updatedAt,
  authoredBy,
  model,
  reviewedBy,
  reviewedAt,
  factsAsOf,
}: StablecoinAiSummary) {
  const isoDate = updatedAt;
  const dateline = formatLongDate(new Date(`${updatedAt}T00:00:00Z`), { utc: true });
  const disclosure = buildAiDisclosureLine({ authoredBy, model, reviewedBy, reviewedAt, factsAsOf });

  return (
    <Card>
      <CardHeader>
        <DetailSectionTitle>{title}</DetailSectionTitle>
      </CardHeader>
      <CardContent>
        <AiSummaryProse textLength={text.length}>
          <TermText text={text} />
        </AiSummaryProse>
        {/* Provenance footer (Figma coin template): mono uppercase dateline +
            disclosure with the policy link at the far edge. */}
        <div className="mt-4 flex min-w-0 flex-wrap items-center justify-between gap-x-4 gap-y-1.5 border-t border-border/40 pt-3">
          <p className="min-w-0 font-mono text-[10px] uppercase leading-relaxed tracking-[0.14em] text-muted-foreground">
            <time dateTime={isoDate}>Updated {dateline}</time>
            {disclosure ? <> · {disclosure}</> : null}
          </p>
          <Link
            href="/about/#editorial-ai-policy"
            className="pharos-focus-ring shrink-0 rounded-sm font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground underline decoration-dashed underline-offset-2 hover:text-foreground"
          >
            Policy
          </Link>
        </div>
      </CardContent>
    </Card>
  );
}
