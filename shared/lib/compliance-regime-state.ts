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
  sourceReferences?: {
    label: string;
    url: string;
  }[];
  reviewedAt: string;
}

export const GENIUS_REGIME_STATE = {
  publicLawDate: "2025-07-18",
  statutoryFallbackEffectiveDate: "2027-01-18",
  effectiveDate: "2027-01-18",
  rulemakingPhase: "proposed-rules",
  sourceLabel: "OCC Bulletin 2026-3",
  sourceUrl: "https://www.occ.gov/news-issuances/bulletins/2026/bulletin-2026-3.html",
  sourceReferences: [
    {
      label: "OCC Bulletin 2026-3",
      url: "https://www.occ.gov/news-issuances/bulletins/2026/bulletin-2026-3.html",
    },
    {
      label: "FDIC proposed PPSI application procedures",
      url: "https://www.fdic.gov/news/financial-institution-letters/2026/notice-proposed-rulemaking-establish-genius-act",
    },
    {
      label: "FDIC proposed PPSI requirements and standards",
      url: "https://www.fdic.gov/board/federal-register-notice-genius-act-requirements-and-standards-fdic-supervised-permitted",
    },
    {
      label: "FinCEN and OFAC proposed PPSI AML/CFT rule",
      url: "https://www.fincen.gov/system/files/2026-04/PPSI-AMLCFT-NPRM.pdf",
    },
    {
      label: "Treasury proposed state regime comparability rule",
      url: "https://home.treasury.gov/news/press-releases/sb0435",
    },
    {
      label: "FDIC proposed PPSI requirements and standards (May 2026)",
      url: "https://www.fdic.gov/news/press-releases/2026/fdic-approves-proposal-implement-genius-act-requirements-and-standards",
    },
    {
      label: "NCUA proposed PPSI application procedures",
      url: "https://ncua.gov/newsroom/press-release/2026/ncua-proposes-rule-permitted-payment-stablecoin-issuer-applications",
    },
    {
      label: "NCUA proposed PPSI requirements and standards (May 2026)",
      url: "https://ncua.gov/newsroom/press-release/2026/ncua-announces-proposed-rule-permitted-payment-stablecoin-issuer-standards",
    },
  ],
  reviewedAt: "2026-06-07",
} as const satisfies GeniusRegimeState;

export function isGeniusRegimeEffective(state: GeniusRegimeState = GENIUS_REGIME_STATE): boolean {
  return state.rulemakingPhase === "effective";
}
