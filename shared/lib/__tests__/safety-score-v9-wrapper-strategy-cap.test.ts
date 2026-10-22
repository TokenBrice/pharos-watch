import { describe, expect, it } from "vitest";
import { resolveV9WrapperStrategyTier } from "../safety-score-v9/evaluate-set";
import { V9_CANDIDATE_POLICY_V1 } from "../safety-score-v9/policy";
import type { V9ResolvedDependencyInputs } from "../safety-score-v9/dependencies";
import type { V9AssetFactsV2 } from "../../types/safety-score-v9-facts";
import { applyV9AssetPremium } from "../safety-score-v9/formula";
import { projectV9DependencyScore, scoreV9EvaluatedAsset } from "../safety-score-v9/score";
import { makeV9Pillar, makeV9ProductionScoreInput } from "./safety-score-v9-score.test-support";

const POLICY = V9_CANDIDATE_POLICY_V1;

function asset(variantKind: V9AssetFactsV2["variantKind"], form?: "pure" | "native-staked" | "strategy-vault"): V9AssetFactsV2 {
  return {
    variantKind,
    dependencies: { edges: [{ pathKind: "serial-dependency", dependencyType: "wrapper", upstreamAssetId: "parent" }] },
    ...(form === undefined ? {} : { wrapperLocalFacts: { applicability: "wrapper", form } }),
  } as unknown as V9AssetFactsV2;
}
function resolved(): V9ResolvedDependencyInputs {
  return { assetId: "child", serial: [{ upstreamAssetId: "parent", score: 84, blocked: false }], basket: [], cycleBlocked: false };
}
function score(own: number, parent: number | null, required = true) {
  return scoreV9EvaluatedAsset(makeV9ProductionScoreInput({
    assetId: "child", trackRecordMonths: 120,
    pillars: { backing: makeV9Pillar(own), exit: makeV9Pillar(own), control: makeV9Pillar(own) },
    parent: { required, score: parent, propagatedReasons: [] },
  }), POLICY);
}

describe("economic wrapper forms", () => {
  it.each([
    ["pure-wrapper", "pure"], ["savings-passthrough", "staked"], ["risk-absorption", "staked"], ["strategy-vault", "vault"],
  ] as const)("classifies %s from economic function", (variant, tier) => {
    expect(resolveV9WrapperStrategyTier(asset(variant), resolved())).toBe(tier);
  });
  it("uses admitted active strategy allocation rather than a native-staking label", () => {
    expect(resolveV9WrapperStrategyTier(asset("risk-absorption", "strategy-vault"), resolved())).toBe("vault");
  });
  it("does not invent a wrapper form without a wrapper dependency or variant", () => {
    const claim = asset(null);
    claim.dependencies.edges[0].dependencyType = "mechanism";
    expect(resolveV9WrapperStrategyTier(claim, resolved())).toBeUndefined();
  });
});

describe("wrapper score assembly", () => {
  it("limits a strong own score at the already deducted parent ceiling", () => {
    expect(score(95, 74).finalScore).toBe(74);
  });
  it("does not deduct the form a second time from an independently weak own score", () => {
    const own = score(35, null, false);
    const child = score(35, 74);
    expect(child.finalScore).toBe(own.finalScore);
    expect(child.finalScore).toBe(35);
    expect(child.bindingCap).toBeNull();
  });
  it("retains genuine required-parent unavailability", () => {
    const trace = scoreV9EvaluatedAsset(makeV9ProductionScoreInput({
      parent: {
        required: true, score: null, ratingStatus: "not-rated",
        propagatedReasons: [{ code: "missing-pillar-evidence", message: "Required parent has no usable pillars.", cause: "U", causeGapIds: ["gap:parent"] }],
      },
    }), POLICY);
    expect(trace.finalScore).toBeNull();
    expect(trace.ratingStatus).toBe("not-rated");
  });
  it("never transmits the public longevity premium to a wrapper", () => {
    const premium = POLICY.policy.semantic.formula.assetPremiums[0];
    const ordinary = scoreV9EvaluatedAsset(makeV9ProductionScoreInput({
      assetId: premium.assetId, trackRecordMonths: 120,
      pillars: { backing: makeV9Pillar(75), exit: makeV9Pillar(75), control: makeV9Pillar(75) },
    }), POLICY);
    const adjusted = applyV9AssetPremium(ordinary, premium, POLICY);
    expect(adjusted.finalScore).toBe(87);
    expect(projectV9DependencyScore(adjusted)).toBe(75);
    expect(score(95, projectV9DependencyScore(adjusted)! - 10).finalScore).toBe(65);
  });
});
