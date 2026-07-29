import type { BridgeRouteRiskProfile } from "@shared/types/core";
import { resolveChainId } from "@shared/lib/chains";
import {
  V9_REPRESENTATION_GROUP_ROUTE_PREFIX,
  V9_UNCANONICALIZED_CHAIN_POOL_ROUTE_PREFIX,
} from "@shared/lib/safety-score-v9/facts";
import { V9_CANDIDATE_POLICY_V1 } from "@shared/lib/safety-score-v9/policy";
import { compareText } from "@shared/lib/safety-score-v9/primitives";
import type { SafetyScoreV9FactSetExtensionV2 } from "./safety-score-v9-fact-set";
import type { ReportCardsFixedInput } from "./report-cards-fixed-input";
import { safetyScoreV9ChainRows } from "./safety-score-v9-supply-attribution";
import { normalizeReviewedDeploymentAddress } from "./safety-score-v9-supply-attribution-contract";
import {
  XAUT0_ADAPTER_FAILURE_DOMAIN,
  XAUT0_COMMON_FAILURE_DOMAIN,
} from "./safety-score-v9-xaut-supply-attribution-contract";

type ExtensionAsset = SafetyScoreV9FactSetExtensionV2["assets"][number];
type SupplyReview = NonNullable<ExtensionAsset["supplyReview"]>;

function canonicalChainKey(raw: string): string {
  return resolveChainId(raw) ?? raw.toLowerCase();
}

function routeChain(routeId: string): string | null {
  const separator = routeId.indexOf(":");
  return separator > 0 ? canonicalChainKey(routeId.slice(0, separator)) : null;
}

export const V9_UNMATCHED_CHAIN_ROUTE_PREFIX = "unmatched-chain:";
export const V9_AMBIGUOUS_CHAIN_ROUTE_PREFIX = "ambiguous-chain:";
export {
  V9_REPRESENTATION_GROUP_ROUTE_PREFIX,
  V9_UNCANONICALIZED_CHAIN_POOL_ROUTE_PREFIX,
};

const REPRESENTATION_GROUP_MATERIAL_SHARE_THRESHOLD = Math.min(
  V9_CANDIDATE_POLICY_V1.policy.semantic.materiality
    .deploymentMaterialSharePct / 100,
  V9_CANDIDATE_POLICY_V1.policy.semantic.materiality
    .commonModeShareThreshold,
);

function unmatchedRouteKey(assetId: string, chain: string, routeCount: number): string {
  return `${routeCount === 0 ? V9_UNMATCHED_CHAIN_ROUTE_PREFIX : V9_AMBIGUOUS_CHAIN_ROUTE_PREFIX}${assetId}:${canonicalChainKey(chain)}`;
}

function buildReviewedDeploymentSupplyReview(
  fixedInput: Readonly<ReportCardsFixedInput>,
  assetId: string,
  profile: BridgeRouteRiskProfile | undefined,
): SupplyReview | null {
  const attribution = fixedInput.safetyScoreV9SupplyAttributionById?.[assetId];
  if (attribution?.model !== "reviewed-deployment-unit-partition-v1" || !profile) return null;

  const routes = profile.routes ?? [];
  const deployments = attribution.deployments;
  if (routes.length !== deployments.length || deployments.length === 0) return null;
  if (new Set(deployments.map((deployment) => deployment.routeId)).size !== deployments.length) {
    return null;
  }

  const routeById = new Map(routes.map((route) => [route.id, route]));
  const totalUsd = deployments.reduce((sum, deployment) => sum + deployment.currentSupplyUsd, 0);
  if (totalUsd <= 0) return null;

  const selectedBridgeRoutes: SupplyReview["selectedBridgeRoutes"][number][] = [];
  const failureDomains: SupplyReview["failureDomains"][number][] = [];
  let reviewedSelectedUsd = 0;
  let unreviewedUsd = 0;
  for (const deployment of deployments) {
    const route = routeById.get(deployment.routeId);
    const routeContractAddress = route?.contractAddress ??
      (route?.id.includes(":") ? route.id.slice(route.id.indexOf(":") + 1) : undefined);
    if (
      !route ||
      routeContractAddress === undefined ||
      canonicalChainKey(route.destinationChain ?? route.id.slice(0, route.id.indexOf(":"))) !==
        canonicalChainKey(deployment.chainId) ||
      normalizeReviewedDeploymentAddress(deployment.chainId, routeContractAddress) !==
        normalizeReviewedDeploymentAddress(deployment.chainId, deployment.contractAddress)
    ) {
      return null;
    }

    const reviewed = route.reviewDisposition === "reviewed";
    if (reviewed) reviewedSelectedUsd += deployment.currentSupplyUsd;
    else unreviewedUsd += deployment.currentSupplyUsd;
    selectedBridgeRoutes.push(
      reviewed
        ? {
            deploymentRouteKey: route.id,
            supplyUsd: deployment.currentSupplyUsd,
            supplyShare: deployment.currentSupplyUsd / totalUsd,
            reviewState: "selected-reviewed",
            reviewedRouteKind:
              route.routeClass === "native" || route.issuanceModel === "native-issuance"
                ? "native"
                : "controlled",
          }
        : {
            deploymentRouteKey: route.id,
            supplyUsd: deployment.currentSupplyUsd,
            supplyShare: deployment.currentSupplyUsd / totalUsd,
            reviewState: "selected-unresolved",
          },
    );
    for (const key of route.failureDomainKeys?.length ? route.failureDomainKeys : [route.id]) {
      failureDomains.push({ kind: "bridge-route", key });
    }
  }

  return {
    selectedBridgeRoutes: selectedBridgeRoutes.sort((left, right) =>
      compareText(left.deploymentRouteKey, right.deploymentRouteKey),
    ),
    selectedRouteSupplyShare: Math.min(1, reviewedSelectedUsd / totalUsd),
    unknownRouteSupplyShare: 0,
    unreviewedRouteSupplyShare: Math.min(1, unreviewedUsd / totalUsd),
    failureDomains: [...new Map(failureDomains.map((domain) => [`${domain.kind}:${domain.key}`, domain])).values()].sort(
      (left, right) => compareText(`${left.kind}:${left.key}`, `${right.kind}:${right.key}`),
    ),
  };
}

function buildRepresentationGroupSupplyReview(
  fixedInput: Readonly<ReportCardsFixedInput>,
  assetId: string,
  profile: BridgeRouteRiskProfile | undefined,
): SupplyReview | null {
  const attribution =
    fixedInput.safetyScoreV9SupplyAttributionById?.[assetId];
  if (
    attribution?.model !== "canonical-lock-mint-group-partition-v2" ||
    attribution.assetId !== assetId ||
    !profile
  ) {
    return null;
  }
  const routes = profile.routes ?? [];
  const canonicalRoute = routes.find(
    (route) => route.id === attribution.canonical.routeId,
  );
  const groupedRoutes = routes
    .filter(
      (route) =>
        route.representationId ===
        attribution.representationGroup.representationId,
    )
    .sort((left, right) => compareText(left.id, right.id));
  const expectedRouteIds =
    attribution.representationGroup.routeIds;
  const commonFailureDomainKeys = groupedRoutes.length > 0
    ? groupedRoutes
        .slice(1)
        .reduce(
          (common, route) => {
            const routeDomains = new Set(route.failureDomainKeys ?? []);
            return common.filter((key) => routeDomains.has(key));
          },
          [...(groupedRoutes[0]!.failureDomainKeys ?? [])].sort(compareText),
        )
    : [];
  if (
    !canonicalRoute ||
    canonicalRoute.routeClass !== "native" ||
    canonicalRoute.issuanceModel !== "native-issuance" ||
    canonicalRoute.reviewDisposition !== "reviewed" ||
    groupedRoutes.length !== routes.length - 1 ||
    groupedRoutes.length !== expectedRouteIds.length ||
    groupedRoutes.some(
      (route, index) =>
        route.id !== expectedRouteIds[index] ||
        route.reviewDisposition !== "reviewed" ||
        route.riskTier !== attribution.representationGroup.riskTier ||
        route.routeClass === "native" ||
        route.issuanceModel !== "wrapped-representation" ||
        route.semantics !== "lock-mint",
    ) ||
    !commonFailureDomainKeys.includes(XAUT0_COMMON_FAILURE_DOMAIN) ||
    !attribution.representationGroup.failureDomainKeys.includes(
      XAUT0_ADAPTER_FAILURE_DOMAIN,
    ) ||
    commonFailureDomainKeys.some(
      (key) =>
        !attribution.representationGroup.failureDomainKeys.includes(key),
    )
  ) {
    return null;
  }

  const canonicalSupplyUsd = attribution.canonical.currentSupplyUsd;
  const groupSupplyUsd =
    attribution.representationGroup.currentSupplyUsd;
  const totalUsd = canonicalSupplyUsd + groupSupplyUsd;
  if (!Number.isFinite(totalUsd) || totalUsd <= 0) return null;
  const groupSupplyShare = groupSupplyUsd / totalUsd;
  const groupIsSubmaterial =
    groupSupplyShare < REPRESENTATION_GROUP_MATERIAL_SHARE_THRESHOLD;
  const selectedBridgeRoutes: SupplyReview["selectedBridgeRoutes"] = [{
    deploymentRouteKey: attribution.canonical.routeId,
    supplyUsd: canonicalSupplyUsd,
    supplyShare: canonicalSupplyUsd / totalUsd,
    reviewState: "selected-reviewed",
    reviewedRouteKind: "native",
  }];
  selectedBridgeRoutes.push(
    groupIsSubmaterial
      ? {
          deploymentRouteKey:
            attribution.representationGroup.deploymentRouteKey,
          supplyUsd: groupSupplyUsd,
          supplyShare: groupSupplyShare,
          reviewState: "selected-reviewed",
          reviewedRouteKind: "controlled",
        }
      : {
          deploymentRouteKey:
            attribution.representationGroup.deploymentRouteKey,
          supplyUsd: groupSupplyUsd,
          supplyShare: groupSupplyShare,
          reviewState: "selected-unresolved",
        },
  );
  selectedBridgeRoutes.sort((left, right) =>
    compareText(left.deploymentRouteKey, right.deploymentRouteKey),
  );
  return {
    selectedBridgeRoutes,
    selectedRouteSupplyShare: groupIsSubmaterial
      ? 1
      : canonicalSupplyUsd / totalUsd,
    unknownRouteSupplyShare: 0,
    unreviewedRouteSupplyShare: groupIsSubmaterial
      ? 0
      : groupSupplyShare,
    failureDomains:
      attribution.representationGroup.failureDomainKeys.map((key) => ({
        kind: "bridge-route",
        key,
      })),
  };
}

/**
 * Reconciles the exact captured per-chain circulating supply against the
 * reviewed bridge-route rows. Chains without a unique reviewed route row stay
 * in the unknown share instead of being attributed to any route.
 */
export function buildSafetyScoreV9SupplyReview(
  fixedInput: Readonly<ReportCardsFixedInput>,
  assetId: string,
  profile: BridgeRouteRiskProfile | undefined,
): SupplyReview | null {
  const representationGroupReview =
    buildRepresentationGroupSupplyReview(
      fixedInput,
      assetId,
      profile,
    );
  if (representationGroupReview) return representationGroupReview;
  if (
    fixedInput.safetyScoreV9SupplyAttributionById?.[assetId]?.model ===
    "canonical-lock-mint-group-partition-v2"
  ) {
    return null;
  }
  const reviewedDeploymentReview = buildReviewedDeploymentSupplyReview(
    fixedInput,
    assetId,
    profile,
  );
  if (reviewedDeploymentReview) return reviewedDeploymentReview;
  if (
    fixedInput.safetyScoreV9SupplyAttributionById?.[assetId]?.model ===
    "reviewed-deployment-unit-partition-v1"
  ) {
    return null;
  }

  const chainRows = safetyScoreV9ChainRows(fixedInput, assetId);
  const chains = Object.keys(chainRows).sort(compareText);
  const totalUsd = chains.reduce((sum, chain) => sum + chainRows[chain]!.current, 0);
  if (chains.length === 0 || totalUsd <= 0) return null;

  const routes = profile?.routes ?? [];
  if (chains.length > 1 && profile === undefined) return null;

  const routesByChain = new Map<string, typeof routes>();
  for (const route of routes) {
    const chain = routeChain(route.id);
    if (chain === null) continue;
    routesByChain.set(chain, [...(routesByChain.get(chain) ?? []), route]);
  }

  const supplyByChain = new Map<string, { sourceChain: string; supplyUsd: number }>();
  for (const chain of chains) {
    const key = canonicalChainKey(chain);
    const existing = supplyByChain.get(key);
    supplyByChain.set(key, {
      sourceChain: existing?.sourceChain ?? chain,
      supplyUsd: (existing?.supplyUsd ?? 0) + chainRows[chain]!.current,
    });
  }

  const selectedBridgeRoutes: SupplyReview["selectedBridgeRoutes"][number][] = [];
  let unknownUsd = 0;
  let uncanonicalizedUsd = 0;
  let unreviewedUsd = 0;
  const failureDomains: SupplyReview["failureDomains"][number][] = [];
  for (const [chain, { sourceChain, supplyUsd }] of [...supplyByChain.entries()].sort(([left], [right]) =>
    compareText(left, right),
  )) {
    if (resolveChainId(sourceChain) === null) {
      // Raw provider labels are exact supply observations but not canonical
      // chain identities. Pool them conservatively so aliases cannot each
      // receive an independent subthreshold exemption.
      unknownUsd += supplyUsd;
      uncanonicalizedUsd += supplyUsd;
      continue;
    }
    const chainRoutes = routesByChain.get(chain) ?? [];
    if (chainRoutes.length !== 1) {
      // Preserve each canonical exact deployment instead of collapsing
      // independent chains into one unknown remainder. Ambiguous profile
      // matches retain a separate fail-closed disposition.
      unknownUsd += supplyUsd;
      const deploymentRouteKey = unmatchedRouteKey(assetId, sourceChain, chainRoutes.length);
      selectedBridgeRoutes.push({
        deploymentRouteKey,
        supplyUsd,
        supplyShare: supplyUsd / totalUsd,
        reviewState: "unmatched",
      });
      failureDomains.push({ kind: "bridge-route", key: deploymentRouteKey });
      continue;
    }
    const route = chainRoutes[0]!;
    const reviewed = route.reviewDisposition === "reviewed";
    if (!reviewed) unreviewedUsd += supplyUsd;
    selectedBridgeRoutes.push(
      reviewed
        ? {
            deploymentRouteKey: route.id,
            supplyUsd,
            supplyShare: supplyUsd / totalUsd,
            reviewState: "selected-reviewed",
            reviewedRouteKind:
              route.routeClass === "native" || route.issuanceModel === "native-issuance" ? "native" : "controlled",
          }
        : {
            deploymentRouteKey: route.id,
            supplyUsd,
            supplyShare: supplyUsd / totalUsd,
            reviewState: "selected-unresolved",
          },
    );
    for (const key of route.failureDomainKeys?.length ? route.failureDomainKeys : [route.id]) {
      failureDomains.push({ kind: "bridge-route", key });
    }
  }
  if (uncanonicalizedUsd > 0) {
    const deploymentRouteKey = `${V9_UNCANONICALIZED_CHAIN_POOL_ROUTE_PREFIX}${assetId}`;
    selectedBridgeRoutes.push({
      deploymentRouteKey,
      supplyUsd: uncanonicalizedUsd,
      supplyShare: uncanonicalizedUsd / totalUsd,
      reviewState: "unmatched",
    });
    failureDomains.push({ kind: "bridge-route", key: deploymentRouteKey });
  }
  const reviewedSelectedUsd = selectedBridgeRoutes.reduce(
    (sum, route) => sum + (route.reviewState === "selected-reviewed" ? route.supplyUsd : 0),
    0,
  );
  return {
    selectedBridgeRoutes: selectedBridgeRoutes.sort((left, right) =>
      compareText(left.deploymentRouteKey, right.deploymentRouteKey),
    ),
    selectedRouteSupplyShare: Math.min(1, reviewedSelectedUsd / totalUsd),
    unknownRouteSupplyShare: Math.min(1, unknownUsd / totalUsd),
    unreviewedRouteSupplyShare: Math.min(1, unreviewedUsd / totalUsd),
    failureDomains: [...new Map(failureDomains.map((domain) => [`${domain.kind}:${domain.key}`, domain])).values()].sort(
      (left, right) => compareText(`${left.kind}:${left.key}`, `${right.kind}:${right.key}`),
    ),
  };
}

/** Supply share reconciled to one reviewed route row, for control materiality. */
export function safetyScoreV9RouteSupplyShare(review: SupplyReview | null, deploymentRouteKey: string): number | null {
  if (review === null) return null;
  const route = review.selectedBridgeRoutes.find((candidate) => candidate.deploymentRouteKey === deploymentRouteKey);
  return route?.supplyShare ?? 0;
}
