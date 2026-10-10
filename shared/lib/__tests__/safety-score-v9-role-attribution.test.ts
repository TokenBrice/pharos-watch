import { describe, expect, it } from "vitest";
import type { V9AssetFactsV3 } from "../../types/safety-score-v9-facts";
import { CompiledV9FactSetV3Schema } from "../../types/safety-score-v9-facts";
import { compileV9FactSetV3 } from "../safety-score-v9/compile";
import { evaluateV9FactSet } from "../safety-score-v9/evaluate-set";
import type { V9DependencyEconomicRole } from "../safety-score-v9/dependencies";
import { V9_CANDIDATE_POLICY_V1 } from "../safety-score-v9/policy";
import { createV9EvidenceReference } from "../safety-score-v9/evidence";
import { accessReview, compileNativeV3FactSet, coreFixture, knownStatus, noEconomicControlReview } from "./safety-score-v9-facts.fixture-support";

function roleCohort(role: V9DependencyEconomicRole, nonBinding = false) {
  const { v9FactSetDigest: _digest, ...core } = CompiledV9FactSetV3Schema.parse(compileNativeV3FactSet(coreFixture()));
  const template = core.assets.find((asset) => asset.assetId === "alpha")!;
  const healthy = (assetId: string): V9AssetFactsV3 => {
    const asset = structuredClone(template);
    asset.assetId = assetId;
    asset.gaps = [];
    asset.dependencies = { ...asset.dependencies, source: "none", baseSource: "none", dependencyFromLive: false,
      sourceGenerationId: core.sourceFingerprints.researchOverlays.generationId,
      mappedLiveReserveWeight: null, edges: [] };
    asset.reserveExposures = asset.reserveExposures.map((row) => ({ ...row, trackedAssetId: null, assetClass: "cash",
      issuerOrObligorKey: `issuer:${assetId}`, riskFactors: [], liquidityHorizon: "immediate", maturityDaysMax: 0 }));
    asset.exitRoutes = asset.exitRoutes.filter((route) => route.scoreEligible);
    const review = noEconomicControlReview();
    asset.economicControlReview = {
      ...review,
      mint: { ...review.mint, supervision: "none", latestResolvedIncidentAtSec: null },
    };
    asset.accessReview = accessReview();
    asset.peg.pegScore = 100;
    return asset;
  };
  const root = healthy("root");
  const child = healthy("child");
  const grandchild = healthy("grandchild");
  const mint = (asset: V9AssetFactsV3) => {
    const control = structuredClone(template.controls.find((control) => control.controlKind === "mint")!);
    control.controlKey = `mint:${asset.assetId}`;
    control.capSemantics = { kind: "unbounded", bound: null };
    control.claimImpairment = "unbounded";
    control.authority = { authorityKey: `issuer:${asset.assetId}`, model: "eoa", threshold: null };
    asset.controls = [control];
    asset.economicControlReview.mint = { status: knownStatus(), controlKey: control.controlKey,
      reconciliation: "none", supervision: "none", latestResolvedIncidentAtSec: null,
      upgrade: { state: "not-applicable", controlKey: null } };
  };
  if (role === "exit-dependency") {
    // A measured exhausted route retains a known access score as well as
    // adverse Exit quality; an empty census has no route access to inherit.
    root.exitRoutes = root.exitRoutes.filter((route) => route.lane === "dex").map((route) => ({
      ...route,
      capacityCurve: route.capacityCurve.map((point) => ({
        ...point, executableUsd: 0, completionRatio: 0, executionCostBps: 0,
      })),
    }));
    if (nonBinding) { child.exitRoutes = []; child.exitStatus = knownStatus(); }
  } else if (role === "control-operator") {
    mint(root);
    if (nonBinding) mint(child);
  } else {
    const evidenceId = "evidence:root:oracle";
    // The admitted known tier itself supplies the measured structural signal;
    // no synthetic unresolved gap is needed to label the upstream oracle D.
    root.evidence.push(createV9EvidenceReference({ evidenceId, sourceId: "oracle-topology",
      sourceGenerationId: "oracle:review", disposition: "observed", observedAtSec: 900, maxAgeSec: 200 }, core.asOfSec));
    root.economicControlReview.oracle = { status: knownStatus(evidenceId), tier: "single-source-or-laggy",
      liquidationBranchesApplicable: false, branches: [], factorStatuses: { tier: knownStatus(evidenceId) } };
    if (nonBinding) mint(child);
  }
  for (const [dependent, upstream] of [[child, root], [grandchild, child]] as const) {
    dependent.dependencies.edges = [{ edgeKey: `${role}:mechanism:${upstream.assetId}`, upstreamAssetId: upstream.assetId,
      dependencyType: "mechanism", pathKind: "local-component", economicRole: role, weight: 1,
      evidenceRefIds: ["evidence:base"], failureDomains: [{ kind: "oracle-feed", key: `dependency:${upstream.assetId}` }] }];
    dependent.dependencies.source = "manual";
    dependent.dependencies.baseSource = "manual";
    dependent.dependencies.sourceGenerationId = core.sourceFingerprints.researchOverlays.generationId;
  }
  core.assets = [root, child, grandchild];
  for (const asset of core.assets) {
    asset.evidence = asset.evidence.filter((row) =>
      row.evidenceId !== "evidence:rejected-route" &&
      (row.evidenceId !== "evidence:route" || asset.exitRoutes.length > 0));
  }
  core.activeAssetIds = core.assets.map((asset) => asset.assetId);
  return evaluateV9FactSet(compileV9FactSetV3(core), V9_CANDIDATE_POLICY_V1);
}

describe("binding measured-adverse role attribution", () => {
  it.each(["exit-dependency", "control-operator", "oracle-nav"] as const)(
    "retains measured %s loss attribution and its second-hop cause in a compiled cohort", (role) => {
      const result = roleCohort(role);
      const pillar = role === "exit-dependency" ? "exit" : "control";
      for (const [id, upstream] of [["child", "root"], ["grandchild", "child"]] as const) {
        const asset = result.assets.find((asset) => asset.assetId === id)!;
        const event = asset.dependencyInputs.rolePillarProjections![pillar].events[0]!;
        expect(event).toMatchObject({ cause: "D", boundedUnknown: false, exposureShare: 1,
          upstreamAssetIds: [upstream], evidenceRefIds: ["evidence:base"] });
        expect(event.modeledLossPoints).toBeGreaterThan(0);
        const path = `pillar:${pillar}:dependency:${event.exposureKey}:${event.riskEventKey}`;
        expect(asset.scoreInput.pillars[pillar].adverseAttribution).toContainEqual(expect.objectContaining({
          source: "pillar-score", path, responsibility: "measured-adverse",
        }));
        expect(asset.trace.adverseAttribution).toContainEqual(expect.objectContaining({ path }));
        expect(asset.trace.ratingStatus).toBe("rated");
        expect(asset.trace.nrReasons.some((reason) => reason.code === "f-without-measured-adverse")).toBe(false);
        if (role === "exit-dependency") expect(asset.trace.finalGrade).toBe("F");
      }
    },
  );

  it.each(["exit-dependency", "control-operator", "oracle-nav"] as const)(
    "does not attribute a non-binding measured %s role limit", (role) => {
      const child = roleCohort(role, true).assets.find((asset) => asset.assetId === "child")!;
      const pillar = role === "exit-dependency" ? "exit" : "control";
      const projection = child.dependencyInputs.rolePillarProjections![pillar];
      expect(projection.events[0]).toMatchObject({ cause: "D", boundedUnknown: false });
      expect(projection.events[0]!.modeledLossPoints).toBeGreaterThan(0);
      expect(projection.limit).toBeGreaterThanOrEqual(child.scoreInput.pillars[pillar].score!);
      expect((child.scoreInput.pillars[pillar].adverseAttribution ?? []).some((item) => item.path.includes(":dependency:"))).toBe(false);
    },
  );
});
