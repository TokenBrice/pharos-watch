/**
 * VERITAS dependency / materiality repros (VER-003, VER-004, VER2-001 and the
 * VERITAS-II dependency invariant sweep). Consolidated from three
 * single-incident files; each origin keeps its own fixture scope in a block so
 * every assertion and finding name survives verbatim.
 */
import { describe, expect, it } from "vitest";
import type { V9FactStatusV2, V9ReserveExposureFactV2 } from "@shared/types/safety-score-v9-facts";
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
import { V9_LEGACY_RESPONSIBILITY_BY_REASON } from "../safety-score-v9/facts";
import { scoreV9Input } from "../safety-score-v9/formula";
import { V9_CANDIDATE_POLICY_V1 } from "../safety-score-v9/policy";

// Folded in from `safety-score-v9-veritas-dependency-repros.test.ts` (VER-003 / VER-004).
{
  function knownStatus(evidenceId: string): V9FactStatusV2 {
    return {
      applicability: { state: "required", policyRuleId: "veritas.required", rationale: null, gapId: null },
      observationState: "known",
      evidenceRefIds: [evidenceId],
      gapIds: [],
    };
  }

  function exposure(args: {
    key: string;
    weight: number;
    trackedAssetId?: string | null;
    custodian?: string;
  }): V9ReserveExposureFactV2 {
    return {
      exposureKey: args.key,
      classificationKey: "class:" + args.key,
      sourceGenerationId: "reserves:veritas",
      provenance: "curated",
      evidenceClass: "independent",
      status: knownStatus("evidence:" + args.key),
      name: args.key,
      weight: args.weight,
      trackedAssetId: args.trackedAssetId ?? null,
      assetClass: args.trackedAssetId ? "stablecoin" : "cash",
      issuerOrObligorKey: null,
      riskFactors: [],
      liquidityHorizon: "immediate",
      maturityDaysMax: null,
      failureDomains: [{ kind: "reserve-custodian", key: args.custodian ?? "custodian:" + args.key }],
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
  ): V9ResolvedUpstreamExposure {
    return {
      exposureKey,
      upstreamAssetId: "upstream",
      score: null,
      evidenceLevel: "insufficient",
      reasonCodes: [code],
      failureDomains: [],
    };
  }

  // VER-003: the evaluator declares this reason diagnostic, but backing rewrites
  // it to pillar treatment and the production projection applies a global cap.
  describe("VERITAS finding VER-003: nonmaterial dependency diagnostic becomes a pillar penalty", () => {
    it("preserves diagnostic treatment for a 1% unavailable upstream", () => {
      const result = evaluateV9ReserveExposures(
        asset(
          [
            exposure({ key: "cash", weight: 0.99 }),
            exposure({ key: "upstream", weight: 0.01, trackedAssetId: "upstream" }),
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
            exposure({ key: "cash", weight: 0.88 }),
            exposure({ key: "upstream", weight: 0.12, trackedAssetId: "upstream", custodian: "upstream" }),
          ],
          [unavailable("upstream", "material-dependency-unavailable")],
        ),
        V9_CANDIDATE_POLICY_V1,
      );
      const split = evaluateV9ReserveExposures(
        asset(
          [
            exposure({ key: "cash", weight: 0.88 }),
            exposure({ key: "upstream-a", weight: 0.06, trackedAssetId: "upstream", custodian: "upstream" }),
            exposure({ key: "upstream-b", weight: 0.06, trackedAssetId: "upstream", custodian: "upstream" }),
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

  function knownStatus(evidenceId: string): V9FactStatusV2 {
    return {
      applicability: { state: "required", policyRuleId: "veritas-2.required", rationale: null, gapId: null },
      observationState: "known",
      evidenceRefIds: [evidenceId],
      gapIds: [],
    };
  }

  function exposure(key: string, weight: number, trackedAssetId: string | null): V9ReserveExposureFactV2 {
    return {
      exposureKey: key,
      classificationKey: `class:${key}`,
      sourceGenerationId: "reserves:veritas-2",
      provenance: "curated",
      evidenceClass: "independent",
      status: knownStatus(`evidence:${key}`),
      name: key,
      weight,
      trackedAssetId,
      assetClass: trackedAssetId === null ? "cash" : "stablecoin",
      issuerOrObligorKey: null,
      riskFactors: [],
      liquidityHorizon: "immediate",
      maturityDaysMax: null,
      failureDomains: [],
    };
  }

  function compositions(total: number, parts: number): number[][] {
    if (parts === 1) return [[total]];
    const result: number[][] = [];
    for (let first = 1; first <= total - parts + 1; first += 1) {
      for (const tail of compositions(total - first, parts - 1)) result.push([first, ...tail]);
    }
    return result;
  }

  function unavailableProjection(
    exposureKey: string,
    code: "material-dependency-unavailable" | "nonmaterial-dependency-unavailable",
  ): V9ResolvedUpstreamExposure {
    return {
      exposureKey,
      upstreamAssetId: "shared-upstream",
      score: null,
      evidenceLevel: "insufficient",
      reasonCodes: [code],
      failureDomains: [],
    };
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
            resolvedUpstreamExposures: [unavailableProjection(baselineKey, code)],
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
                  unavailableProjection(entry.exposureKey, code),
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

// Folded in from `safety-score-v9-veritas-2-transitive-materiality-repro.test.ts` (VER2-001).
{
  function knownStatus(evidenceId: string): V9FactStatusV2 {
    return {
      applicability: { state: "required", policyRuleId: "veritas-2.required", rationale: null, gapId: null },
      observationState: "known",
      evidenceRefIds: [evidenceId],
      gapIds: [],
    };
  }

  function exposure(key: string, weight: number, trackedAssetId: string | null): V9ReserveExposureFactV2 {
    return {
      exposureKey: key,
      classificationKey: `class:${key}`,
      sourceGenerationId: "reserves:veritas-2",
      provenance: "curated",
      evidenceClass: "independent",
      status: knownStatus(`evidence:${key}`),
      name: key,
      weight,
      trackedAssetId,
      assetClass: trackedAssetId === null ? "cash" : "stablecoin",
      issuerOrObligorKey: null,
      riskFactors: [],
      liquidityHorizon: "immediate",
      maturityDaysMax: null,
      failureDomains: [],
    };
  }

  function edge(
    edgeKey: string,
    upstreamAssetId: string,
    role: "serial" | "basket",
    weight: number,
  ): V9DependencyPlanningEdge {
    return {
      edgeKey,
      upstreamAssetId,
      dependencyType: role === "serial" ? "wrapper" : "collateral",
      economicRole: role === "serial" ? "serial-claim" : "basket-exposure",
      weight,
      failureDomains: [{ kind: "reserve-issuer", key: `asset:${upstreamAssetId}` }],
    };
  }

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

  function scoreBacking(result: ReturnType<typeof evaluateV9ReserveExposures>) {
    const evidenceLevel = result.unresolved.some((reason) => reason.treatment !== "diagnostic")
      ? ("limited" as const)
      : ("strong" as const);
    return scoreV9Input(
      {
        assetId: "child",
        pillars: { backing: result.score, exit: 95, control: 95 },
        pegScore: 100,
        pegApplicable: true,
        evidenceLevel,
        trackRecordMonths: 48,
        activeDepegBps: null,
        parentRequired: false,
        parentScore: null,
        structuralSignals: result.structuralReasons.map((reason) => ({
          kind: reason.kind,
          severity: reason.severity,
          reason: `${reason.kind} at ${reason.pathKey}`,
          ...(reason.materialShare === null ? {} : { materialSharePct: reason.materialShare * 100 }),
          failureDomainKeys: reason.failureDomains.map((domain) => `${domain.kind}:${domain.key}`),
          evidence: [],
        })),
        unresolved: result.unresolved.map((reason) => ({
          code: reason.code,
          reason: `${reason.code} at ${reason.pathKey}`,
          critical: false,
          responsibility: V9_LEGACY_RESPONSIBILITY_BY_REASON[reason.code],
        })),
      },
      V9_CANDIDATE_POLICY_V1,
    );
  }

  describe("VERITAS-II finding VER2-001: transitive wrapper splits evade aggregate materiality", () => {
    it("keeps two 6% wrappers sharing one failed serial root as material", () => {
      const plan = buildV9DependencyEvaluationPlan({
        activeAssetIds: ["root", "wrapper-a", "wrapper-b", "child"],
        assets: [
          planningAsset("root", []),
          planningAsset("wrapper-a", [edge("wrapper-a:root", "root", "serial", 1)]),
          planningAsset("wrapper-b", [edge("wrapper-b:root", "root", "serial", 1)]),
          planningAsset("child", [
            edge("child:wrapper-a", "wrapper-a", "basket", 0.06),
            edge("child:wrapper-b", "wrapper-b", "basket", 0.06),
          ]),
        ],
      });
      const resolved = resolveV9DependencyInputs(plan, [
        { assetId: "root", score: null, backingScore: null },
        { assetId: "wrapper-a", score: null, backingScore: null },
        { assetId: "wrapper-b", score: null, backingScore: null },
      ]);
      expect(resolved.find((entry) => entry.assetId === "wrapper-a")?.serial[0]?.blocked).toBe(true);
      expect(resolved.find((entry) => entry.assetId === "wrapper-b")?.serial[0]?.blocked).toBe(true);
      expect(resolved.find((entry) => entry.assetId === "child")?.basket).toEqual([
        expect.objectContaining({ upstreamAssetId: "wrapper-a", score: null, weight: 0.06 }),
        expect.objectContaining({ upstreamAssetId: "wrapper-b", score: null, weight: 0.06 }),
      ]);

      const split = evaluateV9ReserveExposures(
        {
          assetId: "child",
          reserveStatus: knownStatus("evidence:reserve-envelope"),
          reserveExposures: [
            exposure("cash", 0.88, null),
            exposure("wrapper-a", 0.06, "wrapper-a"),
            exposure("wrapper-b", 0.06, "wrapper-b"),
          ],
          gaps: [],
          resolvedUpstreamExposures: [
            {
              exposureKey: "wrapper-a",
              upstreamAssetId: "wrapper-a",
              score: null,
              evidenceLevel: "insufficient",
              reasonCodes: ["nonmaterial-dependency-unavailable"],
              failureDomains: [{ kind: "reserve-issuer", key: "asset:root" }],
            },
            {
              exposureKey: "wrapper-b",
              upstreamAssetId: "wrapper-b",
              score: null,
              evidenceLevel: "insufficient",
              reasonCodes: ["nonmaterial-dependency-unavailable"],
              failureDomains: [{ kind: "reserve-issuer", key: "asset:root" }],
            },
          ],
        },
        V9_CANDIDATE_POLICY_V1,
      );
      const direct = evaluateV9ReserveExposures(
        {
          assetId: "child",
          reserveStatus: knownStatus("evidence:reserve-envelope"),
          reserveExposures: [exposure("cash", 0.88, null), exposure("root", 0.12, "root")],
          gaps: [],
          resolvedUpstreamExposures: [
            {
              exposureKey: "root",
              upstreamAssetId: "root",
              score: null,
              evidenceLevel: "insufficient",
              reasonCodes: ["material-dependency-unavailable"],
              failureDomains: [{ kind: "reserve-issuer", key: "asset:root" }],
            },
          ],
        },
        V9_CANDIDATE_POLICY_V1,
      );
      const splitTrace = scoreBacking(split);
      const directTrace = scoreBacking(direct);

      expect(directTrace).toMatchObject({ finalScore: 59, finalGrade: "C" });
      expect(splitTrace.finalScore).toBeLessThanOrEqual(directTrace.finalScore!);
      expect(splitTrace.caps).toContainEqual(
        expect.objectContaining({ kind: "signal:unsafe-backing:high", limit: 59, binding: true }),
      );
    });
  });
}
