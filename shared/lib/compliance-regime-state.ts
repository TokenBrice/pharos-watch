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
  sourceLabel: "GENIUS Act Public Law 119-27, section 20",
  sourceUrl: "https://www.congress.gov/119/plaws/publ27/PLAW-119publ27.pdf",
  sourceReferences: [
    {
      label: "Treasury GENIUS Act implementation ANPRM (90 FR 45159)",
      url: "https://www.govinfo.gov/content/pkg/FR-2025-09-19/html/2025-18226.htm",
    },
    {
      label: "FDIC proposed approval requirements for IDI subsidiary issuers (90 FR 59409)",
      url: "https://www.govinfo.gov/content/pkg/FR-2025-12-19/html/2025-23510.htm",
    },
    {
      label: "NCUA proposed investments in and licensing of PPSIs (91 FR 6531)",
      url: "https://www.govinfo.gov/content/pkg/FR-2026-02-12/html/2026-02868.htm",
    },
    {
      label: "OCC proposed GENIUS implementing rule (91 FR 10202)",
      url: "https://www.govinfo.gov/content/pkg/FR-2026-03-02/html/2026-04089.htm",
    },
    {
      label: "Treasury proposed state-regime substantial-similarity principles (91 FR 16844)",
      url: "https://www.govinfo.gov/content/pkg/FR-2026-04-03/html/2026-06489.htm",
    },
    {
      label: "FinCEN and OFAC proposed PPSI AML/CFT and sanctions programs (91 FR 18582)",
      url: "https://www.govinfo.gov/content/pkg/FR-2026-04-10/html/2026-06963.htm",
    },
    {
      label: "FDIC proposed PPSI requirements and standards (91 FR 18534)",
      url: "https://www.govinfo.gov/content/pkg/FR-2026-04-10/html/2026-06974.htm",
    },
    {
      label: "NCUA supplemental proposed GENIUS implementing rule (91 FR 28956)",
      url: "https://www.govinfo.gov/content/pkg/FR-2026-05-18/html/2026-09915.htm",
    },
    {
      label: "FDIC proposed PPSI BSA and sanctions standards (91 FR 34171)",
      url: "https://www.govinfo.gov/content/pkg/FR-2026-06-05/html/2026-11342.htm",
    },
    {
      label: "OCC proposed PPSI reporting forms (91 FR 35795)",
      url: "https://www.govinfo.gov/content/pkg/FR-2026-06-12/html/2026-11856.htm",
    },
    {
      label: "Joint proposed PPSI customer identification program (91 FR 37234)",
      url: "https://www.govinfo.gov/content/pkg/FR-2026-06-22/html/2026-12460.htm",
    },
    {
      label: "OCC proposed PPSI AML/CFT and sanctions risk management (91 FR 37840)",
      url: "https://www.govinfo.gov/content/pkg/FR-2026-06-24/html/2026-12692.htm",
    },
    {
      label: "FDIC proposed PPSI reporting forms (91 FR 45274)",
      url: "https://www.govinfo.gov/content/pkg/FR-2026-07-20/html/2026-14589.htm",
    },
    {
      label: "OCC proposed GENIUS licensing and registration application forms (91 FR 47032)",
      url: "https://www.govinfo.gov/content/pkg/FR-2026-07-27/html/2026-15088.htm",
    },
    {
      label: "Treasury proposed issuance, offer, and sale regulations (91 FR 53368)",
      url: "https://www.govinfo.gov/content/pkg/FR-2026-08-18/html/2026-16796.htm",
    },
    {
      label: "Federal Reserve proposed GENIUS responsibilities rule (91 FR 61580)",
      url: "https://www.govinfo.gov/content/pkg/FR-2026-09-29/html/2026-19860.htm",
    },
    {
      label: "Federal Reserve proposed IDI subsidiary application procedures (91 FR 61346)",
      url: "https://www.govinfo.gov/content/pkg/FR-2026-09-29/html/2026-19899.htm",
    },
    {
      label: "SCRC interim final procedural rule for state certifications (91 FR 61688)",
      url: "https://www.govinfo.gov/content/pkg/FR-2026-09-30/html/2026-19966.htm",
    },
  ],
  reviewedAt: "2026-10-07",
} as const satisfies GeniusRegimeState;

export function isGeniusRegimeEffective(state: GeniusRegimeState = GENIUS_REGIME_STATE): boolean {
  return state.rulemakingPhase === "effective";
}
