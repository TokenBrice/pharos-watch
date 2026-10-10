import { afterEach, describe, expect, it, vi } from "vitest";
import reviews from "@shared/data/safety-score-v9/wrapper-allocation-reviews-v1.json";
import { SafetyScoreV9WrapperAllocationReviewSchema } from "@shared/types/safety-score-v9-allocation";
import { getSafetyScoreV9WrapperAllocationReview, SAFETY_SCORE_V9_WRAPPER_ALLOCATION_REVIEWS_DIGEST, SAFETY_SCORE_V9_WRAPPER_LOCAL_REVIEWS_DIGEST } from "../safety-score-v9/extension-wrapper-reviews";
import { domainDigest } from "@shared/lib/safety-score-v9/primitives";
import { makeV9TwoAssetFixedInput } from "../../test-helpers/v9-fixed-input";
import { alphaMeta } from "./safety-score-v9-fact-set.test-support";

afterEach(() => {
  vi.doUnmock("@shared/data/safety-score-v9/wrapper-allocation-reviews-v1.json");
  vi.resetModules();
});

describe("wrapper allocation review admission", () => {
  it("retains the allocation and local review digest domains and payloads", () => {
    expect(SAFETY_SCORE_V9_WRAPPER_ALLOCATION_REVIEWS_DIGEST).toBe(domainDigest(
      "safety-score-v9.wrapper-allocation-reviews.v1", reviews,
    ));
    expect(SAFETY_SCORE_V9_WRAPPER_LOCAL_REVIEWS_DIGEST).toBe(domainDigest(
      "safety-score-v9.wrapper-local-reviews.v1", reviews.localReviews,
    ));
  });

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

  it.each([
    ["allocation", "duplicate", "wrapperAllocationReview"],
    ["allocation", "malformed", "wrapperAllocationReview"],
    ["local", "duplicate", "wrapperLocalReviews"],
    ["local", "malformed", "wrapperLocalReviews"],
  ] as const)("keeps %s %s rows lazy and quarantined at %s", async (lane, defect, path) => {
    const allocation = { ...structuredClone(reviews.reviews[0]!), assetId: "alpha" };
    const local = { ...structuredClone(reviews.localReviews[0]!), assetId: "alpha" };
    local.identity.assetId = "alpha";
    const row = lane === "allocation" ? allocation : local;
    if (defect === "malformed") Reflect.set(row, lane === "allocation" ? "scopeKind" : "kind", "invalid");
    const rows = defect === "duplicate" ? [row, structuredClone(row)] : [row];
    vi.resetModules();
    vi.doMock("@shared/data/safety-score-v9/wrapper-allocation-reviews-v1.json", () => ({
      default: { schemaVersion: 1, reviews: lane === "allocation" ? rows : [], localReviews: lane === "local" ? rows : [] },
    }));
    // Load after JSON replacement to exercise the module-load identity boundary.
    const { buildSafetyScoreV9BaselineExtension } = await import("../safety-score-v9/extension");
    const fixed = makeV9TwoAssetFixedInput();
    const extension = buildSafetyScoreV9BaselineExtension(fixed, {
      metaById: new Map([["alpha", alphaMeta()], ["beta", alphaMeta({ id: "beta" })]]),
    });
    expect(extension.assets.find((asset) => asset.assetId === "alpha")!.admissionQuarantine).toMatchObject({
      code: "fact-build-failed", path,
    });
    expect(extension.assets.find((asset) => asset.assetId === "beta")!.admissionQuarantine).toBeUndefined();
  });
});
