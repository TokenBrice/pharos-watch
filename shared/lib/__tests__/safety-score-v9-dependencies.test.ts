import { describe, expect, it } from "vitest";
import type { V9DependencyPlanningAsset } from "../safety-score-v9/dependencies";
import {
  buildV9DependencyEvaluationPlan,
  resolveV9DependencyInputs,
} from "../safety-score-v9/dependencies";
import { commonModeSignalSeverity, type V9SupplyChainExposure } from "../safety-score-v9/evaluate-set";
import { V9_CANDIDATE_POLICY_V1 } from "../safety-score-v9/policy";

const domain = (kind: "reserve-custodian" | "mint-control", key: string) => ({ kind, key } as const);

function asset(
  assetId: string,
  edges: V9DependencyPlanningAsset["dependencies"]["edges"] = [],
  options: Partial<Omit<V9DependencyPlanningAsset, "assetId" | "dependencies">> = {},
): V9DependencyPlanningAsset {
  return {
    assetId,
    dependencies: { edges },
    reserveExposures: [],
    exitRoutes: [],
    controls: [],
    peg: { failureDomains: [] },
    supply: { failureDomains: [] },
    ...options,
  };
}

function edge(
  upstreamAssetId: string,
  dependencyType: "wrapper" | "mechanism" | "collateral",
  weight = dependencyType === "collateral" ? 0.25 : 1,
) {
  return {
    edgeKey: `${dependencyType}:${upstreamAssetId}`,
    upstreamAssetId,
    dependencyType,
    pathKind: dependencyType === "collateral" ? ("collateral-exposure" as const) : ("serial-dependency" as const),
    weight,
    failureDomains: [],
  };
}

describe("buildV9DependencyEvaluationPlan", () => {
  it("orders upstreams before serial and basket consumers", () => {
    const plan = buildV9DependencyEvaluationPlan({
      activeAssetIds: ["diamond", "left", "right", "root"],
      assets: [
        asset("diamond", [edge("left", "wrapper"), edge("right", "collateral")]),
        asset("right", [edge("root", "collateral")]),
        asset("root"),
        asset("left", [edge("root", "mechanism")]),
      ],
    });
    expect(plan.topologicalOrder.indexOf("root")).toBeLessThan(plan.topologicalOrder.indexOf("left"));
    expect(plan.topologicalOrder.indexOf("root")).toBeLessThan(plan.topologicalOrder.indexOf("right"));
    expect(plan.topologicalOrder.indexOf("left")).toBeLessThan(plan.topologicalOrder.indexOf("diamond"));
  });

  it("suppresses a duplicate basket role when the same upstream is serial", () => {
    const plan = buildV9DependencyEvaluationPlan({
      activeAssetIds: ["child", "parent"],
      assets: [asset("parent"), asset("child", [edge("parent", "collateral", 0.8), edge("parent", "wrapper")])],
    });
    expect(plan.serialPaths).toHaveLength(1);
    expect(plan.basketPaths).toHaveLength(0);
    expect(plan.suppressedRoles).toEqual([
      expect.objectContaining({ reason: "serial-role-dominates", suppressedEdgeKey: "collateral:parent" }),
    ]);
  });

  it("marks SCC members and serial descendants while leaving basket consumers bounded", () => {
    const plan = buildV9DependencyEvaluationPlan({
      activeAssetIds: ["a", "b", "basket", "serial"],
      assets: [
        asset("a", [edge("b", "wrapper")]),
        asset("b", [edge("a", "mechanism")]),
        asset("serial", [edge("a", "wrapper")]),
        asset("basket", [edge("a", "collateral")]),
      ],
    });
    expect(plan.cyclicComponents).toEqual([["a", "b"]]);
    expect(plan.serialBlockedDescendants).toEqual(["serial"]);
    const resolved = resolveV9DependencyInputs(plan, [
      { assetId: "a", score: null },
      { assetId: "b", score: null },
    ]);
    expect(resolved.find((item) => item.assetId === "serial")?.cycleBlocked).toBe(true);
    expect(resolved.find((item) => item.assetId === "basket")?.cycleBlocked).toBe(false);
    expect(resolved.find((item) => item.assetId === "basket")?.basket[0]?.boundedUnknown).toBe(true);
  });

  it("groups repeated cross-pillar failure domains once", () => {
    const shared = domain("reserve-custodian", "bank-a");
    const plan = buildV9DependencyEvaluationPlan({
      activeAssetIds: ["asset"],
      assets: [
        asset("asset", [], {
          reserveExposures: [{ exposureKey: "cash", failureDomains: [shared] }],
          exitRoutes: [{ routeKey: "redeem", failureDomains: [shared] }],
          controls: [{ controlKey: "custody", failureDomains: [shared] }],
        }),
      ],
    });
    expect(plan.commonModeGroups).toEqual([
      {
        failureDomain: shared,
        members: [
          { assetId: "asset", owner: "backing", pathKey: "cash" },
          { assetId: "asset", owner: "control", pathKey: "custody" },
          { assetId: "asset", owner: "exit", pathKey: "redeem" },
        ],
      },
    ]);
  });

  it("is invariant to asset and edge ordering", () => {
    const assets = [asset("root"), asset("child", [edge("root", "wrapper"), edge("root", "collateral")])];
    const forward = buildV9DependencyEvaluationPlan({ activeAssetIds: ["root", "child"], assets });
    const reverse = buildV9DependencyEvaluationPlan({
      activeAssetIds: ["child", "root"],
      assets: [...assets]
        .reverse()
        .map((item) => ({ ...item, dependencies: { edges: [...item.dependencies.edges].reverse() } })),
    });
    expect(reverse).toEqual(forward);
  });

  it("rejects omissions and dependencies outside the active set", () => {
    expect(() =>
      buildV9DependencyEvaluationPlan({ activeAssetIds: ["a", "b"], assets: [asset("a")] }),
    ).toThrow(/exact active asset set/);
    expect(() =>
      buildV9DependencyEvaluationPlan({ activeAssetIds: ["a"], assets: [asset("a", [edge("missing", "wrapper")])] }),
    ).toThrow(/Invalid.*dependency/);
  });
});

describe("commonModeSignalSeverity (owner rulings Batch 3.3 + Batch 4 (option A))", () => {
  const materiality = V9_CANDIDATE_POLICY_V1.policy.semantic.materiality;
  const exposure = (shareBySlug: Record<string, number> = {}, unattributedShare = 0): V9SupplyChainExposure => ({
    shareBySlug: new Map(Object.entries(shareBySlug)),
    unattributedShare,
  });
  // A fully fail-closed exposure: no attributed share, whole base unattributed.
  const failClosed = exposure({}, 1);

  it("grades a reviewed mature chain moderate regardless of exposure", () => {
    for (const chain of materiality.matureChains) {
      expect(commonModeSignalSeverity({ kind: "chain", key: chain }, failClosed, materiality)).toBe("moderate");
    }
  });

  it("normalizes DefiLlama display-name chain keys to their canonical slug before matching", () => {
    for (const [displayName, slug] of [
      ["Ethereum", "ethereum"],
      ["BSC", "bsc"],
      ["OP Mainnet", "optimism"],
      ["Solana", "solana"],
    ] as const) {
      expect(materiality.matureChains).toContain(slug);
      expect(commonModeSignalSeverity({ kind: "chain", key: displayName }, failClosed, materiality)).toBe("moderate");
    }
  });

  it("keeps a non-mature chain with a material supply share at high", () => {
    expect(materiality.commonModeSignal.severity).toBe("high");
    expect(materiality.matureChainShareThreshold).toBe(0.05);
    // fantom holds 10% of supply -> material non-mature -> high.
    expect(commonModeSignalSeverity({ kind: "chain", key: "fantom" }, exposure({ fantom: 0.1 }), materiality)).toBe(
      "high",
    );
    // The display-name form resolves to the same non-mature slug and stays high.
    expect(commonModeSignalSeverity({ kind: "chain", key: "Fantom" }, exposure({ fantom: 0.1 }), materiality)).toBe(
      "high",
    );
  });

  it("graduates a non-mature chain whose supply share is immaterial to moderate (the Batch 4 case)", () => {
    // fantom is non-mature but holds only 1% of supply, dominated by mature chains.
    expect(commonModeSignalSeverity({ kind: "chain", key: "fantom" }, exposure({ fantom: 0.01 }), materiality)).toBe(
      "moderate",
    );
    // A non-mature chain with no selected route, bounded by immaterial unattributed supply.
    expect(commonModeSignalSeverity({ kind: "chain", key: "fantom" }, exposure({}, 0.01), materiality)).toBe("moderate");
  });

  it("fails closed to high when the non-mature chain's share is unknown or unattributable", () => {
    // No route for fantom and a material unattributed remainder -> cannot rule out material -> high.
    expect(commonModeSignalSeverity({ kind: "chain", key: "fantom" }, exposure({}, 0.36), materiality)).toBe("high");
    // Unresolvable chain name -> uses the unattributed bound.
    expect(commonModeSignalSeverity({ kind: "chain", key: "unknown-l2" }, exposure({}, 0.36), materiality)).toBe("high");
  });

  it("treats exactly the threshold share as material (epsilon predicate)", () => {
    expect(commonModeSignalSeverity({ kind: "chain", key: "fantom" }, exposure({ fantom: 0.05 }), materiality)).toBe(
      "high",
    );
    expect(commonModeSignalSeverity({ kind: "chain", key: "fantom" }, exposure({ fantom: 0.0499 }), materiality)).toBe(
      "moderate",
    );
  });

  it("keeps non-chain failure domains at the default high severity", () => {
    expect(commonModeSignalSeverity({ kind: "reserve-custodian", key: "custodian:a" }, failClosed, materiality)).toBe(
      "high",
    );
    expect(commonModeSignalSeverity({ kind: "mint-control", key: "mechanism:x" }, failClosed, materiality)).toBe("high");
  });

  it("prices the graduated and default severities inside their locked grade bands", () => {
    const limits = V9_CANDIDATE_POLICY_V1.policy.semantic.structural.signalLimits["critical-dependency"];
    expect(limits.moderate).toBe(79); // top of B+ (75-79)
    expect(limits.high).toBe(64);
  });
});
