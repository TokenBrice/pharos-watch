/**
 * VERITAS dependency / materiality repros (VER-003, VER-004, VER2-001 and the
 * VERITAS-II dependency invariant sweep).
 */
import { describe, expect, it } from "vitest";
import type { V9AssetFactsV2, V9FactStatusV2, V9ReserveExposureFactV2 } from "@shared/types/safety-score-v9-facts";
import {
  evaluateV9ReserveExposures,
  type V9BackingAssetInput,
  type V9ResolvedUpstreamExposure,
} from "../safety-score-v9/backing";
import {
  buildV9DependencyEvaluationPlan,
  resolveV9DependencyInputs,
  type V9DependencyPlanningAsset,
  type V9DependencyPlanningEdge,
} from "../safety-score-v9/dependencies";
import { V9_CANDIDATE_POLICY_V1 } from "../safety-score-v9/policy";
import {
  coreFixture,
  compileNativeV3FactSet,
  evaluateV9FactSet,
  minimalAsset,
  knownStatus as fixtureKnownStatus,
  SOURCE_FINGERPRINTS,
} from "./safety-score-v9-facts.fixture-support";
import { unresolvedArchetype } from "./safety-score-v9-facts.test-support";

  function planningAsset(assetId: string, edges: readonly V9DependencyPlanningEdge[]): V9DependencyPlanningAsset {
    return {
      assetId,
      dependencies: { edges },
      reserveExposures: [],
      exitRoutes: [],
      controls: [],
      peg: { failureDomains: [] },
      supply: { failureDomains: [] },
    };
  }
  function knownStatus(evidenceId: string): V9FactStatusV2 {
    return {
      applicability: { state: "required", policyRuleId: "veritas.required", rationale: null, gapId: null },
      observationState: "known",
      evidenceRefIds: [evidenceId],
      gapIds: [],
    };
  }

  function exposure(
    key: string,
    weight: number,
    trackedAssetId: string | null = null,
    overrides: Partial<V9ReserveExposureFactV2> = {},
  ): V9ReserveExposureFactV2 {
    return {
      exposureKey: key,
      classificationKey: "class:" + key,
      sourceGenerationId: "reserves:veritas",
      provenance: "curated",
      evidenceClass: "independent",
      status: knownStatus("evidence:" + key),
      name: key,
      weight,
      trackedAssetId,
      assetClass: trackedAssetId ? "stablecoin" : "cash",
      issuerOrObligorKey: null,
      riskFactors: [],
      liquidityHorizon: "immediate",
      maturityDaysMax: null,
      failureDomains: [],
      ...overrides,
    };
  }

  function asset(
    reserveExposures: readonly V9ReserveExposureFactV2[],
    resolvedUpstreamExposures: readonly V9ResolvedUpstreamExposure[],
  ): V9BackingAssetInput {
    return {
      assetId: "veritas-dependency-child",
      reserveStatus: knownStatus("evidence:reserve-envelope"),
      reserveExposures,
      gaps: [],
      resolvedUpstreamExposures,
    };
  }

  function unavailable(
    exposureKey: string,
    code: "material-dependency-unavailable" | "nonmaterial-dependency-unavailable",
    upstreamAssetId = "upstream",
  ): V9ResolvedUpstreamExposure {
    return {
      exposureKey,
      upstreamAssetId,
      score: null,
      evidenceLevel: "insufficient",
      reasonCodes: [code],
      failureDomains: [],
    };
  }

// VER-003 / VER-004 backing regressions.
{

  // VER-003: the evaluator declares this reason diagnostic, but backing rewrites
  // it to pillar treatment and the production projection applies a global cap.
  describe("VERITAS finding VER-003: nonmaterial dependency diagnostic becomes a pillar penalty", () => {
    it("preserves diagnostic treatment for a 1% unavailable upstream", () => {
      const result = evaluateV9ReserveExposures(
        asset(
          [
            exposure("cash", 0.99),
            exposure("upstream", 0.01, "upstream"),
          ],
          [unavailable("upstream", "nonmaterial-dependency-unavailable")],
        ),
        V9_CANDIDATE_POLICY_V1,
      );

      expect(result.unresolved).toContainEqual(
        expect.objectContaining({
          code: "nonmaterial-dependency-unavailable",
          treatment: "diagnostic",
        }),
      );
    });
  });

  // VER-004: materiality is assessed per reserve row instead of by the aggregate
  // exposure to one upstream, so row splitting removes a structural ceiling.
  describe("VERITAS finding VER-004: split rows evade aggregate dependency materiality", () => {
    it("keeps a 12% unavailable upstream material when represented by two 6% rows", () => {
      const single = evaluateV9ReserveExposures(
        asset(
          [
            exposure("cash", 0.88),
            exposure("upstream", 0.12, "upstream", { failureDomains: [{ kind: "reserve-custodian", key: "upstream" }] }),
          ],
          [unavailable("upstream", "material-dependency-unavailable")],
        ),
        V9_CANDIDATE_POLICY_V1,
      );
      const split = evaluateV9ReserveExposures(
        asset(
          [
            exposure("cash", 0.88),
            exposure("upstream-a", 0.06, "upstream", { failureDomains: [{ kind: "reserve-custodian", key: "upstream" }] }),
            exposure("upstream-b", 0.06, "upstream", { failureDomains: [{ kind: "reserve-custodian", key: "upstream" }] }),
          ],
          [
            unavailable("upstream-a", "nonmaterial-dependency-unavailable"),
            unavailable("upstream-b", "nonmaterial-dependency-unavailable"),
          ],
        ),
        V9_CANDIDATE_POLICY_V1,
      );

      expect(single.structuralReasons).toContainEqual(
        expect.objectContaining({ kind: "unsafe-backing", severity: "high", ceiling: 59 }),
      );
      expect(split.structuralReasons).toContainEqual(
        expect.objectContaining({ kind: "unsafe-backing", severity: "high", ceiling: 59 }),
      );
    });
  });
}

// Folded in from `safety-score-v9-veritas-2-dependency-invariants.test.ts` (VERITAS-II dependency invariants).
{
  const ASSET_IDS = ["a", "b", "c", "d"] as const;
  const POSSIBLE_DAG_EDGES = [
    ["a", "b"],
    ["a", "c"],
    ["a", "d"],
    ["b", "c"],
    ["b", "d"],
    ["c", "d"],
  ] as const;


  function dependencyEdge(upstreamAssetId: string, assetId: string, role: "serial" | "basket"): V9DependencyPlanningEdge {
    return {
      edgeKey: `${role}:${upstreamAssetId}:${assetId}`,
      upstreamAssetId,
      dependencyType: role === "serial" ? "wrapper" : "collateral",
      economicRole: role === "serial" ? "serial-claim" : "basket-exposure",
      weight: role === "serial" ? 1 : 0.25,
      failureDomains: [],
    };
  }

  function dagAssets(encodedRoles: number): V9DependencyPlanningAsset[] {
    const edgesByAsset = new Map<string, V9DependencyPlanningEdge[]>();
    let remaining = encodedRoles;
    for (const [upstreamAssetId, assetId] of POSSIBLE_DAG_EDGES) {
      const role = remaining % 3;
      remaining = Math.floor(remaining / 3);
      if (role === 0) continue;
      const edge = dependencyEdge(upstreamAssetId, assetId, role === 1 ? "serial" : "basket");
      edgesByAsset.set(assetId, [...(edgesByAsset.get(assetId) ?? []), edge]);
    }
    return ASSET_IDS.map((assetId) => planningAsset(assetId, edgesByAsset.get(assetId) ?? []));
  }


  function compositions(total: number, parts: number): number[][] {
    if (parts === 1) return [[total]];
    const result: number[][] = [];
    for (let first = 1; first <= total - parts + 1; first += 1) {
      for (const tail of compositions(total - first, parts - 1)) result.push([first, ...tail]);
    }
    return result;
  }


  describe("VERITAS II dependency invariants", () => {
    it("keeps all 729 four-node DAG role assignments ordered, resolved, and permutation-stable", () => {
      for (let encodedRoles = 0; encodedRoles < 3 ** POSSIBLE_DAG_EDGES.length; encodedRoles += 1) {
        const assets = dagAssets(encodedRoles);
        const plan = buildV9DependencyEvaluationPlan({ activeAssetIds: ASSET_IDS, assets });
        const reversed = buildV9DependencyEvaluationPlan({
          activeAssetIds: [...ASSET_IDS].reverse(),
          assets: [...assets]
            .reverse()
            .map((asset) => planningAsset(asset.assetId, [...asset.dependencies.edges].reverse())),
        });

        expect(reversed, `permutation ${encodedRoles}`).toEqual(plan);
        for (const path of [...plan.serialPaths, ...plan.basketPaths]) {
          expect(
            plan.topologicalOrder.indexOf(path.upstreamAssetId),
            `upstream order ${encodedRoles}:${path.edgeKey}`,
          ).toBeLessThan(plan.topologicalOrder.indexOf(path.assetId));
        }

        const resolved = resolveV9DependencyInputs(
          plan,
          ASSET_IDS.map((assetId, index) => ({
            assetId,
            score: 90 - index,
            backingScore: 90 - index,
          })),
        );
        expect(
          resolved.flatMap((entry) => entry.serial),
          `serial count ${encodedRoles}`,
        ).toHaveLength(plan.serialPaths.length);
        expect(
          resolved.flatMap((entry) => entry.basket),
          `basket count ${encodedRoles}`,
        ).toHaveLength(plan.basketPaths.length);
        expect(
          resolved.every((entry) => !entry.cycleBlocked),
          `cycle state ${encodedRoles}`,
        ).toBe(true);
        expect(
          resolved.flatMap((entry) => entry.serial).every((entry) => !entry.blocked),
          String(encodedRoles),
        ).toBe(true);
        expect(
          resolved.flatMap((entry) => entry.basket).every((entry) => !entry.boundedUnknown),
          String(encodedRoles),
        ).toBe(true);
      }

      const unicodeTiedEdges = [
        dependencyEdge("route:ä", "child", "basket"),
        dependencyEdge("route:z", "child", "basket"),
      ];
      const unicodePlan = buildV9DependencyEvaluationPlan({
        activeAssetIds: ["child", "route:ä", "route:z"],
        assets: [
          planningAsset("child", unicodeTiedEdges),
          planningAsset("route:ä", []),
          planningAsset("route:z", []),
        ],
      });
      const permutedUnicodePlan = buildV9DependencyEvaluationPlan({
        activeAssetIds: ["route:z", "route:ä", "child"],
        assets: [
          planningAsset("route:z", []),
          planningAsset("route:ä", []),
          planningAsset("child", [...unicodeTiedEdges].reverse()),
        ],
      });
      expect(unicodePlan.basketPaths.map((path) => path.upstreamAssetId)).toEqual(["route:z", "route:ä"]);
      expect(permutedUnicodePlan).toEqual(unicodePlan);
      expect(permutedUnicodePlan.planDigest).toBe(unicodePlan.planDigest);
    });

    it("preserves same-upstream materiality across one-, two-, and three-way threshold partitions", () => {
      for (const totalPercent of [9, 10, 11]) {
        const material = totalPercent >= 10;
        const code = material ? "material-dependency-unavailable" : "nonmaterial-dependency-unavailable";
        const baselineKey = "upstream-0";
        const baseline = evaluateV9ReserveExposures(
          {
            assetId: "veritas-2-partition",
            reserveStatus: knownStatus("evidence:reserve-envelope"),
            reserveExposures: [
              exposure("cash", (99 - totalPercent) / 100, null),
              exposure(baselineKey, totalPercent / 100, "shared-upstream"),
            ],
            gaps: [],
            resolvedUpstreamExposures: [unavailable(baselineKey, code, "shared-upstream")],
          },
          V9_CANDIDATE_POLICY_V1,
        );

        for (const partCount of [1, 2, 3]) {
          for (const partition of compositions(totalPercent, partCount)) {
            const upstreamExposures = partition.map((percent, index) =>
              exposure(`upstream-${index}`, percent / 100, "shared-upstream"),
            );
            const result = evaluateV9ReserveExposures(
              {
                assetId: "veritas-2-partition",
                reserveStatus: knownStatus("evidence:reserve-envelope"),
                reserveExposures: [exposure("cash", (99 - totalPercent) / 100, null), ...upstreamExposures],
                gaps: [],
                resolvedUpstreamExposures: upstreamExposures.map((entry) =>
                  unavailable(entry.exposureKey, code, "shared-upstream"),
                ),
              },
              V9_CANDIDATE_POLICY_V1,
            );

            expect(result.score, `${totalPercent}:${partition.join("+")}`).toBeCloseTo(baseline.score!, 10);
            expect(
              result.unresolved.some((entry) => entry.code === "material-dependency-unavailable"),
              `${totalPercent}:${partition.join("+")}`,
            ).toBe(material);
            expect(
              result.structuralReasons.some((entry) => entry.kind === "unsafe-backing" && entry.severity === "high"),
              `${totalPercent}:${partition.join("+")}`,
            ).toBe(material);
            expect(
              result.contributions
                .filter((entry) => entry.source === "reserve-exposure")
                .reduce((sum, entry) => sum + entry.normalizedWeight, 0),
              `${totalPercent}:${partition.join("+")}`,
            ).toBeCloseTo(1, 12);
          }
        }
      }
    });
  });
}

describe("VERITAS-II finding VER2-001: transitive wrapper splits evade aggregate materiality", () => {
  it("propagates the shared failed root through serial wrappers into basket materiality", () => {
    function evaluate(split: boolean) {
      const root = minimalAsset("root") as unknown as V9AssetFactsV2;
      unresolvedArchetype(root, "root:missing-archetype");
      const wrappers = ["wrapper-a", "wrapper-b"].map((assetId) => {
        const wrapper = minimalAsset(assetId) as unknown as V9AssetFactsV2;
        // Both wrapper backing reviews are unavailable; serial ancestry must
        // identify their common terminal root rather than treating them separately.
        unresolvedArchetype(wrapper, `${assetId}:missing-archetype`);
        wrapper.variantKind = "pure-wrapper";
        wrapper.dependencies.source = "variant";
        wrapper.dependencies.edges = [{
          edgeKey: "wrapper:root",
          upstreamAssetId: "root",
          dependencyType: "wrapper",
          pathKind: "serial-dependency",
          economicRole: "serial-claim",
          weight: 1,
          evidenceRefIds: ["evidence:base"],
          failureDomains: [],
        }];
        return wrapper;
      });
      const child = minimalAsset("child") as unknown as V9AssetFactsV2;
      const upstreamIds = split ? ["wrapper-a", "wrapper-b"] : ["root"];
      child.dependencies.source = "manual";
      child.dependencies.baseSource = "manual";
      child.reserveStatus = fixtureKnownStatus();
      child.reserveExposures = [
        exposure("cash", 0.88),
        ...upstreamIds.map((id) => exposure(id, split ? 0.06 : 0.12, id)),
      ].map((row) => ({
        ...row,
        sourceGenerationId: SOURCE_FINGERPRINTS.researchOverlays.generationId,
        status: fixtureKnownStatus(),
        failureDomains: [{ kind: "reserve-issuer", key: `issuer:${row.exposureKey}` }],
      }));
      child.dependencies.edges = upstreamIds.map((id) => ({
        edgeKey: `collateral:${id}`,
        upstreamAssetId: id,
        dependencyType: "collateral",
        pathKind: "collateral-exposure",
        economicRole: "basket-exposure",
        weight: split ? 0.06 : 0.12,
        evidenceRefIds: ["evidence:base"],
        failureDomains: [],
      }));
      const input = coreFixture();
      input.activeAssetIds = ["root", "wrapper-a", "wrapper-b", "child"];
      input.assets = [root, ...wrappers, child] as unknown as typeof input.assets;
      return evaluateV9FactSet(compileNativeV3FactSet(input), V9_CANDIDATE_POLICY_V1);
    }

    const splitSet = evaluate(true);
    const directSet = evaluate(false);
    for (const id of ["root", "wrapper-a", "wrapper-b"]) {
      expect(splitSet.assets.find((asset) => asset.assetId === id)?.trace.finalGrade, id).toBe("NR");
    }
    const split = splitSet.assets.find((asset) => asset.assetId === "child")!;
    const direct = directSet.assets.find((asset) => asset.assetId === "child")!;
    for (const child of [direct, split]) {
      expect(child.backing.structuralReasons).toContainEqual(expect.objectContaining({
        kind: "unsafe-backing", severity: "high", ceiling: 59,
      }));
      expect(child.backing.unresolved).toContainEqual(expect.objectContaining({
        code: "material-dependency-unavailable",
      }));
      expect(child.trace.caps).toContainEqual(expect.objectContaining({
        kind: "reason:material-dependency-unavailable", limit: 69,
      }));
      // Reserve-claim risk is already priced in backing, not a second whole-asset cap.
      expect(child.trace.caps.map((cap) => cap.kind)).not.toContain("signal:unsafe-backing:high");
    }
    expect(split.backing.score).toBe(direct.backing.score);
    expect(split.trace.finalScore).toBe(direct.trace.finalScore);
  });
});
