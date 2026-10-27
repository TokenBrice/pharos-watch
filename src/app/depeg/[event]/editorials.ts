/**
 * Authored editorial briefings for confirmed depeg events.
 *
 * Keyed by the event slug emitted by `scripts/maintenance/sync-depeg-events.ts`
 * (`<symbol-lowercase>-<YYYY-MM-DD>` with optional `-up`/`-down`). The slug
 * derivation is stable across rebuilds, so authored entries persist as long as
 * the event remains confirmed.
 *
 * Routing rules — see `src/app/depeg/[event]/page.tsx`:
 *
 *   1. **Author with conviction.** Every entry is practitioner-grade, anchored
 *      in the actual recorded peg deviation, duration, and recovery. Never
 *      speculative. Numbers should match the event record.
 *
 *   2. **Lede ≤ 240 chars.** One sentence, Newsreader serif, sets the scene
 *      in the register of a wire-service first paragraph. Lead with the cause,
 *      not the consequence. Treat the lede as the briefing's standfirst.
 *
 *   3. **Timeline: two paragraphs.** Courier-italic, Digest editorial body
 *      style. Paragraph one traces the descent — what happened, in what order,
 *      with the actual numbers. Paragraph two traces the recovery — what
 *      restored confidence and what was left changed.
 *
 *   4. **Watchpoints: 2–3 sentences.** Same Courier-italic register. Forward-
 *      looking risks that this incident exposed — never advice, never prediction,
 *      always "what to monitor if this pattern recurs."
 *
 *   5. **No proprietary names without the band.** When referring to Pharos
 *      grades or signals, use the proper-noun form (PegScore, DEWS, Bluechip).
 */

export interface DepegEditorial {
  lede: string;
  timeline: string;
  watchpoints: string;
}

const EDITORIALS: Record<string, DepegEditorial> = {
  // USDC depeg, March 11, 2023.
  //
  // Recorded (event 83750): peak deviation -1,211 bps (12.1%) below peg; low
  // $0.8789; start $0.9841; recorded recovery $0.9937. Parity-return context
  // from Circle and the Federal Reserve is sourced separately and never
  // substituted for the recorded figures. Confirmed depeg event, backfill,
  // single curated SVB-exposure annotation.
  "usdc-2023-03-11": {
    lede:
      "After Circle disclosed $3.3 billion of reserves at Silicon Valley Bank, USDC fell 12.1% below peg in Pharos\u2019s record.",
    timeline:
      "Circle disclosed on March 10, 2023 that $3.3 billion, about 8% of USDC reserves, was held at Silicon Valley Bank. Pharos\u2019s record of the event opens at $0.9841, reaches a low of $0.8789 and closes at $0.9937.\n\nOn March 12, the Federal Reserve, FDIC and Treasury announced that SVB depositors would have access to all their money beginning March 13. Circle\u2019s own release describes the reserve risk as removed and the dollar depeg as closing.",
    watchpoints:
      "Banking-channel concentration risk on regulated USD stablecoins remains a structural exposure, not a one-off. Watch the disclosure cadence around quarterly attestations and the named-bank composition of cash reserves, particularly for issuers with a single primary settlement bank. A federal backstop is not the base case; the recovery here was contingent on a specific policy decision over a specific weekend.",
  },
};

export function getDepegEditorial(slug: string): DepegEditorial | null {
  return EDITORIALS[slug] ?? null;
}
