import { describe, expect, it } from "vitest";
import { resolveV9WrapperStrategyTier } from "../safety-score-v9/evaluate-set";
import { V9_CANDIDATE_POLICY_V1 } from "../safety-score-v9/policy";
import type { V9ResolvedDependencyInputs } from "../safety-score-v9/dependencies";
import type { V9AssetFactsV2 } from "../../types/safety-score-v9-facts";
import {
  V9_WRAPPER_LOCAL_FACT_KEYS,
  type V9ApplicableWrapperLocalFacts,
  type V9WrapperLocalFactKey,
  type V9WrapperRiskAssessment,
} from "../../types/safety-score-v9-wrapper";
import { SafetyScoreV9ScoreTraceSchema } from "../../types/safety-score-v9-public-trace";
import { resolveV9WrapperParentLimit } from "../safety-score-v9/wrapper-risk";
import { scoreV9EvaluatedAsset } from "../safety-score-v9/score";
import { makeV9Pillar, makeV9ProductionScoreInput } from "./safety-score-v9-score.test-support";
import {
  coreFixture,
  fullAsset,
  minimalAsset,
  knownStatus,
  compileNativeV3FactSet,
  compileV9FactSetV3,
  evaluateV9FactSet,
} from "./safety-score-v9-facts.fixture-support";

const POLICY = V9_CANDIDATE_POLICY_V1;

function asset(
  variantKind: V9AssetFactsV2["variantKind"],
  edges: { pathKind: string; dependencyType: string; upstreamAssetId: string }[] = [],
  form?: "pure" | "native-staked" | "strategy-vault",
): V9AssetFactsV2 {
  return {
    variantKind,
    dependencies: { edges },
    ...(form === undefined
      ? {}
      : {
          wrapperLocalFacts: {
            applicability: "wrapper",
            form,
          },
        }),
  } as unknown as V9AssetFactsV2;
}
function resolvedWithSerial(upstreamAssetIds: string[]): V9ResolvedDependencyInputs {
  return {
    assetId: "wrapper",
    serial: upstreamAssetIds.map((upstreamAssetId) => ({ upstreamAssetId, score: 82, blocked: false })),
    basket: [],
    cycleBlocked: false,
  };
}
const wrapperSerialEdge = [{ pathKind: "serial-dependency", dependencyType: "wrapper", upstreamAssetId: "usdc-circle" }];


describe("resolveV9WrapperStrategyTier — compiled form drives the current tier", () => {
  it("strategy-vault (third-party aggregator) → vault", () => {
    expect(
      resolveV9WrapperStrategyTier(asset("strategy-vault", wrapperSerialEdge), resolvedWithSerial(["usdc-circle"])),
    ).toBe("vault");
  });
  it("savings-passthrough (native savings) → staked", () => {
    expect(
      resolveV9WrapperStrategyTier(asset("savings-passthrough", wrapperSerialEdge), resolvedWithSerial(["usdc-circle"])),
    ).toBe("staked");
  });
  it("risk-absorption (native staking layer) → staked", () => {
    expect(
      resolveV9WrapperStrategyTier(asset("risk-absorption", wrapperSerialEdge), resolvedWithSerial(["usde-ethena"])),
    ).toBe("staked");
  });
  it("risk-absorption operated by a third party → vault", () => {
    expect(
      resolveV9WrapperStrategyTier(
        asset("risk-absorption", wrapperSerialEdge, "strategy-vault"),
        resolvedWithSerial(["bold-liquity"]),
      ),
    ).toBe("vault");
  });
  it("does not fabricate a wrapper tier from a serial parent alone", () => {
    expect(resolveV9WrapperStrategyTier(asset(null), resolvedWithSerial([]))).toBeUndefined();
    expect(resolveV9WrapperStrategyTier(asset(null), resolvedWithSerial(["usdc-circle"]))).toBeUndefined();
  });
  it("no variantKind, no inheritance, but a serial wrapper edge → conservative vault", () => {
    expect(resolveV9WrapperStrategyTier(asset(null, wrapperSerialEdge), resolvedWithSerial(["usdc-circle"]))).toBe(
      "vault",
    );
  });
  it("does NOT discount a mechanism serial claim or a collateral/basket edge", () => {
    expect(
      resolveV9WrapperStrategyTier(
        asset(null, [{ pathKind: "serial-dependency", dependencyType: "mechanism", upstreamAssetId: "share" }]),
        resolvedWithSerial(["share"]),
      ),
    ).toBeUndefined();
    expect(
      resolveV9WrapperStrategyTier(
        asset(null, [{ pathKind: "collateral-exposure", dependencyType: "collateral", upstreamAssetId: "dai-makerdao" }]),
        { assetId: "mim", serial: [], basket: [], cycleBlocked: false },
      ),
    ).toBeUndefined();
  });
  it("returns undefined with no serial parent", () => {
    expect(resolveV9WrapperStrategyTier(asset(null), resolvedWithSerial([]))).toBeUndefined();
  });
});

describe("wrapper discounts propagate through the production set evaluator", () => {
  it.each([
    { variantKind: "pure-wrapper", form: "pure", discount: 3, limit: 76 },
    { variantKind: "savings-passthrough", form: "native-staked", discount: 5, limit: 74 },
    { variantKind: "strategy-vault", form: "strategy-vault", discount: 10, limit: 69 },
  ] as const)("uses fallback only for incomplete $form facts", ({ variantKind, form, discount, limit }) => {
    const parent = fullAsset(false) as unknown as V9AssetFactsV2;
    parent.dependencies.edges = [];
    parent.reserveExposures = parent.reserveExposures.filter((row) => row.trackedAssetId === null);
    parent.reserveExposures[0].weight = 1;
    const wrapper = minimalAsset("wrapper") as unknown as V9AssetFactsV2;
    wrapper.dependencies.source = "variant";
    wrapper.variantKind = variantKind;
    wrapper.dependencies.edges = [{
      edgeKey: "wrapper:alpha",
      upstreamAssetId: "alpha",
      dependencyType: "wrapper",
      pathKind: "serial-dependency",
      economicRole: "serial-claim",
      weight: 1,
      evidenceRefIds: ["evidence:base"],
      failureDomains: [],
    }];
    const input = coreFixture();
    input.assets = [parent, wrapper] as unknown as typeof input.assets;
    input.activeAssetIds = ["alpha", "wrapper"];
    const compiled = compileNativeV3FactSet(input);
    const incomplete = evaluateV9FactSet(compiled, POLICY);
    const parentScore = incomplete.assets.find((asset) => asset.assetId === "alpha")!.trace.finalScore;
    expect(parentScore).toBe(79);
    const incompleteWrapper = incomplete.assets.find((asset) => asset.assetId === "wrapper")!;
    expect(incompleteWrapper.trace.wrapperParentLimit).toMatchObject({
      form, factsComplete: false, treatment: "fallback-discount", appliedDiscount: discount, limit,
    });
    expect(incompleteWrapper.scoreInput.parent.score).toBe(limit);

    const { v9FactSetDigest: _digest, ...completeCore } = structuredClone(compiled);
    const completeAsset = completeCore.assets.find((asset) => asset.assetId === "wrapper")!;
    const local = completeAsset.wrapperLocalFacts;
    if (local.applicability !== "wrapper") throw new Error("Expected wrapper facts");
    for (const fact of Object.values(local.facts)) {
      fact.disposition = "reviewed";
      fact.assessment = "none";
      fact.evidenceRefIds = ["evidence:base"];
      fact.status = knownStatus();
    }
    local.facts.custodyEscrow.assessment = "critical";
    local.riskTransfer = {
      disposition: "not-applicable",
      mechanism: "none",
      maximumParentLossAbsorptionPoints: 0,
      signals: ["no-risk-transfer"],
      evidenceRefIds: ["evidence:base"],
    };
    completeAsset.gaps = completeAsset.gaps.filter((gap) => !gap.gapId.startsWith("fixture:wrapper:"));
    const complete = evaluateV9FactSet(compileV9FactSetV3(completeCore), POLICY);
    const completeWrapper = complete.assets.find((asset) => asset.assetId === "wrapper")!;
    expect(completeWrapper.scoreInput.parent.score).toBe(77);
    expect(completeWrapper.trace.wrapperParentLimit).toMatchObject({
      form, factsComplete: true, treatment: "local-facts", fallbackDiscount: 0, appliedDiscount: 2, limit: 77,
    });
  });
});

function reviewedLocalFacts(
  assessments: Partial<Record<V9WrapperLocalFactKey, V9WrapperRiskAssessment>> = {},
): V9ApplicableWrapperLocalFacts {
  return {
    schemaVersion: 1,
    applicability: "wrapper",
    form: "native-staked",
    formDisposition: "reviewed",
    formSignals: ["wrapper-form:native-staked"],
    formEvidenceRefIds: ["evidence:base"],
    facts: Object.fromEntries(V9_WRAPPER_LOCAL_FACT_KEYS.map((key) => [key, {
      disposition: "reviewed",
      assessment: assessments[key] ?? "none",
      signals: [],
      evidenceRefIds: ["evidence:base"],
      status: knownStatus(),
    }])) as V9ApplicableWrapperLocalFacts["facts"],
    riskTransfer: {
      disposition: "not-applicable",
      mechanism: "none",
      maximumParentLossAbsorptionPoints: 0,
      signals: ["no-risk-transfer"],
      evidenceRefIds: [],
    },
  };
}

function mildRiskLimit(parentScore: number, localFacts = reviewedLocalFacts()) {
  const formula = POLICY.policy.semantic.formula;
  return resolveV9WrapperParentLimit({
    parentScore,
    localFacts,
    minimumNonDangerScore: formula.gradeThresholds.find(
      (threshold) => threshold.grade === formula.wrapperMildRiskFloorGrade,
    )!.minScore,
    fallbackDiscounts: {
      pure: formula.wrapperStrategyCap.pure,
      "native-staked": formula.wrapperStrategyCap.staked,
      "strategy-vault": formula.wrapperStrategyCap.vault,
    },
  });
}

describe("mild wrapper deductions cannot manufacture F from a non-F parent", () => {
  it.each([
    { parent: 41, strategyComplexity: "low", shareAccountingNavOracle: "moderate", withdrawalTerms: "moderate", discount: 1.95 },
    { parent: 40, strategyComplexity: "moderate", shareAccountingNavOracle: "low", withdrawalTerms: "moderate", discount: 1.95 },
  ] as const)("stops a $parent parent at the policy D floor before cap flooring", (row) => {
    const limit = mildRiskLimit(row.parent, reviewedLocalFacts({
      strategyComplexity: row.strategyComplexity,
      shareAccountingNavOracle: row.shareAccountingNavOracle,
      withdrawalTerms: row.withdrawalTerms,
    }));
    expect(limit).toMatchObject({
      parentScore: row.parent, localRiskDiscount: row.discount,
      appliedDiscount: row.parent - 40, gradeFloor: 40, limit: 40,
    });
    if (row.parent === 41) {
      const trace = scoreV9EvaluatedAsset(makeV9ProductionScoreInput({
        parent: { required: true, score: limit.limit, propagatedReasons: [], wrapperParentLimit: limit },
      }), POLICY);
      expect(trace.bindingCap).toMatchObject({ source: "parent", limit: 40 });
      expect(trace.finalScore).toBe(40);
      expect(trace.finalGrade).toBe("D");
    }
  });

  it("bounds a C/U fallback without inventing favorable reviewed local facts", () => {
    const local = reviewedLocalFacts();
    local.facts.custodyEscrow = {
      disposition: "issuer-undisclosed", assessment: null, signals: [],
      evidenceRefIds: [],
    };
    expect(mildRiskLimit(42, local)).toMatchObject({
      factsComplete: false, fallbackDiscount: 5, localRiskDiscount: 0,
      appliedDiscount: 2, gradeFloor: 40, limit: 40,
      missingFacts: [{ factClass: "custodyEscrow", disposition: "issuer-undisclosed" }],
    });
  });

  it.each(["high", "critical"] as const)("retains the full effect of a %s local finding", (severity) => {
    const limit = mildRiskLimit(40, reviewedLocalFacts({ withdrawalTerms: severity }));
    expect(limit.gradeFloor).toBeUndefined();
    expect(limit.appliedDiscount).toBe(severity === "high" ? 2.1 : 3);
    expect(limit.limit).toBe(severity === "high" ? 37.9 : 37);
  });

  it("retains a measured-adverse incident even when its assessment is moderate", () => {
    const local = reviewedLocalFacts({ measuredUnwind: "moderate" });
    local.facts.measuredUnwind.signals = ["prior-incident"];
    const limit = mildRiskLimit(41, local);
    expect(limit).toMatchObject({ appliedDiscount: 1.75, limit: 39.25 });
    expect(limit.gradeFloor).toBeUndefined();
    expect(limit.adjustments.find((row) => row.factKey === "measuredUnwind"))
      .toMatchObject({ assessment: "moderate", scoringDisposition: "measured-adverse" });
  });

  it("still transmits an F parent and keeps ordinary deductions above the F boundary", () => {
    const local = reviewedLocalFacts({ withdrawalTerms: "moderate" });
    expect(mildRiskLimit(39, local)).toMatchObject({ appliedDiscount: 1.05, limit: 37.95 });
    expect(mildRiskLimit(44, local)).toMatchObject({ appliedDiscount: 1.05, limit: 42.95 });
    expect(mildRiskLimit(50, local)).toMatchObject({ appliedDiscount: 1.05, limit: 48.95 });
    expect(mildRiskLimit(39, local).gradeFloor).toBeUndefined();
    expect(mildRiskLimit(44, local).gradeFloor).toBeUndefined();
  });

  it("does not floor independently adverse wrapper scoring", () => {
    const limit = mildRiskLimit(41, reviewedLocalFacts({ withdrawalTerms: "moderate" }));
    const trace = scoreV9EvaluatedAsset(makeV9ProductionScoreInput({
      parent: { required: true, score: limit.limit, propagatedReasons: [], wrapperParentLimit: limit },
      peg: { applicable: true, score: 1, activeDepegBps: null, reasons: [] },
    }), POLICY);
    expect(trace.finalScore).toBeLessThan(40);
    expect(trace.finalGrade).toBe("F");
  });

  it("withholds an independently sub-F-boundary wrapper without manufacturing D", () => {
    const local = reviewedLocalFacts({ strategyComplexity: "moderate" });
    local.form = "strategy-vault";
    local.facts.custodyEscrow = {
      disposition: "issuer-undisclosed", assessment: null, signals: [], evidenceRefIds: [],
    };
    const limit = mildRiskLimit(46, local);
    const trace = scoreV9EvaluatedAsset(makeV9ProductionScoreInput({
      pillars: { backing: makeV9Pillar(35), exit: makeV9Pillar(35), control: makeV9Pillar(45) },
      parent: { required: true, score: limit.limit, propagatedReasons: [], wrapperParentLimit: limit },
    }), POLICY);
    expect(limit).toMatchObject({ fallbackDiscount: 10, appliedDiscount: 6, gradeFloor: 40, limit: 40 });
    expect(trace.bindingCap).toBeNull();
    expect(trace.finalScore).toBeNull();
    expect(trace.finalGrade).toBe("NR");
    expect(trace.nrReasons).toContainEqual(expect.objectContaining({ code: "f-without-measured-adverse" }));
  });

  it("publicly reconciles the bounded deduction and rejects a severe-finding floor", () => {
    const limit = mildRiskLimit(41, reviewedLocalFacts({ withdrawalTerms: "moderate" }));
    const publicLimit = {
      ...limit,
      missingFacts: [],
      adjustments: limit.adjustments.map(({ causeGapIds: _ids, evidenceRefIds: _refs, ...adjustment }) => adjustment),
    };
    const schema = SafetyScoreV9ScoreTraceSchema.shape.wrapperParentLimit;
    expect(schema.safeParse(publicLimit).success).toBe(true);
    expect(schema.safeParse({ ...publicLimit, appliedDiscount: 1.05 }).success).toBe(false);
    expect(schema.safeParse({
      ...publicLimit,
      adjustments: publicLimit.adjustments.map((row) =>
        row.factKey === "withdrawalTerms" ? { ...row, assessment: "high" } : row),
    }).success).toBe(false);
  });
});
