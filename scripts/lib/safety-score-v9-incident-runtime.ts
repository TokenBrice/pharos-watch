import { z } from "zod";
import {
  V9AuthoredNegativeIncidentReviewSchema,
  V9IssuerSurfaceIncidentReviewSchema,
  V9ProviderIncidentReviewSchema,
  V9RetirableNegativeIncidentReviewSchema,
  v9NegativeIncidentReviewTimeSec,
  type V9IncidentReviewRetirement,
  type V9LaneScreeningRef,
  type V9ProviderIncidentReviewScope,
} from "../../shared/types/safety-score-v9-incidents";
import { isRecord } from "../../shared/lib/type-guards";
import { compareText } from "../../shared/lib/safety-score-v9/primitives";
import { V9_REVIEW_EVIDENCE_MAX_AGE_SEC } from "../../shared/lib/safety-score-v9/evidence";
import { ReviewEvidenceBuilder } from "../../shared/lib/safety-score-v9/review-evidence";

/**
 * The asset-attributed reviewed record kinds. Legacy digest scope (with its
 * v10.38 retirement field) stays admitted until the authored-identity migration
 * lands; authored control and issuer-surface rows cross the same strict schemas.
 * Provider-wide reviews carry no asset and project through `projectProviderIncidentReview`.
 */
export const V9AttributedNegativeIncidentReviewSchema = z.union([
  V9RetirableNegativeIncidentReviewSchema,
  V9AuthoredNegativeIncidentReviewSchema,
  V9IssuerSurfaceIncidentReviewSchema,
]);
export type V9AttributedNegativeIncidentReview = z.output<typeof V9AttributedNegativeIncidentReviewSchema>;

/**
 * The generated runtime row consumed by the Worker. A provider-wide review fans
 * out to one row per covered asset; `reviewId` is the authored identity and is
 * never rewritten, so the Worker registry must key runtime rows by
 * `(assetId, reviewId)`. Optional fields are absent, never null, so a legacy row
 * keeps its pre-migration bytes.
 */
export type ProjectedNegativeIncidentReview = {
  reviewId: string;
  assetId: string;
  scope: V9AttributedNegativeIncidentReview["scope"] | V9ProviderIncidentReviewScope;
  retired?: V9IncidentReviewRetirement;
  laneScreeningRefs?: V9LaneScreeningRef[];
  reviewedAt: string;
  windowStartSec: number;
  windowEndSec: number;
  sources: [string, string | null][];
};

type ProjectedReviewInput = {
  reviewId: string;
  assetId: string;
  scope: ProjectedNegativeIncidentReview["scope"];
  laneScreeningRefs?: V9LaneScreeningRef[];
  retired?: V9IncidentReviewRetirement;
  reviewedAt: string;
  windowStartSec: number;
  windowEndSec: number;
  sources: { label: string; url: string }[];
  payload: unknown;
};

/**
 * Build-time projection: the full reviewed payload is hashed here, and the
 * runtime rebuilds each evidence row from its sorted-source URL and digest.
 */
function projectReview(review: ProjectedReviewInput): ProjectedNegativeIncidentReview {
  const reviewedAtSec = v9NegativeIncidentReviewTimeSec(review.reviewedAt);
  const builder = new ReviewEvidenceBuilder(review.assetId, reviewedAtSec);
  builder.add({ componentKeys: ["control"], sourceId: `safety-score-v9.negative-incident-review.${review.reviewId}`,
    reviewedAtSec, observedAtSec: review.windowEndSec, confidence: "manual-review", sources: review.sources,
    payload: review.payload, maxAgeSec: V9_REVIEW_EVIDENCE_MAX_AGE_SEC });
  return { reviewId: review.reviewId, assetId: review.assetId, scope: review.scope,
    ...(review.retired === undefined ? {} : { retired: review.retired }),
    ...(review.laneScreeningRefs === undefined ? {} : { laneScreeningRefs: review.laneScreeningRefs }),
    reviewedAt: review.reviewedAt, windowStartSec: review.windowStartSec, windowEndSec: review.windowEndSec,
    // Map insertion order is the builder's source index, which each evidence key embeds.
    // Digest first: a URL ending in a key-like word must not precede the hex value.
    sources: [...builder.evidence.values()].map((row): [string, string | null] => [row.contentSha256, row.url]) };
}

/** One authored asset-attributed review to its single runtime row. */
export function projectNegativeIncidentReview(value: unknown): ProjectedNegativeIncidentReview {
  const review = V9AttributedNegativeIncidentReviewSchema.parse(value);
  return projectReview({
    reviewId: review.reviewId,
    assetId: review.assetId,
    scope: review.scope,
    ...(review.retired === undefined ? {} : { retired: review.retired }),
    reviewedAt: review.reviewedAt,
    windowStartSec: review.windowStartSec,
    windowEndSec: review.windowEndSec,
    sources: review.sources,
    payload: review,
  });
}

/**
 * One provider-wide review to one runtime row per covered asset. Scope and lane
 * screening references are narrowed to that asset's lanes, so a provider check
 * can never speak to another asset's route.
 */
export function projectProviderIncidentReview(value: unknown): ProjectedNegativeIncidentReview[] {
  const review = V9ProviderIncidentReviewSchema.parse(value);
  const coveredControls = review.scope.coveredControls;
  return [...new Set(review.scope.coveredRoutes.map((ref) => ref.assetId))].sort(compareText).map((assetId) => {
    const lanes = review.scope.coveredRoutes.filter((ref) => ref.assetId === assetId);
    const controls = coveredControls?.filter((ref) => ref.assetId === assetId);
    return projectReview({
      ...review,
      assetId,
      scope: {
        kind: "provider",
        providerKey: review.scope.providerKey,
        surface: review.scope.surface,
        coveredRoutes: lanes,
        ...(controls === undefined || controls.length === 0 ? {} : { coveredControls: controls }),
      },
      laneScreeningRefs: review.laneScreeningRefs.filter((ref) => ref.assetId === assetId),
      payload: review,
    });
  });
}

/** One authored review to its runtime rows: provider-wide reviews fan out per covered asset. */
export function projectIncidentReviews(value: unknown): ProjectedNegativeIncidentReview[] {
  return isProviderReview(value) ? projectProviderIncidentReview(value) : [projectNegativeIncidentReview(value)];
}

/** Provider-wide rows are the only review kind without a top-level asset id. */
export function isProviderReview(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && isRecord(value.scope) && value.scope.kind === "provider";
}
