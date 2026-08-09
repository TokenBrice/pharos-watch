/**
 * Shared fold rule for long reviewed prose in detail modules (mechanism
 * review, bridging, oracle & liquidation): cut in the string rather than with
 * `line-clamp` so the fold does not move with the viewport — at full card
 * width one clamped line already carries ~150 characters, so a line-based cut
 * hides almost nothing on wide screens.
 */

/** Collapsed length of the lead, in characters. */
export const PROSE_LEAD_CHARS = 320;

/** Prose at or under this length would lose nothing to the fold. */
export const PROSE_COLLAPSE_THRESHOLD = 420;

export function buildProseLead(text: string): string {
  const cut = text.slice(0, PROSE_LEAD_CHARS);
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > 0 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}
