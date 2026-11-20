import policy from "../../data/safety-score-v9/methodology-policy-candidate-v1.json";
import type { ReserveCompositionReviewBlocker } from "../../types/safety-score-v9-public";
import type { ReserveReview } from "../../types/stablecoin-meta-primitives";

const expiry = policy.semantic.evidence.evidenceExpiry;
// Monthly reports commonly land in the first week after month-end.
export const REVIEWED_RESERVE_COMPOSITION_ADMISSION_MAX_AGE_SEC =
  expiry.reviewedReserveCompositionMaxAgeSec + expiry.reviewedReserveCompositionGraceSec;

export function projectReserveCompositionReviewFacts(review: ReserveReview) {
  const blockers: ReserveCompositionReviewBlocker[] = [];
  if (review.scope == null) blockers.push("scope-missing");
  else if (review.scope !== "full-composition") blockers.push(review.scope);
  if (review.confidence !== "verified") blockers.push("unverified");
  const compositionAtMs = review.compositionAsOf ? Date.parse(review.compositionAsOf) : Number.NaN;
  const compositionAtSec = Number.isFinite(compositionAtMs) ? Math.floor(compositionAtMs / 1_000) : null;
  if (compositionAtSec === null) blockers.push("undated");
  return { blockers, compositionAtSec };
}
