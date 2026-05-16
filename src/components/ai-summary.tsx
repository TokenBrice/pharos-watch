import type { ReactNode } from "react";
import { AiDisclosureBadge } from "@/components/ai-disclosure-badge";
import { Card, CardHeader, CardContent } from "@/components/ui/card";
import { DetailSectionTitle } from "@/components/stablecoin-detail/section-title";
import { Term } from "@/components/term";
import type { StablecoinAiSummary } from "@shared/types";

function renderWithTerms(text: string): ReactNode[] {
  const tokens: ReactNode[] = [];
  const regex = /\{\{term:([a-z][a-z0-9-]*)\}\}([\s\S]*?)\{\{\/term\}\}/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let key = 0;
  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) tokens.push(text.slice(lastIndex, match.index));
    const [, slug, label] = match;
    tokens.push(
      <Term key={`term-${key++}`} slug={slug}>
        {label}
      </Term>,
    );
    lastIndex = regex.lastIndex;
  }
  if (lastIndex < text.length) tokens.push(text.slice(lastIndex));
  return tokens;
}

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
        <div className="flex items-center justify-between gap-2">
          <DetailSectionTitle>{title}</DetailSectionTitle>
          <time className="text-xs text-muted-foreground whitespace-nowrap" dateTime={isoDate}>
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
          {renderWithTerms(text)}
        </p>
      </CardContent>
    </Card>
  );
}
