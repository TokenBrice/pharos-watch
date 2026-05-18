import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import type { StablecoinAiSummary } from "@shared/types";

type DisclosureFields = Pick<
  StablecoinAiSummary,
  "authoredBy" | "model" | "reviewedBy" | "reviewedAt" | "factsAsOf"
>;

function formatIsoDate(rawDate: string): string {
  const match = rawDate.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return rawDate;
  const [, year, month, day] = match;
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(date);
}

export function AiDisclosureBadge(props: DisclosureFields) {
  const { authoredBy, model, reviewedBy, reviewedAt, factsAsOf } = props;
  if (!authoredBy && !model && !reviewedBy && !reviewedAt && !factsAsOf) {
    return null;
  }

  const authorLabel = authoredBy === "human" ? "Human summary" : "AI summary";
  const segments: string[] = [authorLabel];

  if (authoredBy === "ai" && model) {
    segments.push(`drafted by ${model}`);
  }
  if (reviewedBy && reviewedAt) {
    segments.push(`reviewed by ${reviewedBy} on ${formatIsoDate(reviewedAt)}`);
  } else if (reviewedBy) {
    segments.push(`reviewed by ${reviewedBy}`);
  }
  if (factsAsOf) {
    segments.push(`facts as of ${formatIsoDate(factsAsOf)}`);
  }

  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2">
      <Badge
        variant="outline"
        className="min-w-0 max-w-full shrink whitespace-normal break-words text-left text-[11px] font-medium leading-snug text-muted-foreground"
        data-slot="ai-disclosure-badge"
      >
        {segments.join(" · ")}
      </Badge>
      <Link
        href="/about/editorial/#editorial-ai-policy"
        className="pharos-focus-ring rounded-sm text-[11px] text-muted-foreground underline decoration-dashed underline-offset-2 hover:text-foreground"
      >
        Policy →
      </Link>
    </div>
  );
}
