import type { SafetyScoreV9CurrentCard } from "@shared/types";
import {
  exitReasonFallback,
  pillarBreakdown,
  type StablecoinSafetyScoreV9PillarBreakdown,
} from "@/lib/stablecoin-safety-score-v9-presentation-breakdowns";
import {
  describeSafetyScoreV9Components,
  humanizeSafetyScoreV9Value,
  isUnknownSafetyScoreV9Value,
  uniqueSafetyScoreV9Messages,
  type StablecoinSafetyScoreV9Component,
} from "@/lib/stablecoin-safety-score-v9-presentation-helpers";
import { SAFETY_SCORE_V9_EVIDENCE_LEVEL_DESCRIPTIONS } from "@/lib/safety-score-v9-labels";
import { readV9PricedUnknown, type V9PricedUnknown } from "@/lib/safety-score-v9-consumers";

const PILLARS = [
  ["backing", "Backing"],
  ["exit", "Exit"],
  ["control", "Economic Control"],
] as const;


export interface StablecoinSafetyScoreV9Presentation {
  evidenceSummary: string;
  pillars: Array<{
    key: "backing" | "exit" | "control";
    label: string;
    score: number | null;
    pricedUnknown: V9PricedUnknown | null;
    evidenceSummary: string;
    evidenceDescription: string | null;
    componentCount: number;
    components: StablecoinSafetyScoreV9Component[];
    breakdown: StablecoinSafetyScoreV9PillarBreakdown | null;
    reasons: string[];
  }>;
  primaryReasons: string[];
}

export function buildStablecoinSafetyScoreV9Presentation(
  card: SafetyScoreV9CurrentCard,
): StablecoinSafetyScoreV9Presentation {
  const hasIncompleteDexCoverage = card.scoreTrace.evidenceResponsibility.summaries.some(
    (summary) => summary.reasonCodes?.includes("incomplete-dex-route-coverage"),
  );
  return {
    pillars: PILLARS.map(([key, label]) => {
      const pillar = card.pillars[key];
      // "Evidence: strong", not "Strong evidence": beside a D the latter reads
      // as praise for the pillar rather than a statement about its inputs.
      const evidenceLevel = `Evidence: ${humanizeSafetyScoreV9Value(pillar.evidenceLevel).toLowerCase()}${
        key === "exit" ? " (selected route)" : ""
      }`;
      const baseEvidenceSummary = pillar.aggregationDisposition === "excluded-a-b"
        ? "Excluded until evidence is curated · 0% weight"
        : isUnknownSafetyScoreV9Value(pillar.freshness)
        ? evidenceLevel
        : `${evidenceLevel} · ${humanizeSafetyScoreV9Value(pillar.freshness).toLowerCase()}`;
      const evidenceSummary = key === "exit" && hasIncompleteDexCoverage
        ? `${baseEvidenceSummary} · partial DEX coverage`
        : baseEvidenceSummary;
      return {
        key,
        label,
        score: pillar.score,
        pricedUnknown: readV9PricedUnknown(card, key),
        evidenceSummary,
        evidenceDescription: pillar.aggregationDisposition === "excluded-a-b"
          ? null
          : SAFETY_SCORE_V9_EVIDENCE_LEVEL_DESCRIPTIONS[pillar.evidenceLevel] ?? null,
        componentCount: pillar.components.length,
        components: describeSafetyScoreV9Components(pillar.components),
        breakdown: pillarBreakdown(card, key),
        reasons: (() => {
          const producerReasons = uniqueSafetyScoreV9Messages(pillar.reasons.map((reason) => reason.message));
          if (producerReasons.length > 0 || key !== "exit" || card.breakdowns === null) {
            return producerReasons;
          }
          const fallback = exitReasonFallback(pillar.score, card.breakdowns.exit);
          return fallback === null ? [] : [fallback];
        })(),
      };
    }),
    evidenceSummary: isUnknownSafetyScoreV9Value(card.evidence.freshness)
      ? `${humanizeSafetyScoreV9Value(card.evidence.level)} coverage`
      : `${humanizeSafetyScoreV9Value(card.evidence.level)} coverage · ${humanizeSafetyScoreV9Value(card.evidence.freshness)}`,
    primaryReasons: uniqueSafetyScoreV9Messages([
      ...card.nrReasons.map((reason) => reason.message),
      ...card.accessPosture.reasons.map((reason) => reason.message),
    ]),
  };
}
