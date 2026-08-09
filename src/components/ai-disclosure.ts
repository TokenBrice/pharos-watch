import type { StablecoinAiSummary } from "@shared/types";
import { formatUtcDayLabel } from "@shared/lib/format";

export type AiDisclosureFields = Pick<
  StablecoinAiSummary,
  "authoredBy" | "model" | "reviewedBy" | "reviewedAt" | "factsAsOf"
>;

export function formatAiSummaryDate(rawDate: string): string {
  const match = rawDate.match(/^(\d{4})-(\d{2})-(\d{2})$/);

  if (!match) {
    return rawDate;
  }

  const [, year, month, day] = match;
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));

  return formatUtcDayLabel(date);
}

export function buildAiDisclosureLine(fields: AiDisclosureFields): string | null {
  const { authoredBy, model, reviewedBy, reviewedAt, factsAsOf } = fields;

  if (!authoredBy && !model && !reviewedBy && !reviewedAt && !factsAsOf) {
    return null;
  }

  const authorLabel = authoredBy === "human" ? "Human summary" : "AI summary";
  const segments: string[] = [authorLabel];

  if (authoredBy === "ai" && model) {
    segments.push(`drafted by ${model}`);
  }
  if (reviewedBy && reviewedAt) {
    segments.push(`reviewed by ${reviewedBy} on ${formatAiSummaryDate(reviewedAt)}`);
  } else if (reviewedBy) {
    segments.push(`reviewed by ${reviewedBy}`);
  }
  if (factsAsOf) {
    segments.push(`facts as of ${formatAiSummaryDate(factsAsOf)}`);
  }

  return segments.join(" · ");
}
