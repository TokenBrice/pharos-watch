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
 *
 *   6. **Promotion threshold** lives in `qualifiesForEditorialBriefing()`:
 *      peak deviation ≥ 200 bps, duration ≥ 6 hours, curated annotation
 *      present, or explicit editorial entry. Below-threshold events keep the
 *      structural-record treatment.
 */

export interface DepegEditorial {
  lede: string;
  timeline: string;
  watchpoints: string;
}

const EDITORIALS: Record<string, DepegEditorial> = {
  // USDC depeg, March 11, 2023.
  //
  // Recorded: peak deviation 1,300 bps (13.0%) below peg; peak price $0.87;
  // start $1.00; recovery $1.00 by 2023-03-13. Confirmed depeg event,
  // backfill, single curated SVB-exposure annotation.
  "usdc-2023-03-11": {
    lede:
      "The weekend Silicon Valley Bank froze and $3.3 billion of Circle reserves moved through a 13-cent gap before the Federal Reserve guaranteed the deposits at Monday open.",
    timeline:
      "Circle disclosed late on Friday, March 10 that $3.3 billion of the USDC reserve — roughly 8% of cash backing — sat at Silicon Valley Bank, which had been taken into receivership earlier that day. Redemption queues stalled, secondary markets reopened first, and the price fell from $1.00 through Saturday into a Sunday low near $0.87 — a peak deviation of 13.0% below peg, the largest ever recorded for the issuer.\n\nThe deviation closed in under two days. On Sunday, March 12, the Federal Reserve, FDIC, and Treasury jointly announced that all SVB deposits would be made whole; Circle confirmed access to the funds before Monday open and posted a primary-source statement. By the New York session on March 13, USDC was trading at parity again and the curated annotation for the incident pins the cluster to the Sunday-low timestamp rather than the Friday disclosure.",
    watchpoints:
      "Banking-channel concentration risk on regulated USD stablecoins remains a structural exposure, not a one-off. Watch the disclosure cadence around quarterly attestations and the named-bank composition of cash reserves, particularly for issuers with a single primary settlement bank. A federal backstop is not the base case; the recovery here was contingent on a specific policy decision over a specific weekend.",
  },
};

export function getDepegEditorial(slug: string): DepegEditorial | null {
  return EDITORIALS[slug] ?? null;
}

/**
 * Promotion threshold for the authored briefing layout. Events below the
 * threshold retain the structural-record treatment.
 *
 * The thresholds mirror the brief: peak deviation ≥ 200 bps, duration ≥ 6
 * hours, curated annotation present, or an explicit editorial entry. The
 * MIN_DEPEG_PAGE_DEVIATION_BPS gate (500 bps) is a separate, stricter check
 * that controls whether the page exists at all; this gate decides only the
 * presentation register on pages that already qualify for a route.
 */
const EDITORIAL_DEVIATION_THRESHOLD_BPS = 200;
const EDITORIAL_DURATION_THRESHOLD_SEC = 6 * 60 * 60;

export interface EditorialEligibilityInput {
  peakDeviationBps: number;
  startedAt: number;
  endedAt: number | null;
  hasCuratedAnnotation: boolean;
  hasAuthoredEditorial: boolean;
}

export function qualifiesForEditorialBriefing(input: EditorialEligibilityInput): boolean {
  if (input.hasAuthoredEditorial) return true;
  if (Math.abs(input.peakDeviationBps) >= EDITORIAL_DEVIATION_THRESHOLD_BPS) return true;
  if (input.hasCuratedAnnotation) return true;
  const durationSec = input.endedAt != null ? input.endedAt - input.startedAt : null;
  if (durationSec != null && durationSec >= EDITORIAL_DURATION_THRESHOLD_SEC) return true;
  return false;
}
