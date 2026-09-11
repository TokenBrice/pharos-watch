import { describe, expect, it } from "vitest";
import { resolveV9WrapperStrategyTier } from "../safety-score-v9/evaluate-set";
import { V9_CANDIDATE_POLICY_V1 } from "../safety-score-v9/policy";
import type { V9InheritedStablecoinBacking } from "../safety-score-v9/backing";
import type { V9ResolvedDependencyInputs } from "../safety-score-v9/dependencies";
import type { V9AssetFactsV2 } from "../../types/safety-score-v9-facts";
import {
  coreFixture,
  fullAsset,
  minimalAsset,
  compileNativeV3FactSet,
  compileV9FactSetV3,
  evaluateV9FactSet,
} from "./safety-score-v9-facts.fixture-support";

const POLICY = V9_CANDIDATE_POLICY_V1;
const DISCOUNT = POLICY.policy.semantic.formula.wrapperStrategyCap; // { pure: 3, staked: 5, vault: 10 }

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
function inherited(tier: V9InheritedStablecoinBacking["tier"]): V9InheritedStablecoinBacking {
  return { parentAssetId: "usdc-circle", parentBackingScore: 86, weight: 1, tier, failureDomains: [] };
}

describe("wrapperStrategyCap policy tiers are monotonic (pure <= staked <= vault)", () => {
  it("carries the three approved discounts", () => {
    expect(DISCOUNT.pure).toBe(3);
    expect(DISCOUNT.staked).toBe(5);
    expect(DISCOUNT.vault).toBe(10);
    expect(DISCOUNT.pure).toBeLessThanOrEqual(DISCOUNT.staked);
    expect(DISCOUNT.staked).toBeLessThanOrEqual(DISCOUNT.vault);
  });
});

describe("resolveV9WrapperStrategyTier — compiled form drives the current tier", () => {
  it("strategy-vault (third-party aggregator) → vault", () => {
    expect(
      resolveV9WrapperStrategyTier(asset("strategy-vault", wrapperSerialEdge), resolvedWithSerial(["usdc-circle"]), undefined),
    ).toBe("vault");
  });
  it("savings-passthrough (native savings) → staked", () => {
    expect(
      resolveV9WrapperStrategyTier(asset("savings-passthrough", wrapperSerialEdge), resolvedWithSerial(["usdc-circle"]), undefined),
    ).toBe("staked");
  });
  it("risk-absorption (native staking layer) → staked", () => {
    expect(
      resolveV9WrapperStrategyTier(asset("risk-absorption", wrapperSerialEdge), resolvedWithSerial(["usde-ethena"]), undefined),
    ).toBe("staked");
  });
  it("risk-absorption operated by a third party → vault", () => {
    expect(
      resolveV9WrapperStrategyTier(
        asset("risk-absorption", wrapperSerialEdge, "strategy-vault"),
        resolvedWithSerial(["bold-liquity"]),
        undefined,
      ),
    ).toBe("vault");
  });
  it("no variantKind → falls back to the backing-inheritance tier (pure stays pure)", () => {
    expect(resolveV9WrapperStrategyTier(asset(null), resolvedWithSerial([]), inherited("pure"))).toBe("pure");
    expect(resolveV9WrapperStrategyTier(asset(null), resolvedWithSerial(["usdc-circle"]), inherited("wrapped"))).toBe("vault");
  });
  it("no variantKind, no inheritance, but a serial wrapper edge → conservative vault", () => {
    expect(resolveV9WrapperStrategyTier(asset(null, wrapperSerialEdge), resolvedWithSerial(["usdc-circle"]), undefined)).toBe(
      "vault",
    );
  });
  it("does NOT discount a mechanism serial claim or a collateral/basket edge", () => {
    expect(
      resolveV9WrapperStrategyTier(
        asset(null, [{ pathKind: "serial-dependency", dependencyType: "mechanism", upstreamAssetId: "share" }]),
        resolvedWithSerial(["share"]),
        undefined,
      ),
    ).toBeUndefined();
    expect(
      resolveV9WrapperStrategyTier(
        asset(null, [{ pathKind: "collateral-exposure", dependencyType: "collateral", upstreamAssetId: "dai-makerdao" }]),
        { assetId: "mim", serial: [], basket: [], cycleBlocked: false },
        undefined,
      ),
    ).toBeUndefined();
  });
  it("returns undefined with no serial parent", () => {
    expect(resolveV9WrapperStrategyTier(asset(null), resolvedWithSerial([]), undefined)).toBeUndefined();
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
    const local = completeCore.assets.find((asset) => asset.assetId === "wrapper")!.wrapperLocalFacts;
    if (local.applicability !== "wrapper") throw new Error("Expected wrapper facts");
    for (const fact of Object.values(local.facts)) {
      fact.disposition = "reviewed";
      fact.assessment = "none";
      fact.evidenceRefIds = ["evidence:base"];
    }
    local.facts.custodyEscrow.assessment = "critical";
    local.riskTransfer = {
      disposition: "not-applicable",
      mechanism: "none",
      maximumParentLossAbsorptionPoints: 0,
      signals: ["no-risk-transfer"],
      evidenceRefIds: ["evidence:base"],
    };
    const complete = evaluateV9FactSet(compileV9FactSetV3(completeCore), POLICY);
    const completeWrapper = complete.assets.find((asset) => asset.assetId === "wrapper")!;
    expect(completeWrapper.scoreInput.parent.score).toBe(77);
    expect(completeWrapper.trace.wrapperParentLimit).toMatchObject({
      form, factsComplete: true, treatment: "local-facts", fallbackDiscount: 0, appliedDiscount: 2, limit: 77,
    });
  });
});
