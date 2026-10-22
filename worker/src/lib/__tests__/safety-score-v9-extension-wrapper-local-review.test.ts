import { describe, expect, it } from "vitest";
import { getSafetyScoreV9WrapperLocalReviews } from "../safety-score-v9/extension-wrapper-reviews";
import { SafetyScoreV9WrapperLocalReviewSchema } from "@shared/types/safety-score-v9-wrapper-local-review";
import wrapperLocalReviews from "@shared/data/safety-score-v9/wrapper-allocation-reviews-v1.json";


describe("wrapper-local reviewed registry intake contract", () => {
  it("parses every curated local review under its exact identity schema", () => {
    const invalid = wrapperLocalReviews.localReviews.flatMap((review, index) => {
      const parsed = SafetyScoreV9WrapperLocalReviewSchema.safeParse(review);
      return parsed.success ? [] : [{ index, assetId: review.assetId, kind: review.kind, issues: parsed.error.issues }];
    });
    expect(invalid).toEqual([]);
  });




  it("returns no review for an instrument absent from the reviewed registry", () => {
    expect(getSafetyScoreV9WrapperLocalReviews("unreviewed-wrapper")).toEqual([]);
  });
});
