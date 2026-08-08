import { describe, expect, it } from "vitest";
import { scoreV9Input } from "../safety-score-v9/formula";
import { resolveV9WrapperStrategyTier } from "../safety-score-v9/evaluate-set";
import { V9_CANDIDATE_POLICY_V1 } from "../safety-score-v9/policy";
import type { V9InheritedStablecoinBacking } from "../safety-score-v9/backing";
import type { V9ResolvedDependencyInputs } from "../safety-score-v9/dependencies";
import type { V9AssetFactsV2 } from "../../types/safety-score-v9-facts";
import type { V9ScoringInput } from "../../types/safety-score-v9";

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

// A rated wrapper whose own composite would land ~90; the parent cap decides it.
function wrapperOverParent(parentScore: number | null, pillar = 90): V9ScoringInput {
  return {
    assetId: "wrapper",
    pillars: { backing: pillar, exit: pillar, control: pillar },
    pegScore: 100,
    pegApplicable: true,
    evidenceLevel: "strong",
    trackRecordMonths: 48,
    activeDepegBps: null,
    parentRequired: parentScore !== null,
    parentScore,
    structuralSignals: [],
    unresolved: [],
  };
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

describe("the discounted parent cap binds through the scorer", () => {
  it("VAULT: a third-party vault lands well below an A-grade parent (82 → 72/B)", () => {
    const trace = scoreV9Input(wrapperOverParent(82 - DISCOUNT.vault), POLICY);
    expect(trace.finalScore).toBe(72);
    expect(trace.finalGrade).toBe("B");
    expect(trace.bindingCap?.kind).toBe("parent");
  });
  it("STAKED: a native savings token over a low-C parent stays out of D (59 → 54/C-)", () => {
    const trace = scoreV9Input(wrapperOverParent(59 - DISCOUNT.staked), POLICY);
    expect(trace.finalScore).toBe(54);
    expect(trace.finalGrade).toBe("C-");
    expect(trace.bindingCap?.kind).toBe("parent");
  });
  it("STAKED sits a tier above VAULT for the same parent (82 → 77/B+ vs 72/B)", () => {
    expect(scoreV9Input(wrapperOverParent(82 - DISCOUNT.staked), POLICY).finalGrade).toBe("B+");
    expect(scoreV9Input(wrapperOverParent(82 - DISCOUNT.vault), POLICY).finalGrade).toBe("B");
  });
  it("PURE: a 1:1 pass-through barely moves off its parent grade (84 → 81/A-)", () => {
    const trace = scoreV9Input(wrapperOverParent(84 - DISCOUNT.pure), POLICY);
    expect(trace.finalScore).toBe(81);
    expect(trace.finalGrade).toBe("A-");
  });
  it("leaves a wrapper already below the discounted cap unchanged", () => {
    const trace = scoreV9Input(wrapperOverParent(82 - DISCOUNT.vault, 68), POLICY); // cap 72, composite 68
    expect(trace.finalScore).toBe(68);
    expect(trace.bindingCap).toBeNull();
  });
});
