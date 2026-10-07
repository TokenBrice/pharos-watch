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

/** `YYYY-MM-DD` day of an ISO date or timestamp; anything else is returned as-is. */
export function formatAiSummaryIsoDate(rawDate: string): string {
  return rawDate.match(/^\d{4}-\d{2}-\d{2}/)?.[0] ?? rawDate;
}

export interface AiDisclosureOptions {
  /**
   * `iso` prints review and facts dates as `YYYY-MM-DD`, the date grammar of
   * the dossier's provenance footers; `label` (default) keeps the day label.
   */
  dateFormat?: "label" | "iso";
}

export function buildAiDisclosureLine(
  fields: AiDisclosureFields,
  { dateFormat = "label" }: AiDisclosureOptions = {},
): string | null {
  const { authoredBy, model, reviewedBy, reviewedAt, factsAsOf } = fields;
  const formatDate = dateFormat === "iso" ? formatAiSummaryIsoDate : formatAiSummaryDate;

  if (!authoredBy && !model && !reviewedBy && !reviewedAt && !factsAsOf) {
    return null;
  }

  const authorLabel = authoredBy === "human" ? "Human summary" : "AI summary";
  const segments: string[] = [authorLabel];

  if (authoredBy === "ai" && model) {
    segments.push(`drafted by ${model}`);
  }
  if (reviewedBy && reviewedAt) {
    segments.push(`reviewed by ${reviewedBy} on ${formatDate(reviewedAt)}`);
  } else if (reviewedBy) {
    segments.push(`reviewed by ${reviewedBy}`);
  }
  if (factsAsOf) {
    segments.push(`facts as of ${formatDate(factsAsOf)}`);
  }

  return segments.join(" · ");
}
