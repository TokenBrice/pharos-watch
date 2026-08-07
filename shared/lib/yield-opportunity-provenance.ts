/**
 * Provenance vocabulary for yield rows whose safety grade is opportunity-derived.
 *
 * Yield Intelligence mints two grades that are *not* Safety Score V9: the Royco
 * Dawn tranche model (`royco-tranche-safety.ts`) and the external-opportunity
 * assessment (`yield-opportunity-risk.ts`). Both publish into the same
 * `safetyScore` / `safetyGrade` fields as the underlying stablecoin's V9 card
 * and render in V9's visual language, so without a label a reader cannot tell
 * which judgment they are looking at — and the Selector ingests the substituted
 * value as `safetyOverall` for tranche rows.
 *
 * Every surface that renders one of these grades, and the Selector's ingestion
 * path, labels it from here.
 */

/** `YieldRankingProvenance["safetyProvenance"]` value that marks the substitution. */
export const YIELD_OPPORTUNITY_SAFETY_PROVENANCE = "opportunity-safety" as const;

/** Short badge-adjacent label. */
export const YIELD_OPPORTUNITY_SAFETY_LABEL = "Opportunity-derived";

/** One-line explanation for tooltips, screen-reader labels, and authored prose. */
export const YIELD_OPPORTUNITY_SAFETY_DESCRIPTION =
  "Opportunity-derived grade from the yield model, not the stablecoin's Safety Score.";

/**
 * True when a yield row's safety grade came from the opportunity model rather
 * than the published Safety Score V9 card.
 */
export function isOpportunityDerivedSafety(
  safetyProvenance: string | null | undefined,
): boolean {
  return safetyProvenance === YIELD_OPPORTUNITY_SAFETY_PROVENANCE;
}
