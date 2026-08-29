import type { BridgeRouteRiskProfile } from "@shared/types/core";
import { safetyScoreV9TransferDeploymentKey } from "@shared/types/safety-score-v9-transfer-overlays";
import { resolveChainId } from "@shared/lib/chains";
import {
  V9_REPRESENTATION_GROUP_ROUTE_PREFIX,
  V9_UNCANONICALIZED_CHAIN_POOL_ROUTE_PREFIX,
} from "@shared/lib/safety-score-v9/facts";
import { V9_CANDIDATE_POLICY_V1 } from "@shared/lib/safety-score-v9/policy";
import { compareText } from "@shared/lib/safety-score-v9/primitives";
import { getCirculatingRaw } from "@shared/lib/supply";
import { CURATED_NATIVE_SINGLE_ROUTE_SUPPLY_ATTRIBUTION } from "./safety-score-v9-curated-single-route-supply";
import type { SafetyScoreV9FactSetExtensionV2 } from "./safety-score-v9-fact-set";
import type { V9ExtensionRegistryMeta } from "./safety-score-v9-extension-shared";
import type { SafetyScoreV9CompilerInput } from "./safety-score-v9-native-input";
import {
  safetyScoreV9ChainRows,
  safetyScoreV9SupplyAttributionExpectedAssetIds,
} from "./safety-score-v9-supply-attribution";
import { normalizeReviewedDeploymentAddress } from "./safety-score-v9-supply-attribution-contract";
import {
  exactInputBoundTransferMaterialityPacket,
  type SafetyScoreV9TransferMaterialityGeneration,
} from "./safety-score-v9-transfer-materiality";
import {
  XAUT0_ADAPTER_FAILURE_DOMAIN,
  XAUT0_COMMON_FAILURE_DOMAIN,
} from "./safety-score-v9-xaut-supply-attribution-contract";

type ExtensionAsset = SafetyScoreV9FactSetExtensionV2["assets"][number];
type SupplyReview = NonNullable<ExtensionAsset["supplyReview"]>;
const RAW_UNIT_SHARE_SCALE = 10n ** 18n;

export const SAFETY_SCORE_V9_INDEPENDENT_LIABILITY_SUPPLY_ASSET_IDS = Object.freeze([
  "sfrxusd-frax",
  "wsrusd-reservoir",
].sort(compareText));
const INDEPENDENT_LIABILITY_SUPPLY_ASSET_ID_SET = new Set(
  SAFETY_SCORE_V9_INDEPENDENT_LIABILITY_SUPPLY_ASSET_IDS,
);

export interface BuildSafetyScoreV9SupplyReviewOptions {
  meta?: V9ExtensionRegistryMeta;
  transferMaterialityGeneration?: SafetyScoreV9TransferMaterialityGeneration | null;
}

export type SafetyScoreV9NullSupplyReviewOutcomeState =
  | "missing-profile"
  | "ambiguous-route-join"
  | "stale-review"
  | "attribution-rpc-rejection";

export interface SafetyScoreV9NullSupplyReviewOutcome {
  state: SafetyScoreV9NullSupplyReviewOutcomeState;
  responsibility: "integration-missing" | "producer-failed";
  chainRowCount: number;
  canonicalizationFailureCount: number;
  reviewRouteCount: number;
  attributionRejectionCode: string | null;
}

const STALE_ATTRIBUTION_REJECTION_CODES = new Set([
  "safe-block-unavailable",
  "transparency-stale",
  "finalized-block-unavailable",
  "observation-stale",
]);
const INTEGRATION_ATTRIBUTION_REJECTION_CODES = new Set([
  "route-inventory-unavailable",
  "deployment-identity-unavailable",
  "deployment-identity-mismatch",
  "transparency-source-config-unavailable",
]);

/**
 * Projects the exact null-review cause into score-bearing generation metadata.
 * Missing/invalid bridge profiles and non-unique/canonicalization joins belong
 * to integration; stale runtime input and rejected/missing attribution packets
 * belong to the producer. No branch manufactures a route or a supply share.
 */
export function diagnoseSafetyScoreV9NullSupplyReviewOutcome(input: {
  fixedInput: Readonly<SafetyScoreV9CompilerInput>;
  assetId: string;
  bridgeObservationState: "missing" | "stale" | "bounded-unknown" | "known";
  reviewRouteCount: number;
  chainInputStale: boolean;
}): SafetyScoreV9NullSupplyReviewOutcome {
  const chainRows = safetyScoreV9ChainRows(input.fixedInput, input.assetId);
  const chainLabels = Object.keys(chainRows);
  const latestAttributionRecord = [
    ...(input.fixedInput.supplyAttributionJournalById?.[input.assetId] ?? []),
  ].sort((left, right) => right.completedAtSec - left.completedAtSec)[0];
  const attributionRejectionCode =
    latestAttributionRecord?.admissionCode !== "supply-attribution.admission.accepted"
      ? latestAttributionRecord?.rejectionCode ?? latestAttributionRecord?.admissionCode ?? null
      : null;
  const base = {
    chainRowCount: chainLabels.length,
    canonicalizationFailureCount: chainLabels.filter((chain) => resolveChainId(chain) === null).length,
    reviewRouteCount: input.reviewRouteCount,
    attributionRejectionCode,
  };

  if (input.bridgeObservationState === "missing") {
    return { state: "missing-profile", responsibility: "integration-missing", ...base };
  }
  if (
    input.chainInputStale ||
    input.bridgeObservationState === "stale" ||
    (attributionRejectionCode !== null && STALE_ATTRIBUTION_REJECTION_CODES.has(attributionRejectionCode))
  ) {
    return { state: "stale-review", responsibility: "producer-failed", ...base };
  }
  if (
    attributionRejectionCode !== null &&
    INTEGRATION_ATTRIBUTION_REJECTION_CODES.has(attributionRejectionCode)
  ) {
    return { state: "ambiguous-route-join", responsibility: "integration-missing", ...base };
  }
  const expectsRuntimeAttribution =
    safetyScoreV9SupplyAttributionExpectedAssetIds(input.fixedInput).includes(input.assetId) ||
    (SAFETY_SCORE_V9_INDEPENDENT_LIABILITY_SUPPLY_ASSET_IDS.includes(input.assetId) && chainLabels.length === 0);
  if (attributionRejectionCode !== null || expectsRuntimeAttribution) {
    return {
      state: "attribution-rpc-rejection",
      responsibility: "producer-failed",
      ...base,
      attributionRejectionCode: attributionRejectionCode ?? "generation-outcome-missing",
    };
  }
  return { state: "ambiguous-route-join", responsibility: "integration-missing", ...base };
}

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
  fixedInput: Readonly<SafetyScoreV9CompilerInput>,
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
  fixedInput: Readonly<SafetyScoreV9CompilerInput>,
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
 * Allocates aggregate USD over exact raw totalSupply() observations only for
 * the reviewed inventories whose routes are independent native-mint or direct
 * burn-mint liabilities. Lock-mint and wrapped representations are excluded:
 * their deployment totals can describe the same liability more than once.
 */
function buildIndependentLiabilitySupplyReview(
  fixedInput: Readonly<SafetyScoreV9CompilerInput>,
  assetId: string,
  profile: BridgeRouteRiskProfile | undefined,
  options: BuildSafetyScoreV9SupplyReviewOptions,
): SupplyReview | null {
  if (
    !INDEPENDENT_LIABILITY_SUPPLY_ASSET_ID_SET.has(assetId) ||
    !profile ||
    !options.meta ||
    Object.keys(safetyScoreV9ChainRows(fixedInput, assetId)).length > 0
  ) return null;

  const packet = exactInputBoundTransferMaterialityPacket({
    assetId,
    meta: options.meta,
    generation: options.transferMaterialityGeneration ?? null,
    registryFingerprint: fixedInput.registryFingerprint,
    baseInputGenerationId: fixedInput.baseInputGenerationId,
    clockSec: fixedInput.clockSec,
  });
  if (packet === null) return null;

  const routes = profile.routes ?? [];
  if (routes.length === 0 || routes.length !== packet.authoritativeDeploymentKeys.length) return null;
  const routeByDeploymentKey = new Map<string, (typeof routes)[number]>();
  for (const route of routes) {
    const chainId = resolveChainId(route.destinationChain);
    if (chainId === null || route.representationId !== undefined) return null;
    const deploymentKey = safetyScoreV9TransferDeploymentKey(
      chainId,
      normalizeReviewedDeploymentAddress(chainId, route.contractAddress),
    );
    const independentLiabilitySemantics =
      route.semantics === "native-mint"
        ? route.issuanceModel === "native-issuance" && route.routeClass === "native"
        : route.semantics === "burn-mint"
          ? route.issuanceModel === "bridge-representation" && route.routeClass !== "native"
          : false;
    if (
      route.id !== deploymentKey ||
      route.reviewDisposition !== "reviewed" ||
      !independentLiabilitySemantics ||
      routeByDeploymentKey.has(deploymentKey)
    ) return null;
    routeByDeploymentKey.set(deploymentKey, route);
  }
  if (
    packet.authoritativeDeploymentKeys.some((deploymentKey) => !routeByDeploymentKey.has(deploymentKey)) ||
    routeByDeploymentKey.size !== packet.authoritativeDeploymentKeys.length
  ) return null;

  const aggregateSupplyUsd = getCirculatingRaw(
    fixedInput.aggregateCirculatingById[assetId] ?? {},
  );
  if (!Number.isFinite(aggregateSupplyUsd) || aggregateSupplyUsd <= 0) return null;

  const maxDecimals = Math.max(...packet.observations.map((row) => row.decimals));
  const normalizedRawUnits = packet.observations.map(
    (row) => BigInt(row.rawTokenUnits) * 10n ** BigInt(maxDecimals - row.decimals),
  );
  const normalizedTotal = normalizedRawUnits.reduce((sum, value) => sum + value, 0n);
  if (normalizedTotal <= 0n) return null;
  let residualIndex = normalizedRawUnits.length - 1;
  while (residualIndex >= 0 && normalizedRawUnits[residualIndex] === 0n) residualIndex -= 1;
  if (residualIndex < 0) return null;

  let allocatedUsd = 0;
  const supplyUsdByIndex = normalizedRawUnits.map((rawUnits, index) => {
    if (index === residualIndex) return 0;
    const shareScaled = (rawUnits * RAW_UNIT_SHARE_SCALE) / normalizedTotal;
    const supplyUsd = aggregateSupplyUsd * (Number(shareScaled) / Number(RAW_UNIT_SHARE_SCALE));
    allocatedUsd += supplyUsd;
    return supplyUsd;
  });
  const residualUsd = aggregateSupplyUsd - allocatedUsd;
  const residualToleranceUsd = Math.max(0.000001, aggregateSupplyUsd * 1e-12);
  if (!Number.isFinite(residualUsd) || residualUsd < -residualToleranceUsd) return null;
  supplyUsdByIndex[residualIndex] = Math.max(0, residualUsd);

  const failureDomains: SupplyReview["failureDomains"] = [];
  const selectedBridgeRoutes = packet.observations.map((observation, index) => {
    const route = routeByDeploymentKey.get(observation.deploymentKey)!;
    for (const key of route.failureDomainKeys?.length ? route.failureDomainKeys : [route.id]) {
      failureDomains.push({ kind: "bridge-route", key });
    }
    const supplyUsd = supplyUsdByIndex[index]!;
    return {
      deploymentRouteKey: route.id,
      supplyUsd,
      supplyShare: supplyUsd / aggregateSupplyUsd,
      reviewState: "selected-reviewed" as const,
      reviewedRouteKind: route.semantics === "native-mint" ? ("native" as const) : ("controlled" as const),
    };
  });

  return {
    selectedBridgeRoutes,
    selectedRouteSupplyShare: 1,
    unknownRouteSupplyShare: 0,
    unreviewedRouteSupplyShare: 0,
    failureDomains: [...new Map(failureDomains.map((domain) => [`${domain.kind}:${domain.key}`, domain])).values()].sort(
      (left, right) => compareText(`${left.kind}:${left.key}`, `${right.kind}:${right.key}`),
    ),
  };
}

/**
 * Distributes the already-published aggregate USD onto the one curated
 * reviewed route of a native-gas asset with no per-chain supply observation.
 * Asserts no new supply number: the aggregate is admitted upstream and the
 * single-route reality is asserted by the reviewed bridge profile, so this
 * partition cannot restate supply or double count. Every gate is fail-closed;
 * see `CURATED_NATIVE_SINGLE_ROUTE_SUPPLY_ATTRIBUTION` for the entry contract.
 */
function buildCuratedNativeSingleRouteSupplyReview(
  fixedInput: Readonly<SafetyScoreV9CompilerInput>,
  assetId: string,
  profile: BridgeRouteRiskProfile | undefined,
): SupplyReview | null {
  const entry = CURATED_NATIVE_SINGLE_ROUTE_SUPPLY_ATTRIBUTION[assetId];
  if (entry === undefined || entry.assetId !== assetId || !profile) return null;

  const routes = profile.routes ?? [];
  if (routes.length !== 1) return null;
  const route = routes[0]!;
  if (route.id !== entry.routeId || route.reviewDisposition !== "reviewed") return null;

  // A real upstream per-chain partition always wins over this curated
  // attribution; the lane only fills the aggregate-only gap.
  if (Object.keys(safetyScoreV9ChainRows(fixedInput, assetId)).length > 0) return null;

  const aggregateSupplyUsd = getCirculatingRaw(
    fixedInput.aggregateCirculatingById[assetId] ?? {},
  );
  if (!Number.isFinite(aggregateSupplyUsd) || aggregateSupplyUsd <= 0) return null;

  const failureDomains: SupplyReview["failureDomains"] = (
    route.failureDomainKeys?.length ? route.failureDomainKeys : [route.id]
  ).map((key) => ({ kind: "bridge-route", key }));
  return {
    selectedBridgeRoutes: [{
      deploymentRouteKey: route.id,
      supplyUsd: aggregateSupplyUsd,
      supplyShare: 1,
      reviewState: "selected-reviewed",
      reviewedRouteKind:
        route.routeClass === "native" || route.issuanceModel === "native-issuance" ? "native" : "controlled",
    }],
    selectedRouteSupplyShare: 1,
    unknownRouteSupplyShare: 0,
    unreviewedRouteSupplyShare: 0,
    failureDomains: [...new Map(failureDomains.map((domain) => [`${domain.kind}:${domain.key}`, domain])).values()].sort(
      (left, right) => compareText(`${left.kind}:${left.key}`, `${right.kind}:${right.key}`),
    ),
  };
}

/**
 * Reconciles the exact captured per-chain circulating supply against the
 * reviewed bridge-route rows. Chains without a unique reviewed route row stay
 * in the unknown share instead of being attributed to any route.
 */
export function buildSafetyScoreV9SupplyReview(
  fixedInput: Readonly<SafetyScoreV9CompilerInput>,
  assetId: string,
  profile: BridgeRouteRiskProfile | undefined,
  options: BuildSafetyScoreV9SupplyReviewOptions = {},
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

  const independentLiabilityReview = buildIndependentLiabilitySupplyReview(
    fixedInput,
    assetId,
    profile,
    options,
  );
  if (independentLiabilityReview) return independentLiabilityReview;

  const curatedSingleRouteReview = buildCuratedNativeSingleRouteSupplyReview(
    fixedInput,
    assetId,
    profile,
  );
  if (curatedSingleRouteReview) return curatedSingleRouteReview;

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
