import reviewsAsset from "@shared/data/safety-score-v9/wrapper-allocation-reviews-v1.json";
import { SafetyScoreV9WrapperLocalReviewSchema, type SafetyScoreV9WrapperLocalReview } from "@shared/types/safety-score-v9-wrapper-local-review";
import { domainDigest } from "@shared/lib/safety-score-v9/primitives";
import { z } from "zod";

export const SAFETY_SCORE_V9_WRAPPER_LOCAL_REVIEWS_DIGEST = domainDigest("safety-score-v9.wrapper-local-reviews.v1", reviewsAsset.localReviews);
// Parse score-bearing rows inside the per-asset quarantine boundary.
const envelope = z.object({ schemaVersion: z.literal(1), reviews: z.array(z.unknown()), localReviews: z.array(z.object({ assetId: z.string().trim().min(1) }).passthrough()).optional() }).strict().parse(reviewsAsset);
const rowsByAsset = new Map<string, unknown[]>();
for (const row of envelope.localReviews ?? []) {
  const rows = rowsByAsset.get(row.assetId) ?? [];
  rows.push(row);
  rowsByAsset.set(row.assetId, rows);
}
export function getSafetyScoreV9WrapperLocalReviews(assetId: string): SafetyScoreV9WrapperLocalReview[] {
  const reviews = (rowsByAsset.get(assetId) ?? []).map((row) => SafetyScoreV9WrapperLocalReviewSchema.parse(row));
  if (new Set(reviews.map((review) => review.kind)).size !== reviews.length) throw new Error(`Duplicate wrapper-local review kind for ${assetId}`);
  return reviews;
}
