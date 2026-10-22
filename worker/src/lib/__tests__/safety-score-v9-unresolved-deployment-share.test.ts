import { describe, expect, it } from "vitest";
import { evaluateV9FactSet } from "@shared/lib/safety-score-v9/evaluate-set";
import { computeV9FactSetDigest } from "@shared/lib/safety-score-v9/facts";
import { V9_CANDIDATE_POLICY_V1 } from "@shared/lib/safety-score-v9/policy";
import type { V9AssetFactsV3 } from "@shared/types/safety-score-v9-facts";
import { compileSafetyScoreV9FactSetFromFixedInput } from "../safety-score-v9/fact-set";
import { materialityFixture } from "./safety-score-v9-fact-set.test-support";

const threshold = V9_CANDIDATE_POLICY_V1.policy.semantic.materiality.deploymentMaterialSharePct / 100;
const materiality = V9_CANDIDATE_POLICY_V1.policy.semantic.materiality;
const fullCeiling = materiality.unresolvedDeploymentFullCeilingSharePct / 100;
const evaluate = (
  share: number | null,
  mutate?: (asset: V9AssetFactsV3) => void,
) => {
  const fixture = materialityFixture(share);
  const compiled = compileSafetyScoreV9FactSetFromFixedInput(fixture.fixed, fixture.extension);
  const facts = JSON.parse(JSON.stringify(compiled)) as typeof compiled;
  const mint = facts.assets[0]!.economicControlReview.mint;
  mint.status = {
    ...mint.status,
    applicability: { state: "not-applicable", policyRuleId: "v9.control.mint-review", gapId: null, rationale: "Reviewed immutable issuance fixture." },
    observationState: "known",
    evidenceRefIds: [...facts.assets[0]!.controlStatus.evidenceRefIds],
    gapIds: [],
  };
  mint.reconciliation = "not-applicable";
  mint.upgrade = { state: "immutable", controlKey: null };
  mint.factorStatuses = {};
  mutate?.(facts.assets[0]!);
  const referencedGapIds = new Set<string>();
  const collectGapIds = (value: unknown): void => {
    if (value === null || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      if (key === "gaps") continue;
      if (key === "gapIds" && Array.isArray(child)) {
        for (const id of child) if (typeof id === "string") referencedGapIds.add(id);
      } else if (key === "gapId" && typeof child === "string") referencedGapIds.add(child);
      else collectGapIds(child);
    }
  };
  collectGapIds(facts.assets[0]);
  facts.assets[0]!.gaps = facts.assets[0]!.gaps.filter((gap) => referencedGapIds.has(gap.gapId));
  const digested = { ...facts, v9FactSetDigest: computeV9FactSetDigest(facts) };
  return { facts: digested.assets[0]!, result: evaluateV9FactSet(digested, V9_CANDIDATE_POLICY_V1).assets[0]! };
};

// Keep the fixture's reviewed bridge resolved so only the newly inventoried
// deployment, not an unrelated reviewed authority question, sizes the cohort.
const evaluateCapturedInventory = (share: number | null, mutate?: (asset: V9AssetFactsV3) => void) =>
  evaluate(share, (asset) => {
    const reviewedBridge = asset.controls.find((control) => control.deploymentKey.startsWith("base:"))!;
    reviewedBridge.authority = { authorityKey: "base:reviewed-bridge", model: "contract", threshold: null };
    reviewedBridge.status = { ...reviewedBridge.status, observationState: "known", gapIds: [] };
    if (reviewedBridge.factorStatuses) delete reviewedBridge.factorStatuses.authority;
    mutate?.(asset);
  });

describe("unresolved deployment share pricing", () => {

  it("keeps the aggregate demotion when an unresolved control lies outside the admitted cohort", () => {
    const { result } = evaluateCapturedInventory(0.1, (asset) => {
      const template = asset.controls.find((control) => control.deploymentKey.startsWith("polygon:"))!;
      asset.controls.push({
        ...template, controlKey: "unknown:root", scope: "global", economicLossScope: "unknown",
        materialSupplyShare: null,
        factorStatuses: { ...template.factorStatuses, economicLossScope: template.status },
      });
    });
    expect(result.scoreInput.pillars.control.evidenceLevel).toBe("limited");
    expect(result.control.reasons).toContainEqual(expect.objectContaining({
      code: "unresolved-control-identity", controlKey: null, path: "controls",
    }));
    expect(result.trace.caps.map((cap) => cap.kind)).not.toContain("reason:unresolved-control-identity");
  });

  it("retains a verified adverse minter on the same unresolved deployment", () => {
    const scenario = (incidentState: "active" | "none") => evaluateCapturedInventory(0.1, (asset) => {
      const template = asset.controls.find((control) => control.deploymentKey.startsWith("polygon:"))!;
      asset.controls.push({
        ...template, controlKey: "mint:adverse-satellite", controlKind: "mint", capabilities: ["mint"],
        status: { ...template.status, observationState: "known", gapIds: [] },
        authority: { authorityKey: "mint:adverse-satellite", model: "multisig", threshold: { required: 2, total: 3 } },
        capSemantics: { kind: "unbounded", bound: null }, claimImpairment: "unbounded",
        incidentState, failureDomains: [{ kind: "mint-control", key: "mint:adverse-satellite" }],
      });
    }).result;
    const healthy = scenario("none");
    const adverse = scenario("active");
    expect(adverse.trace.structuralSignals).toContainEqual(expect.objectContaining({
      kind: "active-control-incident", materialSharePct: 10, economicLossScope: "deployment",
      failureDomainKeys: ["mint-control:mint:adverse-satellite"],
    }));
    expect(adverse.trace.deploymentAdjustments).toContainEqual(expect.objectContaining({
      exposureShare: 0.1,
    }));
    expect(adverse.trace.deploymentAdjustedScore).toBeLessThan(healthy.trace.deploymentAdjustedScore!);
  });



  it.each(["unknown-share", "unadmitted-partition", "missing-row", "stale-control"] as const)(
    "retains bounded uncertainty without a whole-coin ceiling for %s when other chain supply is known",
    (failure) => {
      const { result } = evaluate(threshold / 2, (asset) => {
        const control = asset.controls.find((row) => row.deploymentKey.startsWith("polygon:"))!;
        if (failure === "unknown-share") control.materialSupplyShare = null;
        if (failure === "stale-control") {
          const evidence = asset.evidence.find((row) => row.evidenceId === control.status.evidenceRefIds[0])!;
          const staleEvidence = {
            ...evidence,
            evidenceId: "alpha:research:stale-deployment-control",
            freshness: { state: "stale" as const, ageSec: Math.max(1, evidence.freshness.ageSec), maxAgeSec: 0 },
          };
          asset.evidence.push(staleEvidence);
          control.status.evidenceRefIds = [staleEvidence.evidenceId];
          control.status.observationState = "stale";
        }
        if (failure === "unadmitted-partition") {
          asset.supply.status.observationState = "bounded-unknown";
          asset.supply.status.gapIds = [...control.status.gapIds];
        }
        if (failure === "missing-row") {
          asset.supply.selectedBridgeRoutes = asset.supply.selectedBridgeRoutes.filter(
            (row) => row.deploymentRouteKey !== control.deploymentKey,
          );
        }
      });
      expect(result.scoreInput.pillars.control.reasons.map((reason) => reason.code)).toContain("unresolved-control-identity");
      expect(result.trace.caps.map((cap) => cap.kind)).not.toContain("reason:unresolved-control-identity");
    },
  );

  it.each([fullCeiling, fullCeiling + 0.01, null])("keeps material or unknown share %s bounded at component level, not as a named cap", (share) => {
    const { result } = evaluate(share);
    expect(result.scoreInput.pillars.control.reasons.map((reason) => reason.code)).toContain("unresolved-control-identity");
    expect(result.trace.caps.map((cap) => cap.kind)).not.toContain("reason:unresolved-control-identity");
    expect(result.control.components).toContainEqual(expect.objectContaining({
      cause: "U", scoringDisposition: "bounded-uncertainty",
    }));
  });


  it("publishes and proportionally prices a compromised minority minter without penalizing a healthy one", () => {
    const scenario = (incident: "active" | "none", global = false) => evaluate(0.09, (asset) => {
      const template = asset.controls.find((row) => row.deploymentKey.startsWith("polygon:"))!;
      const status = { ...template.status, observationState: "known" as const, gapIds: [] };
      const root = {
        ...template, controlKey: "mint:root", deploymentKey: asset.supply.selectedBridgeRoutes.find((row) => row.reviewedRouteKind === "native")!.deploymentRouteKey,
        controlKind: "mint" as const, capabilities: ["mint" as const],
        status, scope: "global" as const, economicLossScope: "global-claim" as const,
        materialSupplyShare: null, capSemantics: { kind: "bounded" as const, bound: { amount: 0.1, unit: "supply-fraction" as const } },
        claimImpairment: "bounded" as const, incidentState: "none" as const,
        authority: { authorityKey: "mint:root", model: "multisig" as const, threshold: { required: 2, total: 3 } },
        delaySec: 86_400, failureDomains: [{ kind: "mint-control" as const, key: "mint:root" }],
      };
      root.factorStatuses = {};
      const satellite = {
        ...root, controlKey: "mint:satellite", deploymentKey: template.deploymentKey,
        scope: global ? "global" as const : "deployment" as const,
        economicLossScope: global ? "global-claim" as const : "deployment" as const,
        materialSupplyShare: global ? null : 0.09, incidentState: incident,
        failureDomains: [{ kind: "mint-control" as const, key: "mint:satellite" }],
      };
      asset.controls = [root, satellite];
      asset.economicControlReview.mint = {
        ...asset.economicControlReview.mint, status, controlKey: root.controlKey,
        reconciliation: "not-applicable", supervision: "none", upgrade: { state: "immutable", controlKey: null },
      };
      asset.economicControlReview.mint.factorStatuses = {};
      asset.economicControlReview.bridge = {
        ...asset.economicControlReview.bridge, status: { ...asset.economicControlReview.bridge.status,
          applicability: { state: "not-applicable", policyRuleId: "v9.control.bridge-review", gapId: null, rationale: "Native mint deployments." },
          observationState: "known", gapIds: [] }, routes: [],
      };
      asset.economicControlReview.bridge.factorStatuses = {};
      asset.supply.selectedBridgeRoutes = asset.supply.selectedBridgeRoutes.map((row) => ({
        ...row, reviewState: "selected-reviewed", reviewedRouteKind: "native",
      }));
      asset.supply.selectedRouteSupplyShare = 1;
      asset.supply.unknownRouteSupplyShare = 0;
      asset.supply.unreviewedRouteSupplyShare = 0;
    });
    const healthy = scenario("none").result;
    const compromised = scenario("active").result;
    expect(compromised.control.components).toContainEqual(expect.objectContaining({
      componentKey: "mint", posture: "compromised", binding: false,
      controlKeys: ["mint:satellite"],
    }));
    expect(compromised.trace.structuralSignals).toContainEqual(expect.objectContaining({
      kind: "active-control-incident", severity: "critical", materialSharePct: 9, economicLossScope: "deployment",
    }));
    expect(compromised.trace.deploymentAdjustments).toContainEqual(expect.objectContaining({ exposureShare: 0.09 }));
    // An independent cap may mask the charge in finalScore; the exposure
    // adjustment itself must still price the compromised deployment.
    expect(compromised.trace.deploymentAdjustedScore).toBeLessThan(healthy.trace.deploymentAdjustedScore!);
    expect(compromised.control.score).toBe(healthy.control.score);
    const global = scenario("active", true).result;
    expect(global.control.score).toBeLessThan(healthy.control.score!);
    expect(global.control.score).toBe(25);
    expect(global.trace.caps).not.toContainEqual(expect.objectContaining({ kind: "signal:active-control-incident:critical" }));
  });
});
