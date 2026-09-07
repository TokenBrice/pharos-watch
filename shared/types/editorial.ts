/**
 * Registered live-value placeholders an AI summary may embed. The detail page
 * resolves each `placeholder` from the named `source` at render time so the
 * prose never prints a grade, score, or supply figure that drifts from the
 * hero and report card beside it. `factsAsOf` dates the editorial claim the
 * token replaced.
 */
export const AI_SUMMARY_CLAIM_REGISTRY = {
  grade: {
    placeholder: "{{grade}}",
    sources: [
      "report-card.grade",
      "report-card.pillars.backing.grade",
      "report-card.pillars.exit.grade",
      "report-card.pillars.control.grade",
      "peg-summary.grade",
    ],
  },
  score: {
    placeholder: "{{score}}",
    sources: [
      "report-card.score",
      "report-card.pillars.backing.score",
      "report-card.pillars.exit.score",
      "report-card.pillars.control.score",
      "peg-summary.score",
    ],
  },
  supplyUsd: {
    placeholder: "{{supplyUsd}}",
    sources: ["stablecoin.circulating-usd"],
  },
} as const;

export type AiSummaryClaimTokenName = keyof typeof AI_SUMMARY_CLAIM_REGISTRY;
export type AiSummaryClaimSource = (typeof AI_SUMMARY_CLAIM_REGISTRY)[AiSummaryClaimTokenName]["sources"][number];

type AiSummaryClaimTokenFor<Name extends AiSummaryClaimTokenName> = {
  token: Name;
  placeholder: (typeof AI_SUMMARY_CLAIM_REGISTRY)[Name]["placeholder"];
  source: (typeof AI_SUMMARY_CLAIM_REGISTRY)[Name]["sources"][number];
  factsAsOf: string;
};

export type AiSummaryClaimToken = {
  [Name in AiSummaryClaimTokenName]: AiSummaryClaimTokenFor<Name>;
}[AiSummaryClaimTokenName];

export type AiSummaryClaimValues = Partial<Record<AiSummaryClaimSource, string | number | null>>;

export interface StablecoinAiSummary {
  title: string;
  text: string;
  updatedAt: string;
  authoredBy?: "ai" | "human";
  model?: string;
  reviewedBy?: string;
  reviewedAt?: string;
  factsAsOf?: string;
  claimTokens?: readonly AiSummaryClaimToken[];
  sources?: Array<{
    label: string;
    url: `http${string}`;
  }>;
}

export type StablecoinAiSummariesById = Record<string, StablecoinAiSummary>;
