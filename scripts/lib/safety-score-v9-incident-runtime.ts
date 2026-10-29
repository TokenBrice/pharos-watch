import { z } from "zod";
import {
  V9AuthoredNegativeIncidentReviewSchema,
  V9IssuerSurfaceIncidentReviewSchema,
  V9NegativeIncidentReviewSchema,
  V9ProviderIncidentReviewSchema,
  v9NegativeIncidentReviewTimeSec,
  type V9IncidentReviewRetirement,
  type V9LaneScreeningRef,
} from "../../shared/types/safety-score-v9-incidents";
import { V9_REVIEW_EVIDENCE_MAX_AGE_SEC } from "../../shared/lib/safety-score-v9/evidence";
import { ReviewEvidenceBuilder } from "../../shared/lib/safety-score-v9/review-evidence";

/**
 * Every reviewed record kind the incident runtime admits. The legacy digest
 * scope stays admitted until the authored-identity migration lands; authored
 * control rows, issuer-surface rows and provider rows (with their lane
 * screening certificate references) cross the same strict schemas as the
 * legacy rows, so a malformed request never reaches the artifact.
 */
export const V9AdmittedNegativeIncidentReviewSchema = z.union([
  V9NegativeIncidentReviewSchema,
  V9AuthoredNegativeIncidentReviewSchema,
  V9IssuerSurfaceIncidentReviewSchema,
  V9ProviderIncidentReviewSchema,
]);
export type V9AdmittedNegativeIncidentReview = z.output<typeof V9AdmittedNegativeIncidentReviewSchema>;

/**
 * The generated runtime row consumed by the Worker. Authored identity,
 * retirement and lane screening references are carried verbatim; optional
 * fields are absent, never null, so a legacy row keeps its pre-migration bytes.
 */
export type ProjectedNegativeIncidentReview = {
  reviewId: string;
  assetId: string;
  scope: V9AdmittedNegativeIncidentReview["scope"];
  retired?: V9IncidentReviewRetirement;
  laneScreeningRefs?: V9LaneScreeningRef[];
  reviewedAt: string;
  windowStartSec: number;
  windowEndSec: number;
  sources: [string, string | null][];
};

/**
 * Build-time projection: the full reviewed payload is hashed here, and the
 * runtime rebuilds each evidence row from its sorted-source URL and digest.
 */
export function projectNegativeIncidentReview(value: unknown): ProjectedNegativeIncidentReview {
  const review = V9AdmittedNegativeIncidentReviewSchema.parse(value);
  const reviewedAtSec = v9NegativeIncidentReviewTimeSec(review.reviewedAt);
  const builder = new ReviewEvidenceBuilder(review.assetId, reviewedAtSec);
  builder.add({ componentKeys: ["control"], sourceId: `safety-score-v9.negative-incident-review.${review.reviewId}`,
    reviewedAtSec, observedAtSec: review.windowEndSec, confidence: "manual-review", sources: review.sources,
    payload: review, maxAgeSec: V9_REVIEW_EVIDENCE_MAX_AGE_SEC });
  return { reviewId: review.reviewId, assetId: review.assetId, scope: review.scope,
    ...(review.retired === undefined ? {} : { retired: review.retired }),
    ...("laneScreeningRefs" in review ? { laneScreeningRefs: review.laneScreeningRefs } : {}),
    reviewedAt: review.reviewedAt, windowStartSec: review.windowStartSec, windowEndSec: review.windowEndSec,
    // Map insertion order is the builder's source index, which each evidence key embeds.
    // Digest first: a URL ending in a key-like word must not precede the hex value.
    sources: [...builder.evidence.values()].map((row): [string, string | null] => [row.contentSha256, row.url]) };
}
