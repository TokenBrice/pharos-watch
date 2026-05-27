export type GeniusRulemakingPhase =
  | "pre-rulemaking"
  | "proposed-rules"
  | "final-rules-issued"
  | "effective";

export interface GeniusRegimeState {
  publicLawDate: string;
  finalRulesIssuedAt?: string;
  statutoryFallbackEffectiveDate: string;
  effectiveDate: string;
  rulemakingPhase: GeniusRulemakingPhase;
  sourceLabel: string;
  sourceUrl: string;
  reviewedAt: string;
}

export const GENIUS_REGIME_STATE = {
  publicLawDate: "2025-07-18",
  statutoryFallbackEffectiveDate: "2027-01-18",
  effectiveDate: "2027-01-18",
  rulemakingPhase: "proposed-rules",
  sourceLabel: "OCC Bulletin 2026-3",
  sourceUrl: "https://www.occ.gov/news-issuances/bulletins/2026/bulletin-2026-3.html",
  reviewedAt: "2026-05-27",
} as const satisfies GeniusRegimeState;

export function isGeniusRegimeEffective(state: GeniusRegimeState = GENIUS_REGIME_STATE): boolean {
  return state.rulemakingPhase === "effective";
}
