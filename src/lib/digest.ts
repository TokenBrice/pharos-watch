/**
 * Editorial typography system for the Digest feature.
 *
 * The digest uses a dual-font "intelligence briefing" aesthetic:
 * - Newsreader (serif) for headlines: refined editorial authority
 * - Courier (monospace italic) for body copy: raw wire-service urgency
 *
 * This pairing creates a distinctive newspaper/terminal hybrid that signals
 * both authority and real-time urgency — core to the Pharos brand personality.
 */

import { formatLongDate, formatShortDate } from "@shared/lib/format";

/** Inline style for body text — Courier italic for raw intel aesthetic */
export const EDITORIAL_BODY_STYLE: React.CSSProperties = {
  fontFamily: "'Courier New', Courier, monospace",
  fontStyle: "italic",
};

/** Inline style for metadata labels — Courier upright */
export const EDITORIAL_META_STYLE: React.CSSProperties = {
  fontFamily: "'Courier New', Courier, monospace",
};

/**
 * Format a digest date string ("YYYY-MM-DD" or "YYYY-MM-DD-weekly") into a
 * localized label, with the month rendered in the requested style.
 */
export function formatDigestDateLabel(dateStr: string, monthStyle: "long" | "short"): string {
  const parts = dateStr
    .replace(/-weekly$/, "")
    .split("-")
    .map(Number);
  if (parts.length !== 3 || parts.some(isNaN)) return dateStr;
  const [year, month, day] = parts;
  const date = new Date(year, month - 1, day);
  if (isNaN(date.getTime())) return dateStr;
  return monthStyle === "long" ? formatLongDate(date) : formatShortDate(date);
}

/**
 * Split digest text into paragraphs by double newlines.
 */
export function splitDigestParagraphs(text: string | null | undefined): string[] {
  if (!text) return [];

  return text
    .split(/\r?\n\s*\r?\n/g)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);
}

export function parseDigestParagraph(paragraph: string): { headerText: string | null; bodyText: string } {
  const headerMatch = paragraph.match(/^\*\*(.+?)\*\*\s*/);
  return {
    headerText: headerMatch?.[1]?.replace(/\.+$/, "") ?? null,
    bodyText: headerMatch ? paragraph.slice(headerMatch[0].length) : paragraph,
  };
}

/**
 * Get body paragraphs from digest data, falling back from extended to basic digest.
 */
export function getDigestBodyParagraphs({
  digest,
  digestExtended,
}: {
  digest: string | null | undefined;
  digestExtended: string | null | undefined;
}): string[] {
  const extendedParagraphs = splitDigestParagraphs(digestExtended);
  if (extendedParagraphs.length > 0) return extendedParagraphs;
  return splitDigestParagraphs(digest);
}
