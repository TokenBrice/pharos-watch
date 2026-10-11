import { describe, expect, it } from "vitest";
import source from "../../shared/data/safety-score-v9/incident-reviews-v1.json";
import generated from "../../shared/data/safety-score-v9/incident-runtime-v1.generated.json";
import { buildIncidentRuntime } from "../build-data/generate-safety-score-v9-incident-runtime";
import { projectNegativeIncidentReview } from "../lib/safety-score-v9-incident-runtime";
import { ReviewEvidenceBuilder } from "../../shared/lib/safety-score-v9/review-evidence";
import { V9NegativeIncidentReviewSchema, v9NegativeIncidentReviewTimeSec } from "../../shared/types/safety-score-v9-incidents";
import { V9_REVIEW_EVIDENCE_MAX_AGE_SEC } from "../../shared/lib/safety-score-v9/evidence";

describe("incident runtime projection", () => {
  it("is current and preserves every original content digest and evidence identity", () => {
    expect(buildIncidentRuntime(source)).toEqual(generated);
    for (const value of source.negativeReviews) {
      const review = V9NegativeIncidentReviewSchema.parse(value);
      const clock = v9NegativeIncidentReviewTimeSec(review.reviewedAt);
      const original = new ReviewEvidenceBuilder(review.assetId, clock);
      original.add({ componentKeys: ["control"], sourceId: `safety-score-v9.negative-incident-review.${review.reviewId}`,
        reviewedAtSec: clock, observedAtSec: review.windowEndSec, confidence: "manual-review",
        sources: review.sources, payload: review, maxAgeSec: V9_REVIEW_EVIDENCE_MAX_AGE_SEC });
      expect(projectNegativeIncidentReview(review).evidence).toEqual(original.finish().researchEvidence);
    }
  });
  it("fails closed on missing research surfaces and future observations", () => {
    expect(() => projectNegativeIncidentReview({ ...source.negativeReviews[0], searchedSurfaces: [] })).toThrow();
    expect(() => projectNegativeIncidentReview({ ...source.negativeReviews[0], windowEndSec: Number.MAX_SAFE_INTEGER })).toThrow();
  });
});
