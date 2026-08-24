import { describe, expect, it } from "vitest";
import type {
  V9DependencyEconomicRole,
  V9DependencyPlanningAsset,
  V9DependencyPlanningEdge,
} from "../safety-score-v9/dependencies";
import {
  buildV9DependencyEvaluationPlan,
  distinctV9RootLiabilityIds,
  projectV9RoleDependencyPillarLimits,
  resolveV9DependencyInputs,
} from "../safety-score-v9/dependencies";
import {
  commonModeSignalSeverity,
  projectV9EffectiveBackingPillarScore,
  projectV9ResolvedBackingExposure,
  type V9CommonModeContext,
  type V9EvaluatedAsset,
} from "../safety-score-v9/evaluate-set";
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
    economicRole: dependencyType === "collateral" ? ("basket-exposure" as const) : ("serial-claim" as const),
    weight,
    failureDomains: [],
  };
}

function roleEdge(
  edgeKey: string,
  upstreamAssetId: string,
  economicRole: V9DependencyEconomicRole,
  weight: number,
  failureDomains: V9DependencyPlanningEdge["failureDomains"] = [],
): V9DependencyPlanningEdge {
  const defaultFailureDomains: V9DependencyPlanningEdge["failureDomains"] =
    economicRole === "exit-dependency"
      ? [{ kind: "redemption-rail", key: `rail:${upstreamAssetId}` }]
      : economicRole === "control-operator"
        ? [{ kind: "mint-control", key: `operator:${upstreamAssetId}` }]
        : economicRole === "oracle-nav"
          ? [{ kind: "oracle-feed", key: `oracle:${upstreamAssetId}` }]
          : [];
  return {
    edgeKey,
    upstreamAssetId,
    dependencyType:
      economicRole === "serial-claim" ? "wrapper" : economicRole === "basket-exposure" ? "collateral" : "mechanism",
    economicRole,
    weight,
    evidenceRefIds: [`evidence:${edgeKey}`],
    failureDomains: failureDomains.length > 0 ? failureDomains : defaultFailureDomains,
  };
}

describe("buildV9DependencyEvaluationPlan", () => {
  it("inherits the post-credit backing pillar rather than the raw backing result", () => {
    const upstream = {
      backing: { score: 72 },
      scoreInput: { pillars: { backing: { score: 78 } } },
    } as unknown as Pick<V9EvaluatedAsset, "backing" | "scoreInput">;

    expect(projectV9EffectiveBackingPillarScore(upstream)).toBe(78);
  });

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

  it("does not count a serial derivative as a second independent root liability", () => {
    const plan = buildV9DependencyEvaluationPlan({
      activeAssetIds: ["derivative", "root"],
      assets: [asset("root"), asset("derivative", [edge("root", "wrapper")])],
    });

    expect(distinctV9RootLiabilityIds(["root", "derivative"], plan.serialPaths)).toEqual(["root"]);
  });

  it("keeps genuinely independent liabilities distinct for the common-control census", () => {
    const plan = buildV9DependencyEvaluationPlan({
      activeAssetIds: ["alpha", "beta"],
      assets: [asset("alpha"), asset("beta")],
    });

    expect(distinctV9RootLiabilityIds(["alpha", "beta"], plan.serialPaths)).toEqual(["alpha", "beta"]);
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
      { assetId: "a", score: null, backingScore: null },
      { assetId: "b", score: null, backingScore: null },
    ]);
    expect(resolved.find((item) => item.assetId === "serial")?.cycleBlocked).toBe(true);
    expect(resolved.find((item) => item.assetId === "basket")?.cycleBlocked).toBe(false);
    expect(resolved.find((item) => item.assetId === "basket")?.basket[0]?.boundedUnknown).toBe(true);
  });

  it("uses final score for serial claims and backing score for collateral baskets", () => {
    const plan = buildV9DependencyEvaluationPlan({
      activeAssetIds: ["basket", "parent", "serial"],
      assets: [
        asset("parent"),
        asset("serial", [edge("parent", "wrapper")]),
        asset("basket", [edge("parent", "collateral", 1)]),
      ],
    });
    const resolved = resolveV9DependencyInputs(plan, [
      { assetId: "parent", score: null, backingScore: 82 },
    ]);

    expect(resolved.find((item) => item.assetId === "serial")?.serial).toEqual([
      { upstreamAssetId: "parent", score: null, blocked: true },
    ]);
    expect(resolved.find((item) => item.assetId === "basket")?.basket).toEqual([
      { upstreamAssetId: "parent", weight: 1, score: 82, boundedUnknown: false },
    ]);
  });

  it("propagates only the immediate parent result through a nested wrapper", () => {
    const plan = buildV9DependencyEvaluationPlan({
      activeAssetIds: ["child", "parent", "root"],
      assets: [
        asset("root"),
        asset("parent", [edge("root", "wrapper")]),
        asset("child", [edge("parent", "wrapper")]),
      ],
    });
    const resolved = resolveV9DependencyInputs(plan, [
      { assetId: "root", score: 90, backingScore: 94 },
      { assetId: "parent", score: 84, backingScore: 88 },
    ]);

    expect(resolved.find((item) => item.assetId === "parent")?.serial[0]?.score).toBe(90);
    expect(resolved.find((item) => item.assetId === "child")?.serial).toEqual([
      { upstreamAssetId: "parent", score: 84, blocked: false },
    ]);
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

  it("resolves exit, control/operator, and oracle/NAV roles from only their relevant upstream dimensions", () => {
    const plan = buildV9DependencyEvaluationPlan({
      activeAssetIds: ["child", "parent"],
      assets: [
        asset("parent"),
        asset("child", [
          roleEdge("basket:parent", "parent", "basket-exposure", 0.3),
          roleEdge("exit:parent", "parent", "exit-dependency", 0.75),
          roleEdge("control:parent", "parent", "control-operator", 0.4),
          roleEdge("oracle:parent", "parent", "oracle-nav", 0.6),
        ]),
      ],
    });

    expect(plan.serialPaths).toHaveLength(0);
    expect(plan.basketPaths).toHaveLength(1);
    expect(plan.exitPaths).toHaveLength(1);
    expect(plan.controlPaths).toHaveLength(1);
    expect(plan.oracleNavPaths).toHaveLength(1);

    const resolved = resolveV9DependencyInputs(plan, [
      {
        assetId: "parent",
        score: 88,
        backingScore: 91,
        exitScore: 78,
        accessScore: 66,
        controlScore: 72,
        oracleNavScore: 81,
      },
    ]).find((input) => input.assetId === "child")!;
    const byRole = new Map(resolved.roleInputs!.map((input) => [input.role, input]));

    expect(byRole.get("basket-exposure")).toMatchObject({
      score: 91,
      inheritedDimensions: ["backing"],
      boundedUnknown: false,
    });
    expect(byRole.get("exit-dependency")).toMatchObject({
      score: 66,
      inheritedDimensions: ["exit", "access"],
      boundedUnknown: false,
    });
    expect(byRole.get("control-operator")).toMatchObject({
      score: 72,
      inheritedDimensions: ["control"],
      boundedUnknown: false,
    });
    expect(byRole.get("oracle-nav")).toMatchObject({
      score: 81,
      inheritedDimensions: ["oracle-nav"],
      boundedUnknown: false,
    });
    const limits = projectV9RoleDependencyPillarLimits(resolved);
    expect(limits.exit.limit).toBeCloseTo(74.5, 10);
    expect(limits.control.limit).toBeCloseTo(77.4, 10);
  });

  it("fails an exit role closed when access is unavailable and preserves exact trace attribution", () => {
    const rail = { kind: "reserve-custodian" as const, key: "bank-a" };
    const plan = buildV9DependencyEvaluationPlan({
      activeAssetIds: ["child", "parent"],
      assets: [
        asset("parent"),
        asset("child", [
          {
            ...roleEdge("exit:parent", "parent", "exit-dependency", 0.4, [rail]),
            evidenceRefIds: ["evidence:rail"],
          },
        ]),
      ],
    });
    const resolved = resolveV9DependencyInputs(plan, [
      { assetId: "parent", score: 90, backingScore: 90, exitScore: 84 },
    ]).find((input) => input.assetId === "child")!;

    expect(resolved.cycleBlocked).toBe(false);
    expect(resolved.roleInputs).toEqual([
      {
        assetId: "child",
        upstreamAssetId: "parent",
        edgeKey: "exit:parent",
        exposureKey: "exit:parent",
        riskEventKey: "dependency-event:reserve-custodian:bank-a",
        dependencyType: "mechanism",
        role: "exit-dependency",
        weight: 0.4,
        inheritedDimensions: ["exit", "access"],
        unavailableDimensions: ["access"],
        score: null,
        boundedUnknown: true,
        cycleBlocked: false,
        evidenceRefIds: ["evidence:rail"],
        failureDomains: [rail],
      },
    ]);
    expect(projectV9RoleDependencyPillarLimits(resolved).exit).toMatchObject({
      limit: null,
      knownLossPoints: 0,
      unresolvedExposureShare: 0.4,
    });
  });

  it("bounds sub-material unknown role exposure and withholds only at the material threshold", () => {
    const resolveUnknownExit = (weight: number) => {
      const plan = buildV9DependencyEvaluationPlan({
        activeAssetIds: ["child", "parent"],
        assets: [
          asset("parent"),
          asset("child", [roleEdge("exit:parent", "parent", "exit-dependency", weight)]),
        ],
      });
      return resolveV9DependencyInputs(plan, [
        { assetId: "parent", score: 90, backingScore: 90, exitScore: 84 },
      ]).find((input) => input.assetId === "child")!;
    };

    expect(
      projectV9RoleDependencyPillarLimits(resolveUnknownExit(0.01), {
        unresolvedMaterialityThreshold: 0.1,
      }).exit,
    ).toMatchObject({
      limit: 99,
      boundedUnknownLossPoints: 1,
      unresolvedExposureShare: 0.01,
      materialUnresolvedExposure: false,
    });
    expect(
      projectV9RoleDependencyPillarLimits(resolveUnknownExit(0.1), {
        unresolvedMaterialityThreshold: 0.1,
      }).exit,
    ).toMatchObject({
      limit: null,
      boundedUnknownLossPoints: 10,
      unresolvedExposureShare: 0.1,
      materialUnresolvedExposure: true,
    });
  });

  it("lets serial inheritance dominate other roles once while retaining their distinct failure domains", () => {
    const shared = domain("reserve-custodian", "bank-a");
    const oracle = { kind: "oracle-feed" as const, key: "feed-a" };
    const plan = buildV9DependencyEvaluationPlan({
      activeAssetIds: ["child", "parent"],
      assets: [
        asset("parent"),
        asset(
          "child",
          [
            roleEdge("serial:parent", "parent", "serial-claim", 1, [shared]),
            roleEdge("exit:parent", "parent", "exit-dependency", 0.5, [shared]),
            roleEdge("oracle:parent", "parent", "oracle-nav", 0.5, [oracle]),
          ],
          { exitRoutes: [{ routeKey: "local-redeem", failureDomains: [shared] }] },
        ),
      ],
    });

    expect(plan.serialPaths).toEqual([
      expect.objectContaining({
        edgeKey: "serial:parent",
        failureDomains: [oracle, shared],
      }),
    ]);
    expect(plan.exitPaths).toHaveLength(0);
    expect(plan.oracleNavPaths).toHaveLength(0);
    expect(plan.suppressedRoles).toEqual([
      expect.objectContaining({
        selectedRole: "serial-claim",
        suppressedRole: "exit-dependency",
        reason: "serial-role-dominates",
      }),
      expect.objectContaining({
        selectedRole: "serial-claim",
        suppressedRole: "oracle-nav",
        reason: "serial-role-dominates",
      }),
    ]);
    expect(plan.commonModeGroups.find((group) => group.failureDomain.key === "bank-a")?.members).toEqual([
      { assetId: "child", owner: "dependency", pathKey: "serial:parent" },
      { assetId: "child", owner: "exit", pathKey: "local-redeem" },
    ]);
  });

  it("preserves distinct authored slices for the same upstream and role", () => {
    const first = domain("reserve-custodian", "bank-a");
    const second = { kind: "redemption-rail" as const, key: "rail-b" };
    const edges = [
      roleEdge("z-larger", "parent", "exit-dependency", 0.7, [first]),
      roleEdge("a-smaller", "parent", "exit-dependency", 0.3, [second]),
    ];
    const forward = buildV9DependencyEvaluationPlan({
      activeAssetIds: ["child", "parent"],
      assets: [asset("parent"), asset("child", edges)],
    });
    const reversed = buildV9DependencyEvaluationPlan({
      activeAssetIds: ["parent", "child"],
      assets: [asset("child", [...edges].reverse()), asset("parent")],
    });

    expect(reversed).toEqual(forward);
    expect(forward.exitPaths).toEqual([
      expect.objectContaining({
        edgeKey: "a-smaller",
        exposureKey: "a-smaller",
        weight: 0.3,
        failureDomains: [second],
      }),
      expect.objectContaining({
        edgeKey: "z-larger",
        exposureKey: "z-larger",
        weight: 0.7,
        failureDomains: [first],
      }),
    ]);
    expect(forward.suppressedRoles).toEqual([]);
  });

  it("does not use a shared provider domain as proof of one holder slice", () => {
    const shared = domain("mint-control", "operator-a");
    const plan = buildV9DependencyEvaluationPlan({
      activeAssetIds: ["child", "parent"],
      assets: [
        asset("parent"),
        asset("child", [
          roleEdge("control:parent", "parent", "control-operator", 0.6, [shared]),
          roleEdge("oracle:parent", "parent", "oracle-nav", 0.6, [shared]),
        ]),
      ],
    });
    const resolved = resolveV9DependencyInputs(plan, [
      { assetId: "parent", score: 85, backingScore: 90, controlScore: 70, oracleNavScore: 50 },
    ]).find((input) => input.assetId === "child")!;
    const projection = projectV9RoleDependencyPillarLimits(resolved).control;

    expect(projection).toMatchObject({
      limit: 60,
      knownLossPoints: 40,
      unresolvedExposureShare: 0,
    });
    expect(projection.events).toEqual([
      expect.objectContaining({
        exposureKey: "control:parent",
        roles: ["control-operator"],
        edgeKeys: ["control:parent"],
        nominalExposureShare: 0.6,
        exposureShare: 0.5,
        inheritedScore: 70,
        modeledLossPoints: 15,
        failureDomains: [shared],
      }),
      expect.objectContaining({
        exposureKey: "oracle:parent",
        roles: ["oracle-nav"],
        edgeKeys: ["oracle:parent"],
        nominalExposureShare: 0.6,
        exposureShare: 0.5,
        inheritedScore: 50,
        modeledLossPoints: 25,
        failureDomains: [shared],
      }),
    ]);
  });

  it("adds two distinct ten-percent slices that share one operator", () => {
    const shared = domain("mint-control", "operator-a");
    const plan = buildV9DependencyEvaluationPlan({
      activeAssetIds: ["child", "left", "right"],
      assets: [
        asset("left"),
        asset("right"),
        asset("child", [
          roleEdge("control:left", "left", "control-operator", 0.1, [shared]),
          roleEdge("control:right", "right", "control-operator", 0.1, [shared]),
        ]),
      ],
    });
    const resolved = resolveV9DependencyInputs(plan, [
      { assetId: "left", score: 0, backingScore: 0, controlScore: 0 },
      { assetId: "right", score: 0, backingScore: 0, controlScore: 0 },
    ]).find((input) => input.assetId === "child")!;
    const projection = projectV9RoleDependencyPillarLimits(resolved).control;

    expect(projection).toMatchObject({
      limit: 80,
      knownLossPoints: 20,
      unresolvedExposureShare: 0,
    });
    expect(projection.events.map((event) => event.exposureKey)).toEqual([
      "control:left",
      "control:right",
    ]);
  });

  it("does not charge two risk events twice when explicit identity proves one slice", () => {
    const shared = domain("mint-control", "operator-a");
    const plan = buildV9DependencyEvaluationPlan({
      activeAssetIds: ["child", "left", "right"],
      assets: [
        asset("left"),
        asset("right"),
        asset("child", [
          roleEdge("control:left", "left", "control-operator", 0.1, [shared]),
          roleEdge("control:right", "right", "control-operator", 0.1, [shared]),
        ]),
      ],
    });
    const resolved = resolveV9DependencyInputs(plan, [
      { assetId: "left", score: 0, backingScore: 0, controlScore: 0 },
      { assetId: "right", score: 0, backingScore: 0, controlScore: 0 },
    ]).find((input) => input.assetId === "child")!;
    const sameSlice = {
      ...resolved,
      roleInputs: resolved.roleInputs?.map((input) => ({
        ...input,
        exposureKey: "deployment:shared",
        riskEventKey: `event:${input.edgeKey}`,
      })),
    };
    const projection = projectV9RoleDependencyPillarLimits(sameSlice).control;

    expect(projection).toMatchObject({
      limit: 90,
      knownLossPoints: 10,
      unresolvedExposureShare: 0,
    });
    expect(projection.events).toHaveLength(1);
    expect(projection.events[0]).toMatchObject({
      exposureKey: "deployment:shared",
      nominalExposureShare: 0.1,
      exposureShare: 0.1,
    });
  });

  it("contains non-serial role cycles to the affected dimensions instead of blocking the whole claim", () => {
    const plan = buildV9DependencyEvaluationPlan({
      activeAssetIds: ["a", "b"],
      assets: [
        asset("a", [roleEdge("a-exit-b", "b", "exit-dependency", 1)]),
        asset("b", [roleEdge("b-control-a", "a", "control-operator", 1)]),
      ],
    });
    const resolved = resolveV9DependencyInputs(plan, [
      {
        assetId: "a",
        score: 80,
        backingScore: 80,
        exitScore: 80,
        accessScore: 80,
        controlScore: 80,
      },
      {
        assetId: "b",
        score: 80,
        backingScore: 80,
        exitScore: 80,
        accessScore: 80,
        controlScore: 80,
      },
    ]);

    expect(plan.cyclicComponents).toEqual([["a", "b"]]);
    expect(plan.serialCycleAssetIds).toEqual([]);
    expect(plan.serialBlockedDescendants).toEqual([]);
    expect(resolved.every((input) => !input.cycleBlocked)).toBe(true);
    expect(resolved.flatMap((input) => input.roleInputs ?? [])).toEqual([
      expect.objectContaining({ edgeKey: "a-exit-b", score: null, boundedUnknown: true, cycleBlocked: true }),
      expect.objectContaining({ edgeKey: "b-control-a", score: null, boundedUnknown: true, cycleBlocked: true }),
    ]);
  });

  it("rejects omissions and dependencies outside the active set", () => {
    expect(() => buildV9DependencyEvaluationPlan({ activeAssetIds: ["a", "b"], assets: [asset("a")] })).toThrow(
      /exact active asset set/,
    );
    expect(() =>
      buildV9DependencyEvaluationPlan({ activeAssetIds: ["a"], assets: [asset("a", [edge("missing", "wrapper")])] }),
    ).toThrow(/Invalid.*dependency/);
    expect(() =>
      buildV9DependencyEvaluationPlan({
        activeAssetIds: ["a", "b"],
        assets: [
          asset("a"),
          asset("b", [
            {
              ...roleEdge("invalid-role", "a", "basket-exposure", 0.5),
              economicRole: "unknown-role",
            } as never,
          ]),
        ],
      }),
    ).toThrow(/supported economic role/);
    expect(() =>
      buildV9DependencyEvaluationPlan({
        activeAssetIds: ["a", "b"],
        assets: [asset("a"), asset("b", [roleEdge("partial-serial", "a", "serial-claim", 0.5)])],
      }),
    ).toThrow(/must cover the whole claim/);
    expect(() =>
      buildV9DependencyEvaluationPlan({
        activeAssetIds: ["a", "b"],
        assets: [
          asset("a"),
          asset("b", [{ ...roleEdge("exit-without-domain", "a", "exit-dependency", 1), failureDomains: [] }]),
        ],
      }),
    ).toThrow(/requires a failure domain/);
    expect(() =>
      buildV9DependencyEvaluationPlan({
        activeAssetIds: ["a", "b"],
        assets: [
          asset("a"),
          asset("b", [{ ...roleEdge("control-without-evidence", "a", "control-operator", 1), evidenceRefIds: [] }]),
        ],
      }),
    ).toThrow(/requires evidence attribution/);
  });
});

describe("dimension-aware backing projection", () => {
  it("carries only the upstream backing evidence and failure domains", () => {
    const backingDomain = domain("reserve-custodian", "bank-a");
    const upstream = {
      backing: {
        failureDomains: [backingDomain],
      },
      scoreInput: {
        pillars: {
          backing: {
            evidenceLevel: "adequate",
            reasons: [
              { code: "bounded-unknown-reserve-exposure" },
              { code: "bounded-unknown-reserve-exposure" },
            ],
          },
        },
      },
    } as unknown as Pick<V9EvaluatedAsset, "backing" | "scoreInput">;

    expect(
      projectV9ResolvedBackingExposure(
        "reserve:parent",
        { upstreamAssetId: "parent", weight: 1, score: 82, boundedUnknown: false },
        upstream,
        ["parent"],
      ),
    ).toEqual({
      exposureKey: "reserve:parent",
      upstreamAssetId: "parent",
      score: 82,
      evidenceLevel: "adequate",
      reasonCodes: ["bounded-unknown-reserve-exposure"],
      failureDomains: [backingDomain],
      failureRootAssetIds: ["parent"],
    });
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
    unmatchedChainLabelPoolShare = 0,
  ): V9CommonModeContext => ({
    supplyExposure: {
      shareBySlug: new Map(Object.entries(shareBySlug)),
      unattributedShare,
      unmatchedChainLabelPoolShare,
      complete: supplyComplete,
    },
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
      ["Hyperliquid L1", "hyperliquid"],
      ["OP Mainnet", "optimism"],
      ["Solana", "solana"],
    ] as const) {
      expect(materiality.matureChains).toContain(slug);
      expect(commonModeSignalSeverity({ kind: "chain", key: displayName }, failClosed, materiality)).toBe("low");
    }
  });

  it("grades non-mature chain concentration at the 10% and 25% boundaries", () => {
    expect(materiality.commonModeSignal.severity).toBe("high");
    // D1 (2026-07-22): rebanded 0.05/0.1 -> 0.10/0.25, same bounded-loss rationale.
    expect(materiality.commonModeShareThreshold).toBe(0.1);
    expect(materiality.commonModeHighShareThreshold).toBe(0.25);
    for (const [share, severity] of [
      [0.0999, "low"],
      [0.1, "moderate"],
      [0.2499, "moderate"],
      [0.25, "high"],
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
    expect(commonModeSignalSeverity({ kind: "chain", key: "0g" }, context({}, 0.1), materiality)).toBe("moderate");
    expect(commonModeSignalSeverity({ kind: "chain", key: "0g" }, context({}, 0.25), materiality)).toBe("high");
    expect(
      commonModeSignalSeverity({ kind: "chain", key: "0g" }, context({}, 0.000812, {}, {}, false), materiality),
    ).toBe("high");
    // The same residual is added to a present domain as a conservative upper bound.
    expect(
      commonModeSignalSeverity({ kind: "chain", key: "fantom" }, context({ fantom: 0.0999 }, 0.0002), materiality),
    ).toBe("moderate");
    // Missing/nonconserved inventory remains unbounded regardless of its nominal residual.
    expect(commonModeSignalSeverity({ kind: "chain", key: "0g" }, context({}, 0, {}, {}, false), materiality)).toBe(
      "high",
    );
    expect(commonModeSignalSeverity({ kind: "chain", key: "fantom" }, failClosed, materiality)).toBe("high");
    expect(commonModeSignalSeverity({ kind: "chain", key: "fantom" }, context({}, 0.36), materiality)).toBe("high");
    expect(commonModeSignalSeverity({ kind: "chain", key: "unknown-l2" }, context({}, 0.36), materiality)).toBe("high");
  });

  it("excludes an immaterial unrecognized-label pool from the unattributed add-on (RULED D-J)", () => {
    // Below the 10% common-mode floor the pooled row is excluded from the
    // conservative add-on, so a chain is graded on its own measured share.
    expect(
      commonModeSignalSeverity(
        { kind: "chain", key: "fantom" },
        context({ fantom: 0.099 }, 0.099, {}, {}, true, 0.099),
        materiality,
      ),
    ).toBe("low");
    // At exactly the floor the pool stays in the add-on and the same measured
    // share grades as before (fail-closed latency case).
    expect(
      commonModeSignalSeverity(
        { kind: "chain", key: "fantom" },
        context({ fantom: 0.099 }, 0.1, {}, {}, true, 0.1),
        materiality,
      ),
    ).toBe("moderate");
    // Only the pooled part is excluded: any other unattributed residue still
    // inflates every chain's conservative upper bound.
    expect(
      commonModeSignalSeverity(
        { kind: "chain", key: "fantom" },
        context({ fantom: 0.08 }, 0.16, {}, {}, true, 0.08),
        materiality,
      ),
    ).toBe("moderate");
    // A pool-free unattributed residual keeps the existing fail-closed add-on.
    expect(
      commonModeSignalSeverity(
        { kind: "chain", key: "fantom" },
        context({ fantom: 0.08 }, 0.08, {}, {}, true, 0),
        materiality,
      ),
    ).toBe("moderate");
  });

  it("keeps retained USDC Hyperliquid exposure diagnostic under R2 maturity", () => {
    const circulatingUsd = 73_162_245_998.21791;
    const fantomShare = 181_391_703.16336077 / circulatingUsd;
    const hyperliquidShare = 6_113_271_468.09971 / circulatingUsd;
    const unattributedShare = 0.000812;
    const exactUsdc = context({ fantom: fantomShare, hyperliquid: hyperliquidShare }, unattributedShare);

    expect(fantomShare * 100).toBeCloseTo(0.2479307472, 9);
    expect(hyperliquidShare * 100).toBeCloseTo(8.3557733701, 9);
    expect(unattributedShare * 100).toBeCloseTo(0.0812, 9);
    expect(commonModeSignalSeverity({ kind: "chain", key: "Fantom" }, exactUsdc, materiality)).toBe("low");
    expect(commonModeSignalSeverity({ kind: "chain", key: "Hyperliquid L1" }, exactUsdc, materiality)).toBe("low");
    expect(commonModeSignalSeverity({ kind: "chain", key: "0g" }, exactUsdc, materiality)).toBe("low");
  });

  it("grades DEX common mode on conservative capacity bounds while mature venues stay diagnostic", () => {
    expect(materiality.matureVenues).toEqual(expect.arrayContaining(["curve", "balancer", "raydium", "uniswap"]));
    for (const venue of ["curve", "balancer", "raydium", "uniswap", "Curve", "RAYDIUM", "UNISWAP"]) {
      expect(commonModeSignalSeverity({ kind: "dex-protocol", key: venue }, failClosed, materiality)).toBe("low");
    }
    const key = "dex-protocol:futuredex";
    for (const [share, severity] of [
      [0.0999, "low"],
      [0.1, "moderate"],
      [0.2499, "moderate"],
      [0.25, "high"],
    ] as const) {
      expect(
        commonModeSignalSeverity(
          { kind: "dex-protocol", key: "futuredex" },
          context({}, 0, { [key]: { lower: share, upper: share } }),
          materiality,
        ),
      ).toBe(severity);
    }
    expect(
      commonModeSignalSeverity(
        { kind: "dex-protocol", key: "futuredex" },
        context({}, 0, {
          [key]: { lower: 0.0499, upper: 1 },
        }),
        materiality,
      ),
    ).toBe("high");
    expect(commonModeSignalSeverity({ kind: "dex-protocol", key: "futuredex" }, failClosed, materiality)).toBe("high");
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
      [0.0999, "low"],
      [0.1, "moderate"],
      [0.2499, "moderate"],
      [0.25, "high"],
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
        bridgeContext(0.01, 0.2499, ["external-validated-network"]),
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
