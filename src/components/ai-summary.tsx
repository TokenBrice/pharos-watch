import Link from "next/link";
import { buildAiDisclosureLine, formatAiSummaryIsoDate } from "@/components/ai-disclosure";
import { AiSummaryProse } from "@/components/ai-summary-prose";
import { Card, CardHeader, CardContent } from "@/components/ui/card";
import { DetailSectionTitle } from "@/components/stablecoin-detail/section-title";
import { TermText } from "@/components/term-text";
import type { AiSummaryClaimValues, StablecoinAiSummary } from "@shared/types";
import { resolveAiSummaryClaims } from "@shared/lib/ai-summary-claims";

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
  // One date grammar across the card: ISO days, as in every dossier footer.
  const updatedDate = formatAiSummaryIsoDate(updatedAt);
  const disclosure = buildAiDisclosureLine(
    { authoredBy, model, reviewedBy, reviewedAt, factsAsOf },
    { dateFormat: "iso" },
  );
  const resolved = resolveAiSummaryClaims(text, claimTokens, claimValues);
  const claimsDateline = resolved.factsAsOf.map(formatAiSummaryIsoDate).join(", ");

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
          <p className="mt-3 inline-flex rounded-full border border-border/60 bg-muted/30 px-2.5 py-0.5 text-xs text-muted-foreground">
            Claims as of {claimsDateline}
          </p>
        ) : null}
        {sources?.length ? (
          <div className="mt-4 border-t border-border/40 pt-3">
            <p className="pharos-kicker">
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
        {/* Provenance footer: one sentence-case line (dateline + disclosure),
            the policy link at the far edge, in the dossier footer grammar. */}
        <div className="mt-4 flex min-w-0 flex-wrap items-baseline justify-between gap-x-4 gap-y-1.5 border-t border-border/40 pt-3 text-xs leading-relaxed text-muted-foreground">
          <p className="min-w-0 text-pretty">
            <time dateTime={updatedDate}>Updated {updatedDate}</time>
            {disclosure ? <> · {disclosure}</> : null}
          </p>
          <Link
            href="/about/#editorial-ai-policy"
            className="pharos-focus-ring -my-2 inline-flex min-h-8 shrink-0 items-center rounded-sm underline decoration-dashed underline-offset-2 hover:text-foreground"
          >
            AI policy
          </Link>
        </div>
      </CardContent>
    </Card>
  );
}
