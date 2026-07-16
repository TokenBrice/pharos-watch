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

describe("commonModeSignalSeverity proportional materiality", () => {
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
    supplyComplete = true,
  ): V9CommonModeContext => ({
    supplyExposure: { shareBySlug: new Map(Object.entries(shareBySlug)), unattributedShare, complete: supplyComplete },
    dexExposureByDomain: new Map(Object.entries(dexExposureByDomain)),
    bridgeExposureByDomain: new Map(
      Object.entries(bridgeExposureByDomain).map(([key, exposure]) => [
        key,
        { ...exposure, reviewedTiersComplete: exposure.reviewedTiersComplete ?? true },
      ]),
    ) as V9CommonModeContext["bridgeExposureByDomain"],
  });
  // A fully fail-closed context: no attributed share, no reviewed bridge tiers.
  const failClosed = context({}, 1, {}, {}, false);

  it("keeps reviewed mature chains diagnostic regardless of exposure", () => {
    for (const chain of materiality.matureChains) {
      expect(commonModeSignalSeverity({ kind: "chain", key: chain }, failClosed, materiality)).toBe("low");
    }
  });

  it("normalizes DefiLlama display-name chain keys to their canonical slug before matching", () => {
    for (const [displayName, slug] of [
      ["Ethereum", "ethereum"],
      ["OP Mainnet", "optimism"],
      ["Solana", "solana"],
    ] as const) {
      expect(materiality.matureChains).toContain(slug);
      expect(commonModeSignalSeverity({ kind: "chain", key: displayName }, failClosed, materiality)).toBe("low");
    }
  });

  it("grades non-mature chain concentration at the 5% and 10% boundaries", () => {
    expect(materiality.commonModeSignal.severity).toBe("high");
    expect(materiality.commonModeShareThreshold).toBe(0.05);
    expect(materiality.commonModeHighShareThreshold).toBe(0.1);
    for (const [share, severity] of [
      [0.0499, "low"],
      [0.05, "moderate"],
      [0.0999, "moderate"],
      [0.1, "high"],
    ] as const) {
      expect(commonModeSignalSeverity({ kind: "chain", key: "fantom" }, context({ fantom: share }), materiality)).toBe(
        severity,
      );
      expect(commonModeSignalSeverity({ kind: "chain", key: "Fantom" }, context({ fantom: share }), materiality)).toBe(
        severity,
      );
    }
    // A complete inventory bounds an absent domain by its unattributed residual.
    expect(commonModeSignalSeverity({ kind: "chain", key: "0g" }, context({}, 0), materiality)).toBe("low");
    expect(commonModeSignalSeverity({ kind: "chain", key: "0g" }, context({}, 0.000812), materiality)).toBe("low");
    expect(commonModeSignalSeverity({ kind: "chain", key: "0g" }, context({}, 0.05), materiality)).toBe("moderate");
    expect(commonModeSignalSeverity({ kind: "chain", key: "0g" }, context({}, 0.1), materiality)).toBe("high");
    expect(
      commonModeSignalSeverity({ kind: "chain", key: "0g" }, context({}, 0.000812, {}, {}, false), materiality),
    ).toBe("high");
    // The same residual is added to a present domain as a conservative upper bound.
    expect(
      commonModeSignalSeverity({ kind: "chain", key: "fantom" }, context({ fantom: 0.0499 }, 0.0002), materiality),
    ).toBe("moderate");
    // Missing/nonconserved inventory remains unbounded regardless of its nominal residual.
    expect(commonModeSignalSeverity({ kind: "chain", key: "0g" }, context({}, 0, {}, {}, false), materiality)).toBe(
      "high",
    );
    expect(commonModeSignalSeverity({ kind: "chain", key: "fantom" }, failClosed, materiality)).toBe("high");
    expect(commonModeSignalSeverity({ kind: "chain", key: "fantom" }, context({}, 0.36), materiality)).toBe("high");
    expect(commonModeSignalSeverity({ kind: "chain", key: "unknown-l2" }, context({}, 0.36), materiality)).toBe("high");
  });

  it("maps retained USDC non-mature chain exposure into the proportional tiers", () => {
    const circulatingUsd = 73_162_245_998.21791;
    const fantomShare = 181_391_703.16336077 / circulatingUsd;
    const hyperliquidShare = 6_113_271_468.09971 / circulatingUsd;
    const unattributedShare = 0.000812;
    const exactUsdc = context({ fantom: fantomShare, hyperliquid: hyperliquidShare }, unattributedShare);

    expect(fantomShare * 100).toBeCloseTo(0.2479307472, 9);
    expect(hyperliquidShare * 100).toBeCloseTo(8.3557733701, 9);
    expect(unattributedShare * 100).toBeCloseTo(0.0812, 9);
    expect(commonModeSignalSeverity({ kind: "chain", key: "Fantom" }, exactUsdc, materiality)).toBe("low");
    expect(commonModeSignalSeverity({ kind: "chain", key: "Hyperliquid L1" }, exactUsdc, materiality)).toBe("moderate");
    expect(commonModeSignalSeverity({ kind: "chain", key: "0g" }, exactUsdc, materiality)).toBe("low");
  });

  it("grades DEX common mode on conservative capacity bounds while mature venues stay diagnostic", () => {
    expect(materiality.matureVenues).toEqual(expect.arrayContaining(["curve", "balancer", "uniswap"]));
    for (const venue of ["curve", "balancer", "uniswap", "Curve", "UNISWAP"]) {
      expect(commonModeSignalSeverity({ kind: "dex-protocol", key: venue }, failClosed, materiality)).toBe("low");
    }
    const key = "dex-protocol:raydium";
    for (const [share, severity] of [
      [0.0499, "low"],
      [0.05, "moderate"],
      [0.0999, "moderate"],
      [0.1, "high"],
    ] as const) {
      expect(
        commonModeSignalSeverity(
          { kind: "dex-protocol", key: "raydium" },
          context({}, 0, { [key]: { lower: share, upper: share } }),
          materiality,
        ),
      ).toBe(severity);
    }
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

  it("grades bridge common mode by reviewed exposure without tier overrides", () => {
    const domainKey = "bridge-route:protocol:chainlink-ccip";
    const bridgeContext = (
      lower: number,
      upper: number,
      reviewedTiers: readonly string[],
      reviewedTiersComplete = true,
    ) => context({}, 0, {}, { [domainKey]: { shareBounds: { lower, upper }, reviewedTiers, reviewedTiersComplete } });
    for (const [share, severity] of [
      [0.0499, "low"],
      [0.05, "moderate"],
      [0.0999, "moderate"],
      [0.1, "high"],
    ] as const) {
      for (const tier of ["canonical-rollup-bridge", "opaque-or-unknown"] as const) {
        expect(
          commonModeSignalSeverity(
            { kind: "bridge-route", key: "protocol:chainlink-ccip" },
            bridgeContext(share, share, [tier]),
            materiality,
          ),
        ).toBe(severity);
      }
    }
    // A conservative bound uses its upper edge; an incomplete review is unknown.
    expect(
      commonModeSignalSeverity(
        { kind: "bridge-route", key: "protocol:chainlink-ccip" },
        bridgeContext(0.01, 0.0999, ["external-validated-network"]),
        materiality,
      ),
    ).toBe("moderate");
    const incomplete = bridgeContext(0.01, 0.0499, ["external-validated-network"], false);
    expect(
      commonModeSignalSeverity({ kind: "bridge-route", key: "protocol:chainlink-ccip" }, incomplete, materiality),
    ).toBe("high");
    const unknownShare = bridgeContext(0, 1, ["external-validated-network"]);
    expect(
      commonModeSignalSeverity({ kind: "bridge-route", key: "protocol:chainlink-ccip" }, unknownShare, materiality),
    ).toBe("high");
    expect(
      commonModeSignalSeverity({ kind: "bridge-route", key: "protocol:chainlink-ccip" }, failClosed, materiality),
    ).toBe("high");
  });

  it("keeps reserve-issuer diagnostic and serial control domains high", () => {
    // reserve-issuer is excluded from the cap path (backing prices it) -> low.
    expect(
      commonModeSignalSeverity({ kind: "reserve-issuer", key: "United States Treasury" }, failClosed, materiality),
    ).toBe("low");
    // Non-severable controls never enter the proportional share path.
    for (const domain of [
      { kind: "mint-control", key: "mechanism:x" },
      { kind: "reserve-custodian", key: "custodian:a" },
      { kind: "upgrade-control", key: "admin:x" },
    ] as const) {
      expect(commonModeSignalSeverity(domain, context({ fantom: 0.01 }), materiality)).toBe("high");
    }
  });

  it("prices the graduated severities inside their locked grade bands with low non-capping", () => {
    const limits = V9_CANDIDATE_POLICY_V1.policy.semantic.structural.signalLimits["critical-dependency"];
    expect(limits.low).toBeNull(); // "low" is diagnostic-only (no cap)
    expect(limits.moderate).toBe(79); // top of B+ (75-79)
    expect(limits.high).toBe(64);
    expect(materiality.deploymentMaterialSharePct).toBe(10);
  });
});
