import {
  AS_OF_SEC,
  SOURCE_FINGERPRINTS,
  coreFixture,
  createV9EvidenceReference,
  createV9FactGap,
  createV9FactStatus,
  requiredV9Applicability,
  type V9AssetFactsV2,
} from "./safety-score-v9-facts.fixture-support";

type Control = V9AssetFactsV2["controls"][number];

export function commonDomainFixture() {
  const input = coreFixture();
  const alpha = input.assets[0]! as unknown as V9AssetFactsV2;
  const delta = structuredClone(alpha);
  delta.assetId = "delta";
  input.activeAssetIds.push(delta.assetId);
  input.assets.push(delta as never);
  return { input, assets: [alpha, delta] };
}

export function bridgeControl(asset: V9AssetFactsV2, id: string, share: number | null, domain: string): Control {
  return {
    ...structuredClone(asset.controls.find((control) => control.controlKey === "control:minter")!),
    controlKey: `control:bridge-${id}`,
    deploymentKey: `bridge:${id}`,
    controlKind: "bridge",
    scope: "deployment",
    capabilities: ["bridge-mint"],
    materialSupplyShare: share,
    failureDomains: [{ kind: "bridge-route", key: domain }],
  };
}

export function bridgeSupplyRow(deploymentRouteKey: string, supplyShare: number, supplyUsd = 10_000_000 * supplyShare) {
  return { deploymentRouteKey, supplyUsd, supplyShare, reviewState: "selected-reviewed" as const };
}

export function staleBridgeStatus(
  asset: V9AssetFactsV2,
  kind: "control" | "review",
  path: Parameters<typeof createV9FactGap>[0]["path"],
  policyRuleId: string,
) {
  const identity = `stale-bridge-${kind}:${asset.assetId}`;
  const evidence = createV9EvidenceReference({
    evidenceId: `evidence:${identity}`,
    sourceId: `bridge-${kind}-source`,
    sourceGenerationId: SOURCE_FINGERPRINTS.researchOverlays.generationId,
    disposition: "published",
    observedAtSec: 600,
    publishedAtSec: 610,
    maxAgeSec: 100,
  }, AS_OF_SEC);
  const gap = createV9FactGap({
    gapId: `gap:${identity}`,
    reasonCode: "selected-bridge-route-unresolved",
    ownerDomain: "control",
    policyRuleId,
    observationState: "stale",
    path,
    message: `The bridge ${kind} is stale.`,
    evidenceRefIds: [evidence.evidenceId],
  });
  asset.evidence.push(evidence);
  asset.gaps.push(gap);
  return createV9FactStatus({
    applicability: requiredV9Applicability(policyRuleId),
    observationState: "stale",
    evidenceRefIds: [evidence.evidenceId],
    gapIds: [gap.gapId],
  });
}

export function unresolvedArchetype(asset: V9AssetFactsV2, gapId: string) {
  const gap = createV9FactGap({
    gapId,
    reasonCode: "missing-archetype",
    ownerDomain: "backing",
    policyRuleId: "backing.archetype.review",
    observationState: "missing",
    path: { kind: "local-component", componentKey: "mechanism-archetype" },
    message: "The mechanism archetype is unresolved.",
  });
  asset.archetype = "unresolved";
  asset.gaps = [gap];
  asset.mechanismRiskReview = {
    status: createV9FactStatus({
      applicability: requiredV9Applicability("backing.archetype.review"),
      observationState: "missing",
      gapIds: [gap.gapId],
    }),
    review: null,
  };
}

export function assuranceStatus(asset: V9AssetFactsV2, status: V9AssetFactsV2["reserveStatus"]) {
  const review = asset.mechanismRiskReview.review;
  if (review?.archetype !== "fiat-cash") throw new Error("Expected fiat fixture");
  review.assuranceAndReconciliation.status = status;
  return review.assuranceAndReconciliation;
}
