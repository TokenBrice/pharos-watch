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

/**
 * The same rule re-measured for the 22rem summary rail. The constants above
 * are sized for the main column, where a line carries ~150 characters; in the
 * rail a line carries roughly 45, so a 320-character lead is about seven lines
 * and the fold saves almost nothing. Four prose modules stacked in the rail
 * therefore read as one undifferentiated wall (owner feedback 2026-08-11).
 *
 * 150 characters is ~3 rail lines — enough for the reviewed claim, short
 * enough that the next module's title stays on screen.
 */
export const RAIL_PROSE_LEAD_CHARS = 150;
export const RAIL_PROSE_COLLAPSE_THRESHOLD = 200;

export function buildProseLead(text: string, leadChars: number = PROSE_LEAD_CHARS): string {
  const cut = text.slice(0, leadChars);
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > 0 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}
