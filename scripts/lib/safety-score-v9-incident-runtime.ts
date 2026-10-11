import { V9NegativeIncidentReviewSchema, v9NegativeIncidentReviewTimeSec } from "../../shared/types/safety-score-v9-incidents";
import { V9_REVIEW_EVIDENCE_MAX_AGE_SEC } from "../../shared/lib/safety-score-v9/evidence";
import { ReviewEvidenceBuilder } from "../../shared/lib/safety-score-v9/review-evidence";

/**
 * Build-time projection: the full reviewed payload is hashed here, and the
 * runtime rebuilds each evidence row from its sorted-source URL and digest.
 */
export function projectNegativeIncidentReview(value: unknown) {
  const review = V9NegativeIncidentReviewSchema.parse(value);
  const reviewedAtSec = v9NegativeIncidentReviewTimeSec(review.reviewedAt);
  const builder = new ReviewEvidenceBuilder(review.assetId, reviewedAtSec);
  builder.add({ componentKeys: ["control"], sourceId: `safety-score-v9.negative-incident-review.${review.reviewId}`,
    reviewedAtSec, observedAtSec: review.windowEndSec, confidence: "manual-review", sources: review.sources,
    payload: review, maxAgeSec: V9_REVIEW_EVIDENCE_MAX_AGE_SEC });
  return { reviewId: review.reviewId, assetId: review.assetId, scope: review.scope,
    reviewedAt: review.reviewedAt, windowStartSec: review.windowStartSec, windowEndSec: review.windowEndSec,
    // Map insertion order is the builder's source index, which each evidence key embeds.
    // Digest first: a URL ending in a key-like word must not precede the hex value.
    sources: [...builder.evidence.values()].map((row): [string, string | null] => [row.contentSha256, row.url]) };
}
