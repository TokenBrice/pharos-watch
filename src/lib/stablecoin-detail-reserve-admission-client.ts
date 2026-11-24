import { RESEARCH_REVIEW_CONFIDENCE_LABELS } from "@shared/lib/classification";
import {
  projectReserveCompositionReviewFacts,
  resolveReviewedReserveCompositionBudget,
} from "@shared/lib/safety-score-v9/reserve-admission";
import type { ReserveCompositionReviewBlocker } from "@shared/types/safety-score-v9-public";
import type { StablecoinMeta } from "@shared/types/stablecoin-meta-schemas";

/**
 * Review facts that keep the curated reserve composition out of the Safety
 * Score, in the `projectReserveQualityClientSummary` pattern: the server
 * projects bounded labels from the server-only `reserveReview`, the client
 * compares them with the published card. The card decides admission;
 * `buildSafetyScoreV9ReviewedCuratedReserveRows` in
 * `worker/src/lib/safety-score-v9/extension-reserves.ts` owns the gates. This
 * only names the clock-free requirements the review misses (full-composition
 * scope, verified confidence, a composition date) and the policy's age budget.
 */
export type ReserveAdmissionBlocker = ReserveCompositionReviewBlocker;

export interface ReserveAdmissionClientSummary {
  blockers: ReserveAdmissionBlocker[];
  /** Review confidence label, set only with the `unverified` blocker. */
  confidenceLabel: string | null;
  compositionAsOf: string | null;
  /** The composition date as the evaluator reads it (UTC start of day); null without one. */
  compositionAtSec: number | null;
  /** The policy's curated-composition age budget for this review. */
  maxAgeSec: number;
}

export function projectReserveAdmissionClientSummary(coin: StablecoinMeta): ReserveAdmissionClientSummary | null {
  const review = coin.reserveReview;
  if (!review || (coin.reserves?.length ?? 0) === 0) return null;
  return {
    ...projectReserveCompositionReviewFacts(review),
    confidenceLabel: review.confidence !== "verified" ? RESEARCH_REVIEW_CONFIDENCE_LABELS[review.confidence] : null,
    compositionAsOf: review.compositionAsOf ?? null,
    maxAgeSec: resolveReviewedReserveCompositionBudget(review, null).maxAgeSec,
  };
}
