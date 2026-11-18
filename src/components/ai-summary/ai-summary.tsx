import { IntentLink } from "@/components/intent-link";
import { buildAiDisclosureLine, formatAiSummaryIsoDate } from "@/components/ai-summary/ai-disclosure";
import { AiSummaryProse } from "@/components/ai-summary/ai-summary-prose";
import { Card, CardHeader, CardContent } from "@/components/ui/card";
import { ModuleDisclosure } from "@/components/stablecoin-detail/module-disclosure";
import { DetailSectionTitle } from "@/components/stablecoin-detail/section-title";
import { TermText } from "@/components/term-text";
import type { AiSummaryClaimValues, StablecoinAiSummary } from "@shared/types/editorial";
import {
  hasAvailableAiSummaryClaims,
  resolveAiSummaryClaims,
} from "@shared/lib/ai-summary-claims";

export type AiSummaryProps = StablecoinAiSummary & {
  claimValues?: AiSummaryClaimValues;
  /**
   * A current danger or paused notice the dossier leads with. The note may not
   * reflect it, so its prose folds and the card says why, keeping the lead
   * slot the first thing read.
   */
  openNotice?: { title: string } | null;
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
  claimTokens,
  claimValues,
  openNotice = null,
}: AiSummaryProps) {
  // One date grammar across the card: ISO days, as in every dossier footer.
  const updatedDate = formatAiSummaryIsoDate(updatedAt);
  const disclosure = buildAiDisclosureLine(
    { authoredBy, model, reviewedBy, reviewedAt, factsAsOf },
    { dateFormat: "iso" },
  );
  // A claim without its input is withheld, never rendered as "N/A"; this card
  // is already the live dossier, so there is no other page to point readers to.
  if (!hasAvailableAiSummaryClaims(text, claimTokens, claimValues)) return null;
  const resolved = resolveAiSummaryClaims(text, claimTokens, claimValues);

  return (
    <Card>
      <CardHeader>
        <DetailSectionTitle>{title}</DetailSectionTitle>
      </CardHeader>
      <CardContent>
        {openNotice ? (
          <>
            <p className="text-pretty text-sm text-muted-foreground" data-ai-summary-held>
              May not reflect the current notice: {openNotice.title}.
            </p>
            <ModuleDisclosure label="Editorial note" className="mt-1">
              <AiSummaryProse textLength={resolved.text.length} clamp={false}>
                <TermText text={resolved.text} />
              </AiSummaryProse>
            </ModuleDisclosure>
          </>
        ) : (
          <AiSummaryProse textLength={resolved.text.length}>
            <TermText text={resolved.text} />
          </AiSummaryProse>
        )}
        {/* Provenance footer: one sentence-case line (dateline + disclosure),
            the policy link at the far edge, in the dossier footer grammar. */}
        <div className="mt-4 flex min-w-0 flex-wrap items-baseline justify-between gap-x-4 gap-y-1.5 border-t border-border/40 pt-3 text-xs leading-relaxed text-muted-foreground">
          <p className="min-w-0 text-pretty">
            <time dateTime={updatedDate}>Updated {updatedDate}</time>
            {disclosure ? <> · {disclosure}</> : null}
          </p>
          <IntentLink
            href="/about/#editorial-ai-policy"
            className="pharos-focus-ring -my-2 inline-flex min-h-8 shrink-0 items-center rounded-sm underline decoration-dashed underline-offset-2 hover:text-foreground"
          >
            AI policy
          </IntentLink>
        </div>
      </CardContent>
    </Card>
  );
}
