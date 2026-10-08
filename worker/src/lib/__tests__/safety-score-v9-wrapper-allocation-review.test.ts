import { describe, expect, it } from "vitest";
import reviews from "@shared/data/safety-score-v9/wrapper-allocation-reviews-v1.json";
import { SafetyScoreV9WrapperAllocationReviewSchema } from "@shared/types/safety-score-v9-allocation";
import { getSafetyScoreV9WrapperAllocationReview } from "../safety-score-v9/extension-wrapper-allocation";

describe("wrapper allocation review admission", () => {
  it("does not infer a review for an unknown asset", () => {
    expect(getSafetyScoreV9WrapperAllocationReview("unreviewed-test-asset", 1_800_000_000)).toBeNull();
  });

  it.each(reviews.reviews.map((row) => [row.assetId, row] as const))(
    "retrieves each authored review by identity and enforces its admission window: %s", (assetId, row) => {
      const parsed = SafetyScoreV9WrapperAllocationReviewSchema.parse(row);
      const reviewedAt = parsed.scopeKind === "whole-allocation"
        ? Date.parse(`${parsed.reviewedAt}T00:00:00.000Z`) / 1000
        : 1_800_000_000;
      const admitted = getSafetyScoreV9WrapperAllocationReview(assetId, reviewedAt);
      expect(admitted?.assetId).toBe(assetId);
      expect(admitted?.scopeKind).toBe(parsed.scopeKind);
      if (parsed.scopeKind === "whole-allocation") {
        const expiresAt = Date.parse(`${parsed.expiresAt}T00:00:00.000Z`) / 1000;
        expect(getSafetyScoreV9WrapperAllocationReview(assetId, reviewedAt - 1)).toBeNull();
        expect(getSafetyScoreV9WrapperAllocationReview(assetId, expiresAt - 1)?.assetId).toBe(assetId);
        expect(getSafetyScoreV9WrapperAllocationReview(assetId, expiresAt)).toBeNull();
      }
    },
  );
});
