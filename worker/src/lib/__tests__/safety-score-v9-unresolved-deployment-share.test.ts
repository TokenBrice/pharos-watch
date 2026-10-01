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
  const facts = structuredClone(compileSafetyScoreV9FactSetFromFixedInput(fixture.fixed, fixture.extension));
  const mint = facts.assets[0]!.economicControlReview.mint;
  facts.assets[0]!.gaps = facts.assets[0]!.gaps.filter((gap) => !mint.status.gapIds.includes(gap.gapId));
  mint.status = {
    ...mint.status,
    applicability: { state: "not-applicable", policyRuleId: "v9.control.mint-review", gapId: null, rationale: "Reviewed immutable issuance fixture." },
    observationState: "known",
    evidenceRefIds: [...facts.assets[0]!.controlStatus.evidenceRefIds],
    gapIds: [],
  };
  mint.reconciliation = "not-applicable";
  mint.upgrade = { state: "immutable", controlKey: null };
  mutate?.(facts.assets[0]!);
  const digested = { ...facts, v9FactSetDigest: computeV9FactSetDigest(facts) };
  return { facts: digested.assets[0]!, result: evaluateV9FactSet(digested, V9_CANDIDATE_POLICY_V1).assets[0]! };
};

describe("unresolved deployment share pricing", () => {
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
    });
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
  ] as const)("prices or caps the aggregate of %s unresolved deployments at share %s", (count, share, material) => {
    const { result } = evaluate(share, (asset) => {
      const template = asset.controls.find((control) => control.deploymentKey.startsWith("polygon:"))!;
      const templateGap = asset.gaps.find((gap) => gap.gapId === template.status.gapIds[0])!;
      const oldGapIds = [
        ...asset.controlStatus.gapIds,
        ...asset.controls.flatMap((control) => control.status.gapIds),
        ...asset.economicControlReview.bridge.status.gapIds,
      ];
      asset.gaps = asset.gaps.filter((gap) => !oldGapIds.includes(gap.gapId));
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
    if (material) {
      expect(result.trace.caps).toContainEqual(expect.objectContaining({ limit: 55, source: "evidence" }));
      expect(result.trace.finalScore).toBeLessThanOrEqual(55);
      expect(result.control.unresolvedDeploymentAdjustment).toBeUndefined();
    } else {
      expect(result.scoreInput.pillars.control.score).toBeCloseTo(
        result.control.score! - Math.max(0, result.control.score! - V9_CANDIDATE_POLICY_V1.policy.semantic.control.boundedUnknownQuality) * count * share,
      );
      const cohortShare = count * share;
      const blend = (cohortShare - blendStart) / (fullCeiling - blendStart);
      const scale = 10 ** V9_CANDIDATE_POLICY_V1.policy.semantic.formula.scoreDecimals;
      const interpolatedLimit = Math.floor(
        (result.trace.preCapScore! - Math.max(0, result.trace.preCapScore! - 55) * blend) * scale,
      ) / scale;
      expect(result.trace.caps).toContainEqual(expect.objectContaining({
        kind: "unresolved-deployment-share-band", limit: interpolatedLimit, source: "evidence",
      }));
      expect(result.trace.caps.map((cap) => cap.kind)).not.toContain("reason:runtime-bridge-materiality-unavailable");
      expect(result.trace.caps.map((cap) => cap.kind)).not.toContain("reason:unresolved-control-identity");
    }
  });

  it.each(["unknown-share", "unadmitted-partition", "missing-row", "stale-control"] as const)(
    "does not waive the ceiling for %s even when other chain supply is known",
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
      expect(result.trace.caps).toContainEqual(expect.objectContaining({ kind: "reason:unresolved-control-identity", limit: 55 }));
    },
  );

  it.each([fullCeiling, fullCeiling + 0.01, null])("keeps the whole-coin ceiling for material or unknown share %s", (share) => {
    const { result } = evaluate(share);
    expect(result.scoreInput.pillars.control.reasons.map((reason) => reason.code)).toContain("unresolved-control-identity");
    expect(result.trace.caps).toContainEqual(expect.objectContaining({ kind: "reason:unresolved-control-identity", limit: 55 }));
    if (result.trace.finalScore === null) {
      expect(result.trace.finalGrade).toBe("NR");
      expect(result.trace.bindingCap).toBeNull();
    } else {
      expect(result.trace.finalScore).toBeLessThanOrEqual(55);
    }
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
      const gapIds = new Set(asset.controls.flatMap((row) => row.status.gapIds));
      asset.gaps = asset.gaps.filter((gap) => !gapIds.has(gap.gapId));
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
        reconciliation: "not-applicable", supervision: "unknown", upgrade: { state: "immutable", controlKey: null },
      };
      asset.economicControlReview.bridge = {
        ...asset.economicControlReview.bridge, status: { ...asset.economicControlReview.bridge.status,
          applicability: { state: "not-applicable", policyRuleId: "v9.control.bridge-review", gapId: null, rationale: "Native mint deployments." },
          observationState: "known", gapIds: [] }, routes: [],
      };
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
