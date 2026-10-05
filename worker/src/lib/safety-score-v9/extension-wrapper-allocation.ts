import wrapperAllocationReviewsAsset from "@shared/data/safety-score-v9/wrapper-allocation-reviews-v1.json";
import { SafetyScoreV9WrapperAllocationReviewSchema, type SafetyScoreV9WrapperAllocationReview } from "@shared/types/safety-score-v9-allocation";
import { domainDigest } from "@shared/lib/safety-score-v9/primitives";
import { z } from "zod";

export const SAFETY_SCORE_V9_WRAPPER_ALLOCATION_REVIEWS_DIGEST = domainDigest(
  "safety-score-v9.wrapper-allocation-reviews.v1", wrapperAllocationReviewsAsset,
);

// Only malformed global envelopes/identities invalidate the cohort. Parse claim
// bytes lazily inside the caller's asset quarantine boundary.
const envelope = z.object({ schemaVersion: z.literal(1), reviews: z.array(z.object({ assetId: z.string().trim().min(1) }).passthrough()), localReviews: z.array(z.unknown()).optional() }).strict().parse(wrapperAllocationReviewsAsset);
const reviewsByAsset = new Map<string, unknown[]>();
for (const row of envelope.reviews) {
  const rows = reviewsByAsset.get(row.assetId) ?? [];
  rows.push(row);
  reviewsByAsset.set(row.assetId, rows);
}

export function getSafetyScoreV9WrapperAllocationReview(assetId: string, clockSec: number): SafetyScoreV9WrapperAllocationReview | null {
  const rows = reviewsByAsset.get(assetId);
  if (!rows) return null;
  if (rows.length !== 1) throw new Error(`Duplicate wrapper allocation review for ${assetId}`);
  const review = SafetyScoreV9WrapperAllocationReviewSchema.parse(rows[0]);
  if (review.scopeKind === "per-dimension") return review;
  const clockMs = clockSec * 1_000;
  return Date.parse(`${review.reviewedAt}T00:00:00.000Z`) <= clockMs && clockMs < Date.parse(`${review.expiresAt}T00:00:00.000Z`) ? review : null;
}
