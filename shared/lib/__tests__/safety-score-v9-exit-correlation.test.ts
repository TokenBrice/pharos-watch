import { describe, expect, it } from "vitest";
import {
  AS_OF_SEC,
  compileNativeV3FactSet,
  coreFixture,
  createV9EvidenceReference,
  createV9FactGap,
  evaluateV9FactSet,
  V9_CANDIDATE_POLICY_V1,
  type V9AssetFactsV2,
} from "./safety-score-v9-facts.fixture-support";

function evaluateCorrelation(kind: "chain" | "dex-protocol" | "resource", state: "known" | "stale" | "unsourced" = "known") {
  const input = coreFixture();
  const asset = input.assets[0]! as unknown as V9AssetFactsV2;
  const dex = asset.exitRoutes.find((route) => route.routeId === "amm-main")!;
  const redemption = asset.exitRoutes.find((route) => route.routeId === "issuer-main")!;
  if (kind === "resource") {
    redemption.physicalResourceKeys = [...dex.physicalResourceKeys];
  } else {
    dex.failureDomains = [{ kind, key: "shared-reviewed-identity" }];
    redemption.failureDomains = [{ kind, key: "shared-reviewed-identity" }];
  }
  if (state === "unsourced") redemption.status.evidenceRefIds = [];
  if (state === "stale") {
    const evidence = createV9EvidenceReference({
      evidenceId: "alpha:stale-route-evidence", sourceId: "fixture-source",
      sourceGenerationId: redemption.sourceGenerationId, disposition: "observed",
      observedAtSec: 100, maxAgeSec: 100,
    }, AS_OF_SEC);
    asset.evidence.push(evidence);
    redemption.status.evidenceRefIds = [evidence.evidenceId];
    const gap = createV9FactGap({
      gapId: "alpha:stale-route", reasonCode: "missing-runtime-route-evidence", ownerDomain: "exit",
      policyRuleId: "v9.exit.same-notional-route", observationState: "stale",
      path: { kind: "optional-exit", routeKey: redemption.routeKey }, message: "The retained route observation is stale.",
      evidenceRefIds: redemption.status.evidenceRefIds,
    });
    asset.gaps.push(gap);
    redemption.status = { ...redemption.status, observationState: "stale", gapIds: [gap.gapId] };
  }
  return evaluateV9FactSet(compileNativeV3FactSet(input), V9_CANDIDATE_POLICY_V1).assets.find((row) => row.assetId === "alpha")!;
}

describe("known Exit correlation publication", () => {
  it.each(["chain", "dex-protocol"] as const)("publishes sourced shared %s identity as known without diversification credit", (kind) => {
    const evaluated = evaluateCorrelation(kind);
    const reason = evaluated.scoreInput.pillars.exit.reasons.find((entry) => entry.code === "correlated-exit-routes")!;
    expect(reason).toMatchObject({
      cause: "D", responsibility: "measured-adverse", causeGapIds: [],
      causeProof: { cause: "D", adverseFactId: "alpha:exit:correlated-route-inventory" },
    });
    expect(reason.causeProof?.evidenceRefIds.length).toBeGreaterThan(0);
    expect(evaluated.exit.diversificationBonus).toBe(0);
    expect(evaluated.exit.diversificationRouteKey).toBeNull();
    expect(evaluated.exit.score).toBe(evaluated.exit.routes.find((route) => route.routeKey === evaluated.exit.primaryRouteKey)!.score);
    expect(evaluated.trace.adverseAttribution).not.toContainEqual(expect.objectContaining({ path: "exit:correlated-exit-routes" }));
  });

  it("retains U when a shared identity route is stale", () => {
    const evaluated = evaluateCorrelation("dex-protocol", "stale");
    expect(evaluated.scoreInput.pillars.exit.reasons).toContainEqual(expect.objectContaining({
      code: "correlated-exit-routes", cause: "U", responsibility: "unresearched",
    }));
    expect(evaluated.exit.diversificationBonus).toBe(0);
  });

  it("rejects unsourced known identity instead of publishing correlation as researched", () => {
    expect(() => evaluateCorrelation("dex-protocol", "unsourced")).toThrow(/evidenceRefIds/);
  });

  it("rejects physical-resource reuse before any diversification fact can publish", () => {
    expect(() => evaluateCorrelation("resource")).toThrow(/Physical resource .* reused/);
  });

  it("keeps independent route credit and emits no correlation fact", () => {
    const evaluated = evaluateV9FactSet(compileNativeV3FactSet(coreFixture()), V9_CANDIDATE_POLICY_V1).assets.find((row) => row.assetId === "alpha")!;
    expect(evaluated.exit.diversificationBonus).toBeGreaterThan(0);
    expect(evaluated.scoreInput.pillars.exit.reasons.some((reason) => reason.code === "correlated-exit-routes")).toBe(false);
  });
});
