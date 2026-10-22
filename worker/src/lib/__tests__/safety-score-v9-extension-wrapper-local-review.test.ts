import { describe, expect, it } from "vitest";
import { getSafetyScoreV9WrapperLocalReviews } from "../safety-score-v9/extension-wrapper-reviews";
import { compileSafetyScoreV9FactSetFromFixedInput } from "../safety-score-v9/fact-set";
import { createAssetBuildContext } from "../safety-score-v9/fact-set-context";
import { buildWrapperLocalFacts } from "../safety-score-v9/fact-set-wrapper";
import { normalizeSafetyScoreV9CompilerInput } from "../safety-score-v9/native-input";
import { makeV9RoleExtension, makeV9TwoAssetFixedInput, v9Status } from "../../test-helpers/v9-fixed-input";
import { SafetyScoreV9WrapperLocalReviewSchema } from "@shared/types/safety-score-v9-wrapper-local-review";
import { allocationReviewClockSec } from "@shared/types/safety-score-v9-allocation";
import wrapperLocalReviews from "@shared/data/safety-score-v9/wrapper-allocation-reviews-v1.json";

function intakeFixture(assetId: string) {
  const review = getSafetyScoreV9WrapperLocalReviews(assetId)[0]!;
  const fixed = makeV9TwoAssetFixedInput({ clockSec: Math.ceil(allocationReviewClockSec(review.reviewedAt)) });
  const extension = makeV9RoleExtension(fixed, {
    alpha: [{ upstreamAssetId: "beta", dependencyType: "wrapper", economicRole: "serial-claim", weight: 1, failureDomains: [] }],
  });
  const wrapper = extension.assets.find((asset) => asset.assetId === "alpha")!;
  wrapper.variantKind = "strategy-vault";
  wrapper.dependencies!.source = "variant";
  const retained = structuredClone(review);
  if (retained.kind !== "accounting" && retained.kind !== "holder-entitlement") {
    throw new Error("Expected a pinned accounting or holder-entitlement review");
  }
  retained.assetId = "alpha";
  retained.identity.assetId = "alpha";
  wrapper.allocationScopeIdentityReview = structuredClone(retained.identity);
  wrapper.wrapperLocalReviews = [retained];
  const asset = structuredClone(compileSafetyScoreV9FactSetFromFixedInput(fixed, extension).assets
    .find((candidate) => candidate.assetId === "alpha")!);
  asset.peg.status = v9Status("missing", "v9.peg.review");
  asset.economicControlReview.oracle.status = v9Status("missing", "v9.control.oracle-review");
  asset.economicControlReview.oracle.tier = null;
  asset.economicControlReview.mint.status = v9Status("missing", "v9.control.mint-review");
  asset.exitRoutes = [];
  asset.exitStatus = v9Status("missing", "v9.exit.routes");
  const build = () => {
    const context = createAssetBuildContext(normalizeSafetyScoreV9CompilerInput(fixed), extension, wrapper, "a".repeat(64));
    const facts = buildWrapperLocalFacts(context, asset);
    if (facts.applicability !== "wrapper") throw new Error("Expected wrapper-local facts");
    return { context, facts };
  };
  return { review, retained, wrapper, asset, fixed, build };
}

describe("wrapper-local reviewed registry intake contract", () => {
  it("parses every curated local review under its exact identity schema", () => {
    const invalid = wrapperLocalReviews.localReviews.flatMap((review, index) => {
      const parsed = SafetyScoreV9WrapperLocalReviewSchema.safeParse(review);
      return parsed.success ? [] : [{ index, assetId: review.assetId, kind: review.kind, issues: parsed.error.issues }];
    });
    expect(invalid).toEqual([]);
  });


  for (const assetId of ["senpathusd-sentora", "stusd-stoneyield"]) {
  }


  it("returns no review for an instrument absent from the reviewed registry", () => {
    expect(getSafetyScoreV9WrapperLocalReviews("unreviewed-wrapper")).toEqual([]);
  });
});
