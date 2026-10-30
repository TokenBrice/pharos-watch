import { z } from "zod";
import {
  V9AttributedNegativeIncidentReviewSchema,
  V9ProviderIncidentReviewSchema,
  V9ProviderIncidentReviewScopeSchema,
  v9NegativeIncidentReviewTimeSec,
  type V9IncidentReviewRetirement,
  type V9ProviderIncidentReviewScope,
} from "../../shared/types/safety-score-v9-incidents";
import { isRecord } from "../../shared/lib/type-guards";
import { compareText } from "../../shared/lib/safety-score-v9/primitives";
import { V9_REVIEW_EVIDENCE_MAX_AGE_SEC } from "../../shared/lib/safety-score-v9/evidence";
import { ReviewEvidenceBuilder } from "../../shared/lib/safety-score-v9/review-evidence";

/** The asset-attributed reviewed record kinds; the shared registry owns the union. */
export { V9AttributedNegativeIncidentReviewSchema };
export type V9AttributedNegativeIncidentReview = z.output<typeof V9AttributedNegativeIncidentReviewSchema>;

/**
 * The generated runtime row consumed by the Worker. `reviewId` is the authored
 * identity and is never rewritten; a provider-wide review contributes one row
 * per covered asset, so the Worker registry keys rows by `(assetId, reviewId)`.
 * Optional fields are absent, never null, so a legacy row keeps its
 * pre-migration bytes.
 */
export type ProjectedNegativeIncidentReview = {
  reviewId: string;
  assetId: string;
  scope: V9AttributedNegativeIncidentReview["scope"] | V9ProviderIncidentReviewScope;
  retired?: V9IncidentReviewRetirement;
  reviewedAt: string;
  windowStartSec: number;
  windowEndSec: number;
  sources: [string, string | null][];
};

type ProjectedReviewInput = {
  reviewId: string;
  assetId: string;
  scope: ProjectedNegativeIncidentReview["scope"];
  retired?: V9IncidentReviewRetirement;
  reviewedAt: string;
  windowStartSec: number;
  windowEndSec: number;
  sources: { label: string; url: string }[];
  payload: unknown;
};

/**
 * The parts of an authored provider row that decide its per-asset fan-out. The
 * full record (including expanded sources) is admitted after reference
 * expansion, so a malformed row still fails the build closed. Certificates are
 * joined at evaluation time, so a provider row names no certificate here.
 */
const AuthoredProviderReviewSchema = z.object({
  scope: V9ProviderIncidentReviewScopeSchema,
}).passthrough();

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
 * Fan one authored provider-wide row into one authored row per covered asset,
 * before any asset-attributed reference expansion. Scope is narrowed to that
 * asset's lanes, so a provider check can never speak to another asset's route.
 * Every authored lane must survive the fan-out; a silently dropped one fails the
 * build.
 */
export function fanOutProviderIncidentReview(value: Record<string, unknown>): Record<string, unknown>[] {
  const { scope } = AuthoredProviderReviewSchema.parse(value);
  const rows: Record<string, unknown>[] = [...new Set(scope.coveredRoutes.map((ref) => ref.assetId))].sort(compareText).map((assetId) => {
    const lanes = scope.coveredRoutes.filter((ref) => ref.assetId === assetId);
    return {
      ...value,
      assetId,
      scope: {
        kind: "provider",
        providerKey: scope.providerKey,
        surface: scope.surface,
        coveredRoutes: lanes,
      },
    };
  });
  const fannedLanes = rows.reduce((count, row) => count + (row.scope as V9ProviderIncidentReviewScope).coveredRoutes.length, 0);
  if (fannedLanes !== scope.coveredRoutes.length) {
    throw new Error("Provider review coverage must resolve to its covered assets");
  }
  return rows;
}

/**
 * One expanded per-asset provider row to its runtime row. The top-level
 * `assetId` is the fan-out attribution, not an authored field, so it is removed
 * before the strict provider schema re-admits the record.
 */
export function projectProviderIncidentRow(value: Record<string, unknown>): ProjectedNegativeIncidentReview {
  const { assetId, ...authored } = value;
  if (typeof assetId !== "string") throw new Error("A provider-wide runtime row requires its fan-out asset");
  const review = V9ProviderIncidentReviewSchema.parse(authored);
  const assetLocal = review.scope.coveredRoutes.every((ref) => ref.assetId === assetId);
  if (!assetLocal) throw new Error("A provider-wide runtime row may only carry its own asset's lanes");
  return projectReview({
    reviewId: review.reviewId,
    assetId,
    scope: review.scope,
    ...(review.retired === undefined ? {} : { retired: review.retired }),
    reviewedAt: review.reviewedAt,
    windowStartSec: review.windowStartSec,
    windowEndSec: review.windowEndSec,
    sources: review.sources,
    payload: review,
  });
}

/** Provider-wide rows are the only review kind without a top-level authored asset id. */
export function isProviderReview(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && isRecord(value.scope) && value.scope.kind === "provider";
}
