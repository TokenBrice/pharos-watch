import { describe, expect, it } from "vitest";
import { getSafetyScoreV9WrapperLocalReviews } from "../safety-score-v9/extension-wrapper-reviews";
import { compileSafetyScoreV9FactSetFromFixedInput } from "../safety-score-v9/fact-set";
import { createAssetBuildContext } from "../safety-score-v9/fact-set-context";
import { buildWrapperLocalFacts } from "../safety-score-v9/fact-set-wrapper";
import { normalizeSafetyScoreV9CompilerInput } from "../safety-score-v9/native-input";
import { makeV9RoleExtension, makeV9TwoAssetFixedInput, v9Status } from "../../test-helpers/v9-fixed-input";
import type { SafetyScoreV9WrapperLocalReview } from "@shared/types/safety-score-v9-wrapper-local-review";

function intakeFixture(assetId: string) {
  const review = getSafetyScoreV9WrapperLocalReviews(assetId)[0]!;
  const fixed = makeV9TwoAssetFixedInput({ clockSec: 1791184659 });
  const extension = makeV9RoleExtension(fixed, {
    alpha: [{ upstreamAssetId: "beta", dependencyType: "wrapper", economicRole: "serial-claim", weight: 1, failureDomains: [] }],
  });
  const wrapper = extension.assets.find((asset) => asset.assetId === "alpha")!;
  wrapper.variantKind = "strategy-vault";
  wrapper.dependencies!.source = "variant";
  const retained: SafetyScoreV9WrapperLocalReview = {
    ...review, assetId: "alpha", identity: { ...structuredClone(review.identity), assetId: "alpha" },
  };
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
  it("admits current exact accounting independently of borrower oracle and aggregate mint gaps", () => {
    const fixture = intakeFixture("senpathusd-sentora");
    const controlsBefore = structuredClone(fixture.asset.economicControlReview);
    const { facts, context } = fixture.build();
    expect(facts.facts.shareAccountingNavOracle).toMatchObject({ disposition: "reviewed", assessment: "moderate" });
    expect(context.gaps.has("alpha:gap:wrapper-local:shareAccountingNavOracle")).toBe(false);
    expect(fixture.asset.economicControlReview).toEqual(controlsBefore);
    expect(facts.form).toBe("strategy-vault");
  });

  for (const assetId of ["senpathusd-sentora", "stusd-stoneyield"]) {
    it.each(["expired", "identity-mismatch"] as const)(`rejects ${assetId} %s at admission without inventing a local fact`, (rejection) => {
      const fixture = intakeFixture(assetId);
      if (rejection === "expired") fixture.retained.expiresAtSec = fixture.fixed.clockSec;
      if (rejection === "identity-mismatch") {
        const identity = fixture.wrapper.allocationScopeIdentityReview!;
        const row = identity.deployments[0]!;
        row.address = "0x1111111111111111111111111111111111111111";
        identity.registeredDeploymentKeys = [`${row.chain}:${row.address}`];
      }
      const key = fixture.review.kind === "accounting" ? "shareAccountingNavOracle" : "withdrawalTerms";
      const { facts, context } = fixture.build();
      expect(facts.facts[key]).toMatchObject({ disposition: "unresearched", assessment: null });
      expect(context.gaps.has(`alpha:gap:wrapper-local:${key}`)).toBe(true);
    });
  }

  it("admits the sourced adverse entitlement as critical without creating a redemption route or measured unwind", () => {
    const fixture = intakeFixture("stusd-stoneyield");
    const { facts } = fixture.build();
    expect(fixture.review).toMatchObject({ kind: "holder-entitlement", entitlement: "no-public-holder-withdrawal-or-unwrap" });
    expect(facts.facts.withdrawalTerms).toMatchObject({
      disposition: "reviewed", assessment: "critical",
      signals: ["wrapper-holder-entitlement:no-public-holder-withdrawal-or-unwrap"],
    });
    expect(facts.facts.measuredUnwind.assessment).toBeNull();
    expect(fixture.asset.exitRoutes).toEqual([]);
    expect(fixture.asset.exitStatus.observationState).toBe("missing");
  });

  it("returns no review for an instrument absent from the reviewed registry", () => {
    expect(getSafetyScoreV9WrapperLocalReviews("unreviewed-wrapper")).toEqual([]);
  });
});
