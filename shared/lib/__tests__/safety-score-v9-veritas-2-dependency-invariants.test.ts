import { describe, expect, it } from "vitest";
import type { V9FactStatusV2, V9ReserveExposureFactV2 } from "@shared/types/safety-score-v9-facts";
import { evaluateV9ReserveExposures, type V9ResolvedUpstreamExposure } from "../safety-score-v9/backing";
import {
  buildV9DependencyEvaluationPlan,
  resolveV9DependencyInputs,
  type V9DependencyPlanningAsset,
  type V9DependencyPlanningEdge,
} from "../safety-score-v9/dependencies";
import { V9_CANDIDATE_POLICY_V1 } from "../safety-score-v9/policy";

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
