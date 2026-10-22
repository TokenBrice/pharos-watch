import { describe, expect, it } from "vitest";
import type { V9WrapperForm } from "../../types/safety-score-v9-wrapper";
import type { V9AssetFactsV3, V9FactStatusV2 } from "../../types/safety-score-v9-facts";
import type { V9ResolvedDependencyInputs } from "../safety-score-v9/dependencies";
import { resolveV9ParentLimitInput, type V9EvaluatedAsset } from "../safety-score-v9/evaluate-asset";
import { V9_CANDIDATE_POLICY_V1 } from "../safety-score-v9/policy";
import { scoreV9EvaluatedAsset } from "../safety-score-v9/score";
import { makeV9Pillar, makeV9ProductionScoreInput } from "./safety-score-v9-score.test-support";
import { resolveV9WrapperParentLimit } from "../safety-score-v9/wrapper-risk";

const DISCOUNTS = { pure: 3, "native-staked": 5, "strategy-vault": 10 } as const;

function facts(form: V9WrapperForm) {
  return { form };
}

function limit(parentScore: number, localFacts: { form: V9WrapperForm }) {
  return resolveV9WrapperParentLimit({ parentScore, localFacts, formDiscounts: DISCOUNTS });
}

describe("wrapper form parent limits", () => {
  it.each(["pure", "native-staked", "strategy-vault"] as const)("deducts only the %s form cost", (form) => {
    expect(limit(84, facts(form))).toMatchObject({
      form, appliedDiscount: DISCOUNTS[form], limit: 84 - DISCOUNTS[form],
    });
  });


  it("floors fractional parent ceilings and never exceeds the parent", () => {
    for (const form of ["pure", "native-staked", "strategy-vault"] as const) {
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

function concentratedParent(weight: number, parentScore: number | null = 64, status = STATUS) {
  const asset = {
    assetId: "child", dependencies: { status }, wrapperLocalFacts: { applicability: "not-applicable" },
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
      { ...STATUS, applicability: { ...STATUS.applicability, state: "unresolved" as const } },
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

  it("does not invent a score for an unavailable required collateral parent", () => {
    expect(concentratedParent(1, null)).toMatchObject({ required: true, score: null });
  });
});
