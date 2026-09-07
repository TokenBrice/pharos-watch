import Link from "next/link";
import { buildAiDisclosureLine } from "@/components/ai-disclosure";
import { AiSummaryProse } from "@/components/ai-summary-prose";
import { Card, CardHeader, CardContent } from "@/components/ui/card";
import { DetailSectionTitle } from "@/components/stablecoin-detail/section-title";
import { TermText } from "@/components/term-text";
import type { AiSummaryClaimValues, StablecoinAiSummary } from "@shared/types";
import { resolveAiSummaryClaims } from "@shared/lib/ai-summary-claims";
import { formatLongDate } from "@shared/lib/format";

export type AiSummaryProps = StablecoinAiSummary & {
  claimValues?: AiSummaryClaimValues;
};

export function AiSummary({
  title,
  text,
  updatedAt,
  authoredBy,
  model,
  reviewedBy,
  reviewedAt,
  factsAsOf,
  sources,
  claimTokens,
  claimValues,
}: AiSummaryProps) {
  const isoDate = updatedAt;
  const dateline = formatLongDate(new Date(`${updatedAt}T00:00:00Z`), { utc: true });
  const disclosure = buildAiDisclosureLine({ authoredBy, model, reviewedBy, reviewedAt, factsAsOf });
  const resolved = resolveAiSummaryClaims(text, claimTokens, claimValues);
  const claimsDateline = resolved.factsAsOf
    .map((date) => formatLongDate(new Date(`${date}T00:00:00Z`), { utc: true }))
    .join(", ");

  return (
    <Card>
      <CardHeader>
        <DetailSectionTitle>{title}</DetailSectionTitle>
      </CardHeader>
      <CardContent>
        <AiSummaryProse textLength={resolved.text.length}>
          <TermText text={resolved.text} />
        </AiSummaryProse>
        {claimsDateline ? (
          <p className="mt-3 inline-flex rounded-full border border-border/60 bg-muted/30 px-2 py-1 font-mono text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
            Claims as of {claimsDateline}
          </p>
        ) : null}
        {sources?.length ? (
          <div className="mt-4 border-t border-border/40 pt-3">
            <p className="font-mono text-[10px] uppercase leading-relaxed tracking-[0.14em] text-muted-foreground">
              Sources
            </p>
            <ul className="mt-1.5 flex min-w-0 flex-wrap gap-x-3 gap-y-1 text-xs">
              {sources.map((source) => (
                <li key={source.url}>
                  <Link
                    href={source.url}
                    className="pharos-focus-ring rounded-sm text-muted-foreground underline decoration-dashed underline-offset-2 hover:text-foreground"
                  >
                    {source.label}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
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
