import { describe, expect, it } from "vitest";
import type { V9FactStatusV2, V9ReserveExposureFactV2 } from "@shared/types/safety-score-v9-facts";
import { evaluateV9ReserveExposures } from "../safety-score-v9/backing";
import {
  buildV9DependencyEvaluationPlan,
  resolveV9DependencyInputs,
  type V9DependencyPlanningAsset,
  type V9DependencyPlanningEdge,
} from "../safety-score-v9/dependencies";
import { scoreV9Input } from "../safety-score-v9/formula";
import { V9_LEGACY_RESPONSIBILITY_BY_REASON } from "../safety-score-v9/facts";
import { V9_CANDIDATE_POLICY_V1 } from "../safety-score-v9/policy";

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
