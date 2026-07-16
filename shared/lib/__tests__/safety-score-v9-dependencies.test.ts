import { describe, expect, it } from "vitest";
import type { V9DependencyPlanningAsset } from "../safety-score-v9/dependencies";
import { buildV9DependencyEvaluationPlan, resolveV9DependencyInputs } from "../safety-score-v9/dependencies";
import { commonModeSignalSeverity, type V9CommonModeContext } from "../safety-score-v9/evaluate-set";
import { V9_CANDIDATE_POLICY_V1 } from "../safety-score-v9/policy";

const domain = (kind: "reserve-custodian" | "mint-control", key: string) => ({ kind, key }) as const;

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

  it("joins retained chain display aliases across assets without mutating the fact inputs", () => {
    const displayDomain = { kind: "chain" as const, key: "Hyperliquid L1" };
    const canonicalDomain = { kind: "chain" as const, key: "hyperliquid" };
    const assets = [
      asset("display", [], {
        exitRoutes: [{ routeKey: "display-route", failureDomains: [displayDomain] }],
      }),
      asset("canonical", [], {
        exitRoutes: [{ routeKey: "canonical-route", failureDomains: [canonicalDomain] }],
      }),
    ];

    const plan = buildV9DependencyEvaluationPlan({ activeAssetIds: ["canonical", "display"], assets });
    expect(plan.commonModeGroups).toEqual([
      {
        failureDomain: canonicalDomain,
        members: [
          { assetId: "canonical", owner: "exit", pathKey: "canonical-route" },
          { assetId: "display", owner: "exit", pathKey: "display-route" },
        ],
      },
    ]);
    expect(assets[0]!.exitRoutes[0]!.failureDomains[0]).toBe(displayDomain);
  });

  it("joins unresolved chain case variants while collapsing same-path canonical collisions", () => {
    const plan = buildV9DependencyEvaluationPlan({
      activeAssetIds: ["left", "right"],
      assets: [
        asset("left", [], {
          exitRoutes: [
            {
              routeKey: "left-route",
              failureDomains: [
                { kind: "chain", key: "Future Network" },
                { kind: "chain", key: "future network" },
              ],
            },
          ],
        }),
        asset("right", [], {
          supply: { failureDomains: [{ kind: "chain", key: "FUTURE NETWORK" }] },
        }),
      ],
    });

    expect(plan.commonModeGroups).toEqual([
      {
        failureDomain: { kind: "chain", key: "future network" },
        members: [
          { assetId: "left", owner: "exit", pathKey: "left-route" },
          { assetId: "right", owner: "supply", pathKey: "supply" },
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
    expect(() => buildV9DependencyEvaluationPlan({ activeAssetIds: ["a", "b"], assets: [asset("a")] })).toThrow(
      /exact active asset set/,
    );
    expect(() =>
      buildV9DependencyEvaluationPlan({ activeAssetIds: ["a"], assets: [asset("a", [edge("missing", "wrapper")])] }),
    ).toThrow(/Invalid.*dependency/);
  });
});

describe("commonModeSignalSeverity (owner rulings Batch 3.3 + Batch 4 (option A) + Batch 5)", () => {
  const materiality = V9_CANDIDATE_POLICY_V1.policy.semantic.materiality;
  const context = (
    shareBySlug: Record<string, number> = {},
    unattributedShare = 0,
    dexExposureByDomain: Record<string, { lower: number; upper: number }> = {},
    bridgeExposureByDomain: Record<
      string,
      {
        shareBounds: { lower: number; upper: number };
        reviewedTiers: readonly string[];
        reviewedTiersComplete?: boolean;
      }
    > = {},
  ): V9CommonModeContext => ({
    supplyExposure: { shareBySlug: new Map(Object.entries(shareBySlug)), unattributedShare },
    dexExposureByDomain: new Map(Object.entries(dexExposureByDomain)),
    bridgeExposureByDomain: new Map(
      Object.entries(bridgeExposureByDomain).map(([key, exposure]) => [
        key,
        { ...exposure, reviewedTiersComplete: exposure.reviewedTiersComplete ?? true },
      ]),
    ) as V9CommonModeContext["bridgeExposureByDomain"],
  });
  // A fully fail-closed context: no attributed share, no reviewed bridge tiers.
  const failClosed = context({}, 1);

  it("grades a reviewed mature chain moderate regardless of exposure", () => {
    for (const chain of materiality.matureChains) {
      expect(commonModeSignalSeverity({ kind: "chain", key: chain }, failClosed, materiality)).toBe("moderate");
    }
  });

  it("normalizes DefiLlama display-name chain keys to their canonical slug before matching", () => {
    for (const [displayName, slug] of [
      ["Ethereum", "ethereum"],
      ["OP Mainnet", "optimism"],
      ["Solana", "solana"],
    ] as const) {
      expect(materiality.matureChains).toContain(slug);
      expect(commonModeSignalSeverity({ kind: "chain", key: displayName }, failClosed, materiality)).toBe("moderate");
    }
  });

  it("grades chain concentration by material exposure (Batch 4)", () => {
    expect(materiality.commonModeSignal.severity).toBe("high");
    expect(materiality.commonModeShareThreshold).toBe(0.05);
    // Material non-mature share -> high; the display-name form resolves the same.
    expect(commonModeSignalSeverity({ kind: "chain", key: "fantom" }, context({ fantom: 0.1 }), materiality)).toBe(
      "high",
    );
    expect(commonModeSignalSeverity({ kind: "chain", key: "Fantom" }, context({ fantom: 0.1 }), materiality)).toBe(
      "high",
    );
    // Immaterial non-mature share and an explicitly bounded unattributed bucket -> moderate.
    expect(commonModeSignalSeverity({ kind: "chain", key: "fantom" }, context({ fantom: 0.01 }), materiality)).toBe(
      "moderate",
    );
    expect(commonModeSignalSeverity({ kind: "chain", key: "fantom" }, context({}, 0.01), materiality)).toBe("moderate");
    // A missing distribution fails closed; threshold exactly = material.
    expect(commonModeSignalSeverity({ kind: "chain", key: "fantom" }, failClosed, materiality)).toBe("high");
    expect(commonModeSignalSeverity({ kind: "chain", key: "fantom" }, context({}, 0.36), materiality)).toBe("high");
    expect(commonModeSignalSeverity({ kind: "chain", key: "unknown-l2" }, context({}, 0.36), materiality)).toBe("high");
    expect(commonModeSignalSeverity({ kind: "chain", key: "fantom" }, context({ fantom: 0.05 }), materiality)).toBe(
      "high",
    );
    expect(commonModeSignalSeverity({ kind: "chain", key: "fantom" }, context({ fantom: 0.0499 }), materiality)).toBe(
      "moderate",
    );
  });

  it("retains exact USDC non-mature chain materiality from the retained input", () => {
    const circulatingUsd = 73_162_245_998.21791;
    const fantomShare = 181_391_703.16336077 / circulatingUsd;
    const hyperliquidShare = 6_113_271_468.09971 / circulatingUsd;
    const exactUsdc = context({ fantom: fantomShare, hyperliquid: hyperliquidShare }, 0);

    expect(fantomShare * 100).toBeCloseTo(0.2479307472, 9);
    expect(hyperliquidShare * 100).toBeCloseTo(8.3557733701, 9);
    expect(commonModeSignalSeverity({ kind: "chain", key: "Fantom" }, exactUsdc, materiality)).toBe("moderate");
    expect(commonModeSignalSeverity({ kind: "chain", key: "Hyperliquid L1" }, exactUsdc, materiality)).toBe("high");
  });

  it("grades DEX common mode on conservative capacity bounds while mature venues stay diagnostic", () => {
    expect(materiality.matureVenues).toEqual(expect.arrayContaining(["curve", "balancer", "uniswap"]));
    for (const venue of ["curve", "balancer", "uniswap", "Curve", "UNISWAP"]) {
      expect(commonModeSignalSeverity({ kind: "dex-protocol", key: venue }, failClosed, materiality)).toBe("low");
    }
    const key = "dex-protocol:raydium";
    expect(
      commonModeSignalSeverity(
        { kind: "dex-protocol", key: "raydium" },
        context({}, 0, {
          [key]: { lower: 0.0499, upper: 0.0499 },
        }),
        materiality,
      ),
    ).toBe("low");
    expect(
      commonModeSignalSeverity(
        { kind: "dex-protocol", key: "raydium" },
        context({}, 0, {
          [key]: { lower: 0.05, upper: 0.05 },
        }),
        materiality,
      ),
    ).toBe("high");
    expect(
      commonModeSignalSeverity(
        { kind: "dex-protocol", key: "raydium" },
        context({}, 0, {
          [key]: { lower: 0.0499, upper: 1 },
        }),
        materiality,
      ),
    ).toBe("high");
    expect(commonModeSignalSeverity({ kind: "dex-protocol", key: "raydium" }, failClosed, materiality)).toBe("high");
  });

  it("grades bridge common mode on share bounds plus non-conflicting reviewed tiers", () => {
    const domainKey = "bridge-route:protocol:chainlink-ccip";
    const bridgeContext = (
      lower: number,
      upper: number,
      reviewedTiers: readonly string[],
      reviewedTiersComplete = true,
    ) => context({}, 0, {}, { [domainKey]: { shareBounds: { lower, upper }, reviewedTiers, reviewedTiersComplete } });
    // Unknown share is still moderate when the one associated tier is reviewed low-risk.
    const lowRisk = bridgeContext(0, 1, ["external-validated-network"]);
    expect(
      commonModeSignalSeverity({ kind: "bridge-route", key: "protocol:chainlink-ccip" }, lowRisk, materiality),
    ).toBe("moderate");
    const allLowRisk = bridgeContext(0, 1, ["canonical-rollup-bridge", "external-validated-network"]);
    expect(
      commonModeSignalSeverity({ kind: "bridge-route", key: "protocol:chainlink-ccip" }, allLowRisk, materiality),
    ).toBe("moderate");
    // Proven immaterial share is moderate even for a reviewed high-risk tier.
    expect(
      commonModeSignalSeverity(
        { kind: "bridge-route", key: "protocol:chainlink-ccip" },
        bridgeContext(0.0499, 0.0499, ["opaque-or-unknown"]),
        materiality,
      ),
    ).toBe("moderate");
    const highRisk = bridgeContext(0.05, 0.05, ["opaque-or-unknown"]);
    expect(
      commonModeSignalSeverity({ kind: "bridge-route", key: "protocol:chainlink-ccip" }, highRisk, materiality),
    ).toBe("high");
    const conflicting = bridgeContext(0, 1, ["canonical-rollup-bridge", "opaque-or-unknown"]);
    expect(
      commonModeSignalSeverity({ kind: "bridge-route", key: "protocol:chainlink-ccip" }, conflicting, materiality),
    ).toBe("high");
    const incomplete = bridgeContext(0, 1, ["external-validated-network"], false);
    expect(
      commonModeSignalSeverity({ kind: "bridge-route", key: "protocol:chainlink-ccip" }, incomplete, materiality),
    ).toBe("high");
    const missingTier = bridgeContext(0, 1, []);
    expect(
      commonModeSignalSeverity({ kind: "bridge-route", key: "protocol:chainlink-ccip" }, missingTier, materiality),
    ).toBe("high");
    expect(
      commonModeSignalSeverity({ kind: "bridge-route", key: "protocol:chainlink-ccip" }, failClosed, materiality),
    ).toBe("high");
  });

  it("makes reserve-issuer diagnostic and other domains high (Batch 5)", () => {
    // reserve-issuer is excluded from the cap path (backing prices it) -> low.
    expect(
      commonModeSignalSeverity({ kind: "reserve-issuer", key: "United States Treasury" }, failClosed, materiality),
    ).toBe("low");
    // mint-control and other kinds keep the default high.
    expect(commonModeSignalSeverity({ kind: "mint-control", key: "mechanism:x" }, failClosed, materiality)).toBe(
      "high",
    );
    expect(commonModeSignalSeverity({ kind: "reserve-custodian", key: "custodian:a" }, failClosed, materiality)).toBe(
      "high",
    );
  });

  it("prices the graduated severities inside their locked grade bands with low non-capping", () => {
    const limits = V9_CANDIDATE_POLICY_V1.policy.semantic.structural.signalLimits["critical-dependency"];
    expect(limits.low).toBeNull(); // "low" is diagnostic-only (no cap)
    expect(limits.moderate).toBe(79); // top of B+ (75-79)
    expect(limits.high).toBe(64);
  });
});
