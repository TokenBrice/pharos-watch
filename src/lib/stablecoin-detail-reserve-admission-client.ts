import methodologyPolicy from "@shared/data/safety-score-v9/methodology-policy-candidate-v1.json";
import { RESEARCH_REVIEW_CONFIDENCE_LABELS } from "@shared/lib/classification";
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
export type ReserveAdmissionBlocker =
  | "scope-missing"
  | "selected-slices"
  | "classification-only"
  | "dependency-relationships"
  | "unverified"
  | "undated";

export interface ReserveAdmissionClientSummary {
  blockers: ReserveAdmissionBlocker[];
  /** Review confidence label, set only with the `unverified` blocker. */
  confidenceLabel: string | null;
  compositionAsOf: string | null;
  /** The composition date as the evaluator reads it (UTC start of day); null without one. */
  compositionAtSec: number | null;
  /** The policy's curated-composition age budget, grace included. */
  maxAgeSec: number;
}

const EVIDENCE_EXPIRY = methodologyPolicy.semantic.evidence.evidenceExpiry;
const COMPOSITION_MAX_AGE_SEC =
  EVIDENCE_EXPIRY.reviewedReserveCompositionMaxAgeSec + EVIDENCE_EXPIRY.reviewedReserveCompositionGraceSec;

export function projectReserveAdmissionClientSummary(coin: StablecoinMeta): ReserveAdmissionClientSummary | null {
  const review = coin.reserveReview;
  if (!review || (coin.reserves?.length ?? 0) === 0) return null;
  const blockers: ReserveAdmissionBlocker[] = [];
  if (review.scope == null) blockers.push("scope-missing");
  else if (review.scope !== "full-composition") blockers.push(review.scope);
  const unverified = review.confidence !== "verified";
  if (unverified) blockers.push("unverified");
  // The evaluator reads a dated composition at its UTC start of day.
  const compositionAtMs = review.compositionAsOf ? Date.parse(review.compositionAsOf) : Number.NaN;
  if (!Number.isFinite(compositionAtMs)) blockers.push("undated");
  return {
    blockers,
    confidenceLabel: unverified ? RESEARCH_REVIEW_CONFIDENCE_LABELS[review.confidence] : null,
    compositionAsOf: review.compositionAsOf ?? null,
    compositionAtSec: Number.isFinite(compositionAtMs) ? Math.floor(compositionAtMs / 1_000) : null,
    maxAgeSec: COMPOSITION_MAX_AGE_SEC,
  };
}
