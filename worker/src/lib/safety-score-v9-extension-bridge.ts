/**
 * Safety Score v9 bridge-review adapter. Extracted verbatim from
 * `safety-score-v9-extension.ts`; no behaviour change.
 */
import { resolveChainId } from "@shared/lib/chains";
import { V9_REVIEW_EVIDENCE_MAX_AGE_SEC } from "@shared/lib/safety-score-v9/evidence";
import { compareText, domainDigest } from "@shared/lib/safety-score-v9/primitives";
import type { V9FailureDomainRef } from "@shared/types/safety-score-v9-facts";
import type { BridgeRouteDeployment, BridgeRouteRiskProfile } from "@shared/types/core";
import {
  COMMON_MODE_MATERIAL_SHARE_THRESHOLD,
  DEPLOYMENT_MATERIAL_SHARE_THRESHOLD,
  confidenceForResearch,
  notApplicableStatus,
  requiredStatus,
  researchReviewObservationState,
  reviewedObservationState,
  type ControlOverlay,
  type ExtensionAsset,
  type ReviewEvidenceBuilder,
  type V9ExtensionRegistryMeta,
} from "./safety-score-v9-extension-shared";
import {
  safetyScoreV9RouteSupplyShare,
  V9_AMBIGUOUS_CHAIN_ROUTE_PREFIX,
  V9_REPRESENTATION_GROUP_ROUTE_PREFIX,
  V9_UNMATCHED_CHAIN_ROUTE_PREFIX,
  V9_UNCANONICALIZED_CHAIN_POOL_ROUTE_PREFIX,
} from "./safety-score-v9-extension-supply";

function bridgeControl(
  assetId: string,
  route: BridgeRouteDeployment,
  materialSupplyShare: number | null,
): ControlOverlay | null {
  if (route.routeClass === "native" || route.issuanceModel === "native-issuance") return null;
  const capabilities: ControlOverlay["capabilities"] =
    route.issuanceModel === "bridge-representation" || route.issuanceModel === "wrapped-representation"
      ? ["bridge-mint"]
      : [];
  const authorityKey = route.controllerAddress
    ? `${route.controllerChain}:${route.controllerAddress.toLowerCase()}`
    : (route.failureDomainKeys?.[0] ?? `bridge-route:${route.id}`);
  const mintsRepresentation = capabilities.includes("bridge-mint");
  const reviewed = route.reviewDisposition === "reviewed";
  return {
    controlKey: `bridge-meta:${assetId}:${domainDigest("safety-score-v9.bridge-control-key.v1", route.id).slice(0, 20)}`,
    deploymentKey: route.id,
    controlKind: "bridge",
    scope: "deployment",
    capabilities,
    capSemantics: !reviewed
      ? { kind: "unknown", bound: null }
      : mintsRepresentation
        ? { kind: "unbounded", bound: null }
        : { kind: "not-applicable", bound: null },
    claimImpairment: !reviewed ? "unknown" : mintsRepresentation ? "unbounded" : "bounded",
    economicLossScope: "deployment",
    authority: { authorityKey, model: route.controllerAddress ? "contract" : "unknown", threshold: null },
    delaySec: null,
    materialSupplyShare,
    // Bridge-route controls carry no reviewed key-custody or Safe-module facts;
    // the mint-authority review owns both vocabularies.
    keyCustody: "unknown",
    modulesOrGuards: "unknown",
    incidentState: reviewed ? "none" : "unknown",
    failureDomains: (route.failureDomainKeys?.length ? route.failureDomainKeys : [route.id])
      .map((key) => ({ kind: "bridge-route" as const, key }))
      .sort((left, right) => compareText(left.key, right.key)),
  };
}

function unmatchedBridgeControl(
  assetId: string,
  route: NonNullable<ExtensionAsset["supplyReview"]>["selectedBridgeRoutes"][number],
): ControlOverlay {
  return {
    controlKey: `bridge-supply:${assetId}:${domainDigest("safety-score-v9.unmatched-bridge-control-key.v1", route.deploymentRouteKey).slice(0, 20)}`,
    deploymentKey: route.deploymentRouteKey,
    controlKind: "bridge",
    scope: "deployment",
    capabilities: [],
    capSemantics: { kind: "unknown", bound: null },
    claimImpairment: "unknown",
    economicLossScope: "deployment",
    authority: {
      authorityKey: `bridge-route:${route.deploymentRouteKey}`,
      model: "unknown",
      threshold: null,
    },
    delaySec: null,
    materialSupplyShare: route.supplyShare,
    keyCustody: "unknown",
    modulesOrGuards: "unknown",
    incidentState: "unknown",
    failureDomains: [{ kind: "bridge-route", key: route.deploymentRouteKey }],
  };
}

function representationGroupId(
  assetId: string,
  deploymentRouteKey: string,
): string | null {
  const prefix = `${V9_REPRESENTATION_GROUP_ROUTE_PREFIX}${assetId}:`;
  return deploymentRouteKey.startsWith(prefix) &&
    deploymentRouteKey.length > prefix.length
    ? deploymentRouteKey.slice(prefix.length)
    : null;
}

function representationGroupBridgeControl(
  assetId: string,
  route: NonNullable<
    ExtensionAsset["supplyReview"]
  >["selectedBridgeRoutes"][number],
  failureDomains: readonly V9FailureDomainRef[],
): ControlOverlay {
  const reviewed = route.reviewState === "selected-reviewed";
  const authorityDomain =
    failureDomains.find(
      (domain) =>
        domain.kind === "bridge-route" &&
        domain.key.startsWith("contract:"),
    ) ?? failureDomains[0];
  return {
    controlKey: `bridge-group:${assetId}:${domainDigest(
      "safety-score-v9.representation-group-bridge-control-key.v1",
      route.deploymentRouteKey,
    ).slice(0, 20)}`,
    deploymentKey: route.deploymentRouteKey,
    controlKind: "bridge",
    scope: "deployment",
    capabilities: ["bridge-mint"],
    capSemantics: reviewed
      ? { kind: "unbounded", bound: null }
      : { kind: "unknown", bound: null },
    claimImpairment: reviewed ? "unbounded" : "unknown",
    economicLossScope: reviewed ? "deployment" : "unknown",
    authority: {
      authorityKey:
        authorityDomain?.key ??
        `bridge-route:${route.deploymentRouteKey}`,
      // The adapter contract is the observed common mechanism, not proof of
      // the heterogeneous destination mint authorities.
      model: "unknown",
      threshold: null,
    },
    delaySec: null,
    materialSupplyShare: route.supplyShare,
    keyCustody: "unknown",
    modulesOrGuards: "unknown",
    incidentState: reviewed ? "none" : "unknown",
    failureDomains: [...failureDomains].sort((left, right) =>
      compareText(`${left.kind}:${left.key}`, `${right.kind}:${right.key}`),
    ),
  };
}

function canonicalRouteChain(routeId: string): string | null {
  const separator = routeId.indexOf(":");
  return separator > 0 ? resolveChainId(routeId.slice(0, separator)) : null;
}

/**
 * Proves that every unresolved exact deployment is independently below the
 * deployment threshold. Shares are intentionally not summed: each row has a
 * distinct deployment-scoped failure domain. Uncanonicalized raw labels are
 * the exception and arrive as one conservative pooled row.
 */
function hasCompleteSubthresholdBridgeInventory(
  profileRoutes: readonly BridgeRouteDeployment[],
  controls: readonly ControlOverlay[],
  supplyReview: ExtensionAsset["supplyReview"],
): boolean {
  if (supplyReview === null || supplyReview.selectedBridgeRoutes.length === 0) return false;
  const rows = supplyReview.selectedBridgeRoutes;
  const totalRowShare = rows.reduce((sum, row) => sum + row.supplyShare, 0);
  const aggregateShare =
    supplyReview.selectedRouteSupplyShare +
    supplyReview.unreviewedRouteSupplyShare +
    supplyReview.unknownRouteSupplyShare;
  if (Math.abs(totalRowShare - 1) > 0.000001 || Math.abs(aggregateShare - 1) > 0.000001) return false;
  if (rows.some((row) => row.deploymentRouteKey.startsWith(V9_AMBIGUOUS_CHAIN_ROUTE_PREFIX))) return false;

  const controlCounts = new Map<string, number>();
  const controlsByDeployment = new Map<string, ControlOverlay>();
  for (const control of controls) {
    controlCounts.set(control.deploymentKey, (controlCounts.get(control.deploymentKey) ?? 0) + 1);
    controlsByDeployment.set(control.deploymentKey, control);
  }
  if ([...controlCounts.values()].some((count) => count !== 1)) return false;

  const exactRowsByDeployment = new Map(rows.map((row) => [row.deploymentRouteKey, row]));
  for (const row of rows) {
    if (
      row.deploymentRouteKey.startsWith(
        V9_REPRESENTATION_GROUP_ROUTE_PREFIX,
      )
    ) {
      const control = controlsByDeployment.get(row.deploymentRouteKey);
      if (
        row.reviewState !== "selected-reviewed" ||
        control === undefined ||
        control.scope !== "deployment" ||
        control.economicLossScope !== "deployment" ||
        control.materialSupplyShare === null ||
        Math.abs(control.materialSupplyShare - row.supplyShare) >
          0.000001 ||
        row.supplyShare >= DEPLOYMENT_MATERIAL_SHARE_THRESHOLD ||
        row.supplyShare >= COMMON_MODE_MATERIAL_SHARE_THRESHOLD
      ) {
        return false;
      }
      continue;
    }
    if (row.reviewState === "selected-reviewed") continue;
    // RULED D-J (2026-07-19): an unrecognized-chain-label pool below the
    // common-mode materiality floor is an accepted bounded row; the proof no
    // longer requires its joined subthreshold control. At or above the floor
    // the pool keeps the ordinary fail-closed join below.
    if (
      row.deploymentRouteKey.startsWith(V9_UNCANONICALIZED_CHAIN_POOL_ROUTE_PREFIX) &&
      row.supplyShare < COMMON_MODE_MATERIAL_SHARE_THRESHOLD
    ) {
      continue;
    }
    const control = controlsByDeployment.get(row.deploymentRouteKey);
    if (
      control === undefined ||
      control.scope !== "deployment" ||
      control.economicLossScope !== "deployment" ||
      control.materialSupplyShare === null ||
      Math.abs(control.materialSupplyShare - row.supplyShare) > 0.000001 ||
      control.materialSupplyShare >= DEPLOYMENT_MATERIAL_SHARE_THRESHOLD
    ) {
      return false;
    }
  }

  const presentCanonicalChains = new Set<string>();
  for (const row of rows) {
    if (row.deploymentRouteKey.startsWith(V9_UNMATCHED_CHAIN_ROUTE_PREFIX)) {
      const scopedKey = row.deploymentRouteKey.slice(V9_UNMATCHED_CHAIN_ROUTE_PREFIX.length);
      const separator = scopedKey.indexOf(":");
      if (separator <= 0) return false;
      presentCanonicalChains.add(scopedKey.slice(separator + 1));
      continue;
    }
    if (row.deploymentRouteKey.startsWith(V9_UNCANONICALIZED_CHAIN_POOL_ROUTE_PREFIX)) continue;
    if (row.deploymentRouteKey.startsWith(V9_REPRESENTATION_GROUP_ROUTE_PREFIX)) continue;
    const chain = canonicalRouteChain(row.deploymentRouteKey);
    if (chain !== null) presentCanonicalChains.add(chain);
  }

  for (const route of profileRoutes) {
    if (route.reviewDisposition === "reviewed") continue;
    if (exactRowsByDeployment.has(route.id)) continue;
    const chain = canonicalRouteChain(route.id);
    const control = controlsByDeployment.get(route.id);
    if (
      chain === null ||
      presentCanonicalChains.has(chain) ||
      control === undefined ||
      control.materialSupplyShare !== 0
    ) {
      return false;
    }
  }
  return true;
}

export function adaptBridgeReview(
  meta: V9ExtensionRegistryMeta,
  supplyReview: ExtensionAsset["supplyReview"],
  deployedChainCount: number,
  evidence: ReviewEvidenceBuilder,
  clockSec: number,
): {
  review: NonNullable<ExtensionAsset["economicControlReview"]>["bridge"];
  controls: ControlOverlay[];
} {
  const profile: BridgeRouteRiskProfile | undefined = meta.bridgeRouteRisk;
  if (!profile) {
    if (deployedChainCount <= 1) {
      return {
        review: {
          status: notApplicableStatus(
            "v9.control.bridge-review",
            "The exact captured supply is confined to one deployment; no bridge route carries the claim.",
            [],
          ),
          routes: [],
        },
        controls: [],
      };
    }
    return {
      review: {
        status: requiredStatus("v9.control.bridge-review", "missing", `bridge:${meta.id}`),
        routes: [],
      },
      controls: [],
    };
  }
  const confidence = confidenceForResearch(profile.confidence);
  const reviewStale = researchReviewObservationState(profile.reviewedAt, clockSec) === "stale";
  const evidenceKeys = evidence.add({
    // A stale review still evidences the bridge fact itself, but it cannot
    // carry known claims in the umbrella deployment-control inventory.
    componentKeys: reviewStale ? ["economic-control:bridge"] : ["economic-control:bridge", "control"],
    sourceId: "stablecoin-meta.bridge-route-risk",
    reviewedAt: profile.reviewedAt,
    confidence,
    sources: profile.sources,
    payload: profile,
    maxAgeSec: V9_REVIEW_EVIDENCE_MAX_AGE_SEC,
  });
  if (reviewStale) {
    return {
      review: {
        status: requiredStatus("v9.control.bridge-review", "stale", `bridge:${meta.id}`, evidenceKeys),
        routes: [],
      },
      controls: [],
    };
  }
  const profileRoutes = profile.routes ?? [];
  const reviewedRoutes = profileRoutes.filter((route) => route.reviewDisposition === "reviewed");
  const representationGroups = (
    supplyReview?.selectedBridgeRoutes ?? []
  ).flatMap((row) => {
    const representationId = representationGroupId(
      meta.id,
      row.deploymentRouteKey,
    );
    if (representationId === null) return [];
    const members = profileRoutes.filter(
      (route) => route.representationId === representationId,
    );
    const tiers = new Set(members.map((route) => route.riskTier));
    if (
      members.length === 0 ||
      tiers.size !== 1 ||
      members.some(
        (route) =>
          route.reviewDisposition !== "reviewed" ||
          route.routeClass === "native" ||
          route.issuanceModel !== "wrapped-representation" ||
          route.semantics !== "lock-mint",
      )
    ) {
      return [];
    }
    return [{
      control: representationGroupBridgeControl(
        meta.id,
        row,
        supplyReview?.failureDomains ?? [],
      ),
      routeIds: members.map((route) => route.id),
      tier: [...tiers][0]!,
    }];
  });
  const groupedRouteIds = new Set(
    representationGroups.flatMap((group) => group.routeIds),
  );
  // Keep every non-native route as a control fact so exact deployment shares
  // remain available even when the route review itself is unresolved.
  const profileControls = profileRoutes
    .filter((route) => !groupedRouteIds.has(route.id))
    .map((route) => bridgeControl(meta.id, route, safetyScoreV9RouteSupplyShare(supplyReview ?? null, route.id)))
    .filter((control): control is ControlOverlay => control !== null);
  // RULED D-J: a pooled uncanonicalized row below the common-mode floor is
  // accepted supply evidence, not an unresolved deployment-control identity.
  // At the floor it keeps the ordinary synthetic control and fails closed.
  const unmatchedControls = (supplyReview?.selectedBridgeRoutes ?? [])
    .filter(
      (route) =>
        route.reviewState === "unmatched" &&
        (!route.deploymentRouteKey.startsWith(V9_UNCANONICALIZED_CHAIN_POOL_ROUTE_PREFIX) ||
          route.supplyShare >= COMMON_MODE_MATERIAL_SHARE_THRESHOLD),
    )
    .map((route) => unmatchedBridgeControl(meta.id, route));
  const controls = [
    ...profileControls,
    ...representationGroups.map((group) => group.control),
    ...unmatchedControls,
  ].sort((left, right) => compareText(left.controlKey, right.controlKey));
  const controlsByDeployment = new Map(controls.map((control) => [control.deploymentKey, control]));
  const routes = [
    ...reviewedRoutes
      .filter((route) => !groupedRouteIds.has(route.id))
      .flatMap((route) => {
        const control = controlsByDeployment.get(route.id);
        return control ? [{ controlKey: control.controlKey, tier: route.riskTier }] : [];
      }),
    ...representationGroups.map((group) => ({
      controlKey: group.control.controlKey,
      tier: group.tier,
    })),
  ].sort((left, right) => compareText(left.controlKey, right.controlKey));
  const allMaterialRoutesReviewed = hasCompleteSubthresholdBridgeInventory(profileRoutes, controls, supplyReview);
  const hasToleratedUncanonicalizedPool = (supplyReview?.selectedBridgeRoutes ?? []).some(
    (route) =>
      route.reviewState === "unmatched" &&
      route.deploymentRouteKey.startsWith(V9_UNCANONICALIZED_CHAIN_POOL_ROUTE_PREFIX) &&
      route.supplyShare < COMMON_MODE_MATERIAL_SHARE_THRESHOLD,
  );
  const onlyZeroShareUnroutedControls =
    routes.length === 0 &&
    controls.length > 0 &&
    controls.every((control) => control.materialSupplyShare === 0);
  // An unresolved registry deployment can remain as a zero-share audit fact
  // while every selected supply route is reviewed native issuance. It does not
  // make the asset bridge-exposed or require a synthetic bridge route row.
  if (
    (controls.length === 0 && !hasToleratedUncanonicalizedPool) ||
    (allMaterialRoutesReviewed && onlyZeroShareUnroutedControls)
  ) {
    return {
      review: {
        status: notApplicableStatus(
          "v9.control.bridge-review",
          "Every reviewed deployment route is native issuance; no bridge control carries the claim.",
          evidenceKeys,
        ),
        routes: [],
      },
      controls,
    };
  }
  const state =
    allMaterialRoutesReviewed && reviewedObservationState(confidence) === "known" ? "known" : "bounded-unknown";
  return {
    review: {
      status: requiredStatus("v9.control.bridge-review", state, `bridge:${meta.id}`, evidenceKeys),
      routes,
    },
    controls,
  };
}
