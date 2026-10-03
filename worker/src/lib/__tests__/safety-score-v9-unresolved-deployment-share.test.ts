import { describe, expect, it } from "vitest";
import { evaluateV9FactSet } from "@shared/lib/safety-score-v9/evaluate-set";
import { computeV9FactSetDigest } from "@shared/lib/safety-score-v9/facts";
import { V9_CANDIDATE_POLICY_V1 } from "@shared/lib/safety-score-v9/policy";
import { projectSafetyScoreV9Card } from "@shared/lib/safety-score-v9/public";
import type { V9AssetFactsV3 } from "@shared/types/safety-score-v9-facts";
import { compileSafetyScoreV9FactSetFromFixedInput } from "../safety-score-v9/fact-set";
import { materialityFixture } from "./safety-score-v9-fact-set.test-support";

const threshold = V9_CANDIDATE_POLICY_V1.policy.semantic.materiality.deploymentMaterialSharePct / 100;
const materiality = V9_CANDIDATE_POLICY_V1.policy.semantic.materiality;
const blendStart = materiality.unresolvedDeploymentBlendStartSharePct / 100;
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
  it.each([0, 0.04, 0.1, 0.16, null])(
    "prices the compiled unresolved inventory by its captured share %s without a missing-data ceiling",
    (share) => {
      const { facts, result } = evaluateCapturedInventory(share);
      const unresolved = facts.controls.find((control) => control.deploymentKey.startsWith("polygon:"))!;
      if (share === null) expect(unresolved.materialSupplyShare).toBeNull();
      else expect(unresolved.materialSupplyShare).toBeCloseTo(share);
      expect(unresolved.status.observationState).toBe("bounded-unknown");
      expect(facts.gaps).toContainEqual(expect.objectContaining({
        gapId: unresolved.status.gapIds[0], reasonCode: "unresolved-control-identity",
      }));
      if (share === null || share >= fullCeiling) {
        expect(result.scoreInput.pillars.control.evidenceLevel).toBe("limited");
        expect(result.trace.caps.map((cap) => cap.kind)).not.toContain("reason:unresolved-control-identity");
        expect(result.trace.caps.map((cap) => cap.kind)).not.toContain("unresolved-deployment-share-band");
        return;
      }
      expect(result.scoreInput.pillars.control.evidenceLevel).toBe("strong");
      expect(result.scoreInput.pillars.control.score).toBeCloseTo(
        result.control.score! -
          Math.max(0, result.control.score! - V9_CANDIDATE_POLICY_V1.policy.semantic.control.boundedUnknownQuality) * share,
      );
      expect(result.trace.caps.map((cap) => cap.kind)).not.toContain("reason:unresolved-control-identity");
      if (share === 0) expect(result.control.unresolvedDeploymentAdjustment).toBeUndefined();
    },
  );

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

  it("retains unresolved evidence and prices a measured subthreshold deployment proportionally", () => {
    const zero = evaluate(0);
    const share = threshold / 4;
    const { facts, result } = evaluate(share);
    const control = facts.controls.find((row) => row.deploymentKey.startsWith("polygon:"))!;
    expect(control.status.observationState).toBe("bounded-unknown");
    expect(result.scoreInput.pillars.control.score).toBeCloseTo(
      zero.result.scoreInput.pillars.control.score! -
      Math.max(0, zero.result.control.score! - V9_CANDIDATE_POLICY_V1.policy.semantic.control.boundedUnknownQuality) * share,
    );
    expect(result.trace.unresolvedFacts).toContainEqual(expect.objectContaining({ code: "unresolved-control-identity", sourceGapId: control.status.gapIds[0] }));
    expect(result.trace.caps.map((cap) => cap.kind)).not.toContain("reason:unresolved-control-identity");
    expect(result.trace.caps.map((cap) => cap.kind)).not.toContain("reason:runtime-bridge-materiality-unavailable");
    const card = projectSafetyScoreV9Card({
      ...result,
      policy: V9_CANDIDATE_POLICY_V1,
      display: { exitHolderEligibility: Object.fromEntries(result.exit.routes.map((route) => [route.routeKey, "any-holder" as const])) },
    }).card;
    expect(card.breakdowns?.control.adjustments).toContainEqual({
      kind: "unresolved-deployment-share",
      scoreBefore: result.control.score,
      scoreAfter: result.control.unresolvedDeploymentAdjustment!.scoreAfter,
      delta: result.control.unresolvedDeploymentAdjustment!.scoreAfter - result.control.score!,
    });
  });

  it.each([
    [2, threshold * 0.4, false],
    [2, threshold * 0.5, false],
    [4, threshold * 0.3, false],
    [1, threshold + 0.02, false],
    [3, fullCeiling / 3, true],
  ] as const)("prices an aggregate of %s unresolved deployments at share %s without a missing-data cap", (count, share, material) => {
    const { result } = evaluate(share, (asset) => {
      const template = asset.controls.find((control) => control.deploymentKey.startsWith("polygon:"))!;
      const templateGap = asset.gaps.find((gap) => gap.gapId === template.status.gapIds[0])!;
      const chains = ["base", "polygon", "optimism", "arbitrum"].slice(0, count);
      asset.controls = chains.map((chain) => {
        const controlKey = `cohort:${chain}`;
        const deploymentKey = `${chain}:0x3333333333333333333333333333333333333333`;
        const gapId = `alpha:gap:deployment-control:${controlKey}`;
        asset.gaps.push({
          ...templateGap,
          gapId,
          path: { kind: "deployment-control", deploymentKey, controlKey },
        });
        return {
          ...template,
          controlKey,
          deploymentKey,
          materialSupplyShare: share,
          status: { ...template.status, gapIds: [gapId] },
          failureDomains: [{ kind: "bridge-route" as const, key: deploymentKey }],
        };
      });
      const native = asset.supply.selectedBridgeRoutes.find((row) => row.reviewedRouteKind === "native")!;
      const nativeShare = 1 - count * share;
      asset.supply.selectedBridgeRoutes = [
        { ...native, supplyShare: nativeShare, supplyUsd: asset.supply.circulatingUsd! * nativeShare },
        ...asset.controls.map((control) => ({
          deploymentRouteKey: control.deploymentKey,
          supplyShare: share,
          supplyUsd: asset.supply.circulatingUsd! * share,
          reviewState: "selected-unresolved" as const,
        })),
      ];
      asset.supply.selectedRouteSupplyShare = nativeShare;
      asset.supply.unreviewedRouteSupplyShare = count * share;
      asset.supply.unknownRouteSupplyShare = 0;
      if (!asset.supply.chainDistribution) throw new Error("Expected an observed chain partition");
      asset.supply.chainDistribution.chains = [
        { chainId: "ethereum", supplyShare: nativeShare, supplyUsd: asset.supply.circulatingUsd! * nativeShare },
        ...chains.map((chainId) => ({ chainId, supplyShare: share, supplyUsd: asset.supply.circulatingUsd! * share })),
      ];
      // The whole inventory was replaced; no independent aggregate gap remains.
      asset.controlStatus = { ...asset.controlStatus, observationState: "known", gapIds: [] };
      asset.economicControlReview.bridge.status.observationState = "bounded-unknown";
      asset.economicControlReview.bridge.status.gapIds = asset.controls.flatMap((control) => control.status.gapIds);
      asset.economicControlReview.bridge.routes = asset.controls.map((control) => ({
        controlKey: control.controlKey,
        tier: "canonical-rollup-bridge",
      }));
    });
    expect(result.trace.caps.map((cap) => cap.kind)).not.toContain("reason:unresolved-control-identity");
    expect(result.trace.caps.map((cap) => cap.kind)).not.toContain("unresolved-deployment-share-band");
    if (material) {
      expect(result.scoreInput.pillars.control.evidenceLevel).toBe("limited");
    } else {
      expect(result.scoreInput.pillars.control.score).toBeCloseTo(
        result.control.score! - Math.max(0, result.control.score! - V9_CANDIDATE_POLICY_V1.policy.semantic.control.boundedUnknownQuality) * count * share,
      );
    }
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

  it("charges unknown and unreviewed residue as well as the joined unresolved deployment", () => {
    const joinedShare = blendStart / 4;
    const residueShare = blendStart / 4;
    const joined = evaluate(joinedShare);
    const { result } = evaluate(joinedShare, (asset) => {
      const native = asset.supply.selectedBridgeRoutes.find((row) => row.reviewedRouteKind === "native")!;
      native.supplyShare -= 2 * residueShare;
      native.supplyUsd = asset.supply.circulatingUsd! * native.supplyShare;
      asset.supply.selectedRouteSupplyShare! -= 2 * residueShare;
      asset.supply.unknownRouteSupplyShare = residueShare;
      asset.supply.unreviewedRouteSupplyShare = joinedShare + residueShare;
      const template = asset.controls.find((row) => row.deploymentKey.startsWith("polygon:"))!;
      const remainderControl = {
        ...template, controlKey: "bridge:reviewed-unreviewed-supply", deploymentKey: "base:unreviewed",
        status: { ...template.status, observationState: "known" as const, gapIds: [] },
        scope: "deployment" as const, economicLossScope: "deployment" as const, materialSupplyShare: residueShare,
        capSemantics: { kind: "bounded" as const, bound: { amount: residueShare, unit: "supply-fraction" as const } },
        claimImpairment: "bounded" as const, incidentState: "none" as const,
      };
      asset.controls.push(remainderControl);
      asset.economicControlReview.bridge.routes.push({
        controlKey: remainderControl.controlKey, tier: "canonical-rollup-bridge",
      });
      asset.supply.selectedBridgeRoutes.push(
        { deploymentRouteKey: "unknown-route:alpha", supplyShare: residueShare,
          supplyUsd: asset.supply.circulatingUsd! * residueShare, reviewState: "unmatched" },
        { deploymentRouteKey: "base:unreviewed", supplyShare: residueShare,
          supplyUsd: asset.supply.circulatingUsd! * residueShare, reviewState: "selected-unresolved" },
      );
      asset.supply.chainDistribution = null;
    });
    expect(result.scoreInput.pillars.control.score).toBeCloseTo(
      result.control.score! -
        Math.max(0, result.control.score! - V9_CANDIDATE_POLICY_V1.policy.semantic.control.boundedUnknownQuality) *
          (joined.result.control.unresolvedDeploymentShare! + 2 * residueShare),
    );
    expect(result.scoreInput.pillars.control.score).toBeLessThan(joined.result.scoreInput.pillars.control.score!);
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
      componentKey: "mint", posture: "unbounded-or-compromised", binding: false,
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
    expect(global.trace.caps).toContainEqual(expect.objectContaining({ kind: "signal:active-control-incident:critical" }));
  });
});
