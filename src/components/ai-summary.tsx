import { AiDisclosureBadge } from "@/components/ai-disclosure-badge";
import { Card, CardHeader, CardContent } from "@/components/ui/card";
import { DetailSectionTitle } from "@/components/stablecoin-detail/section-title";
import { TermText } from "@/components/term-text";
import type { StablecoinAiSummary } from "@shared/types";

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
  const dateline = new Date(`${updatedAt}T00:00:00Z`).toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });

  return (
    <Card>
      <CardHeader>
        <div className="flex min-w-0 flex-col items-start gap-1.5 sm:flex-row sm:items-center sm:justify-between sm:gap-2">
          <DetailSectionTitle>{title}</DetailSectionTitle>
          <time className="text-xs text-muted-foreground sm:whitespace-nowrap" dateTime={isoDate}>
            Updated {dateline}
          </time>
        </div>
        <AiDisclosureBadge
          authoredBy={authoredBy}
          model={model}
          reviewedBy={reviewedBy}
          reviewedAt={reviewedAt}
          factsAsOf={factsAsOf}
        />
      </CardHeader>
      <CardContent>
        <p className="font-serif text-[1.05rem] leading-relaxed text-foreground/90 italic">
          <TermText text={text} />
        </p>
      </CardContent>
    </Card>
  );
}
