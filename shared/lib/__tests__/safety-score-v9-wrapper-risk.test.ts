import { describe, expect, it } from "vitest";
import type { V9WrapperForm } from "../../types/safety-score-v9-wrapper";
import type { V9AssetFactsV3, V9FactStatusV2, V9AssetFactsV2 } from "../../types/safety-score-v9-facts";
import type { V9ResolvedDependencyInputs } from "../safety-score-v9/dependencies";
import { resolveV9ParentLimitInput, type V9EvaluatedAsset } from "../safety-score-v9/evaluate-asset";
import { V9_CANDIDATE_POLICY_V1 } from "../safety-score-v9/policy";
import { scoreV9EvaluatedAsset, projectV9DependencyScore } from "../safety-score-v9/score";
import { makeV9Pillar, makeV9ProductionScoreInput } from "./safety-score-v9-score.test-support";
import { resolveV9WrapperParentLimit } from "../safety-score-v9/wrapper-risk";
import { resolveV9WrapperStrategyTier } from "../safety-score-v9/evaluate-set";
import { applyV9AssetPremium } from "../safety-score-v9/formula";

const DISCOUNTS = { pure: 3, "native-staked": 5, "strategy-vault": 10, "risk-absorption": 10 } as const;

function facts(form: V9WrapperForm) {
  return { form };
}

function limit(parentScore: number, localFacts: { form: V9WrapperForm }) {
  return resolveV9WrapperParentLimit({ parentScore, localFacts, formDiscounts: DISCOUNTS });
}

describe("wrapper form parent limits", () => {
  it.each(["pure", "native-staked", "strategy-vault", "risk-absorption"] as const)("deducts only the %s form cost", (form) => {
    expect(limit(84, facts(form))).toMatchObject({
      form, appliedDiscount: DISCOUNTS[form], limit: 84 - DISCOUNTS[form],
    });
  });


  it("floors fractional parent ceilings and never exceeds the parent", () => {
    for (const form of ["pure", "native-staked", "strategy-vault", "risk-absorption"] as const) {
      for (const parent of [0, 2, 25, 40, 49.9, 84, 100]) {
        const result = limit(parent, facts(form));
        expect(result.limit).toBe(Math.max(0, Math.floor(parent - DISCOUNTS[form])));
        expect(result.limit).toBeLessThanOrEqual(parent);
      }
    }
  });

  it("does not lift a weak parent to a mild-risk grade floor", () => {
    expect(limit(40, facts("strategy-vault")).limit).toBe(30);
  });

  it("passes accumulated form limits through nested wrappers", () => {
    const middle = limit(84, facts("strategy-vault"));
    const child = limit(middle.limit, facts("pure"));
    expect(middle.limit).toBe(74);
    expect(child.limit).toBe(71);
  });
});

const STATUS: V9FactStatusV2 = {
  applicability: { state: "required", policyRuleId: "fixture", gapId: null, rationale: null },
  observationState: "known", evidenceRefIds: ["fixture:claim"], gapIds: [],
};

function concentratedParent(weight: number, parentScore: number | null = 64, status = STATUS,
  assetClass = "stablecoin", reserveWeight = weight) {
  const asset = {
    assetId: "child", dependencies: { status }, wrapperLocalFacts: { applicability: "not-applicable" },
    reserveExposures: [{ trackedAssetId: "collateral", weight: reserveWeight, assetClass, status: STATUS }],
  } as unknown as V9AssetFactsV3;
  const inputs: V9ResolvedDependencyInputs = {
    assetId: "child", serial: [], cycleBlocked: false,
    basket: [
      // Basket scores are Backing-only and must not become the whole-parent ceiling.
      { upstreamAssetId: "collateral", weight, score: 95, boundedUnknown: false },
      { upstreamAssetId: "dust", weight: 1 - weight, score: 99, boundedUnknown: false },
    ],
  };
  const trace = scoreV9EvaluatedAsset(makeV9ProductionScoreInput({
    assetId: "collateral", trackRecordMonths: 120,
    pillars: { backing: makeV9Pillar(64), exit: makeV9Pillar(64), control: makeV9Pillar(64) },
  }), V9_CANDIDATE_POLICY_V1);
  trace.inheritableScore = parentScore;
  // A public premium must not propagate through the collateral ceiling.
  trace.finalScore = 90;
  const evaluated = new Map([["collateral", { trace } as V9EvaluatedAsset]]);
  return resolveV9ParentLimitInput(asset, inputs, evaluated, undefined, V9_CANDIDATE_POLICY_V1);
}

describe("near-total admitted collateral parent limits", () => {
  it.each([0.99, 0.991, 0.99999996, 1])("caps a %s collateral share at the premium-free parent minus three", (weight) => {
    expect(concentratedParent(weight)).toMatchObject({
      required: true, score: 61, wrapperParentLimit: { form: "pure", appliedDiscount: 3, parentScore: 64 },
    });
  });

  it.each([0.981, 0.989999])("does not infer a pure claim below 99%% (%s)", (weight) => {
    expect(concentratedParent(weight)).toMatchObject({ required: false, score: null });
  });

  it("requires admitted dependency evidence", () => {
    for (const status of [
      { ...STATUS, observationState: "missing" as const },
      { ...STATUS, evidenceRefIds: [] },
      { ...STATUS, applicability: {
        state: "unresolved" as const, policyRuleId: STATUS.applicability.policyRuleId,
        gapId: "gap:fixture", rationale: "Unresolved fixture.",
      } },
    ]) expect(concentratedParent(1, 64, status).required).toBe(false);
  });

  it("keeps an independently lower child score", () => {
    const parent = concentratedParent(1);
    const trace = scoreV9EvaluatedAsset(makeV9ProductionScoreInput({
      trackRecordMonths: 120, parent,
      pillars: { backing: makeV9Pillar(40), exit: makeV9Pillar(40), control: makeV9Pillar(40) },
    }), V9_CANDIDATE_POLICY_V1);
    expect(trace.finalScore).toBe(40);
    expect(trace.bindingCap).toBeNull();
  });

  it("does not invent a limit for an unscored collateral card", () => {
    expect(concentratedParent(1, null)).toMatchObject({ required: false, score: null });
  });

  it("requires direct token holdings, not a strategy denomination or composite claim", () => {
    expect(concentratedParent(1, 64, STATUS, "protocol-position").required).toBe(false);
    expect(concentratedParent(1, 64, STATUS, "bank-deposit").required).toBe(false);
    expect(concentratedParent(1, 64, STATUS, "stablecoin", 0.98).required).toBe(false);
    expect(concentratedParent(1, 64, STATUS, "fund-share").required).toBe(true);
  });
});

const POLICY = V9_CANDIDATE_POLICY_V1;

function asset(variantKind: V9AssetFactsV2["variantKind"], form?: "pure" | "native-staked" | "strategy-vault" | "risk-absorption"): V9AssetFactsV2 {
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
    ["pure-wrapper", "pure"], ["savings-passthrough", "staked"], ["risk-absorption", "vault"], ["strategy-vault", "vault"],
  ] as const)("classifies %s from economic function", (variant, tier) => {
    expect(resolveV9WrapperStrategyTier(asset(variant), resolved())).toBe(tier);
  });
  it("uses admitted active strategy allocation rather than a native-staking label", () => {
    expect(resolveV9WrapperStrategyTier(asset("risk-absorption", "strategy-vault"), resolved())).toBe("vault");
  });
  it("prices the reviewed risk-absorption form at the vault tier", () => {
    expect(resolveV9WrapperStrategyTier(asset("risk-absorption", "risk-absorption"), resolved())).toBe("vault");
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
