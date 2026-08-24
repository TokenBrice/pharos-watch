import { SAFETY_SCORE_V9_EVALUATION_BUILD_DIGEST } from "../../data/safety-score-v9/evaluation-build-manifest-v1";
import type {
  CompiledV9FactSetV3,
  V9AssetFactsBase,
  V9AssetFactsV3,
  V9EvidenceResponsibility,
  V9FactStatusV2,
  V9FailureDomainRef,
} from "../../types/safety-score-v9-facts";
import type {
  V9Severity,
  V9StructuralSignal,
  V9ValidatedPolicyEnvelope,
} from "../../types/safety-score-v9";
import { resolveChainId } from "../chains";
import { clampShare } from "../math";
import { sha256Hex } from "../sha256";
import { stableJsonStringifyV1 } from "../stable-json";
import { isV9MaterialShare } from "./backing";
import { assertV9FactSetCompiledInProcess } from "./compile";
import {
  buildV9DependencyEvaluationPlan,
  distinctV9RootLiabilityIds,
  projectV9RoleDependencyPillarLimits,
  resolveV9DependencyInputs,
  type V9CommonModeMember,
  type V9DependencyEvaluationPlan,
  type V9DependencyPathPlan,
  type V9ResolvedDependencyInputs,
} from "./dependencies";
import {
  projectV9ExitEvaluationRoute,
  resolveV9DistinctExitCapacity,
  type V9ExitStressRequest,
} from "./exit";
import {
  deploymentExposureKey,
  deploymentRiskEventKey,
  evaluateV9Asset,
  projectV9EffectiveBackingPillarScore,
  projectV9ResolvedBackingExposure,
  resolveV9WrapperStrategyTier,
  upstreamExitAccessScore,
  upstreamOracleNavScore,
  type V9EvaluatedAsset,
  type V9WrapperStrategyTier,
} from "./evaluate-asset";
import {
  isV9RepresentationGroupRoute,
  isV9UncanonicalizedChainPoolRoute,
  readCompiledV9FactSetForEvaluation,
  type V9EvaluationFactSetRead,
} from "./facts";
import { assertV9ValidatedPolicyEnvelope } from "./policy";
import { compareText, deepFreeze, domainKey, uniqueSorted } from "./primitives";
import { projectV9DependencyScore } from "./score";
import { computeV9ResultDigest } from "./trace";

export {
  projectV9EffectiveBackingPillarScore,
  projectV9ResolvedBackingExposure,
  resolveV9WrapperStrategyTier,
};
export type { V9EvaluatedAsset, V9WrapperStrategyTier };

const V9_EVALUATED_SET_DIGEST_DOMAIN = "safety-score-v9.evaluated-set.v2";

export interface V9EvaluatedSet {
  schemaVersion: 1;
  factSetDigest: string;
  baseInputGenerationId: string;
  policyId: string;
  policyDigest: string;
  evaluationBuildDigest: string;
  asOfSec: number;
  sourceGenerations: Readonly<Record<string, string>>;
  dependencyPlan: Readonly<V9DependencyEvaluationPlan>;
  evaluationOrder: readonly string[];
  assets: readonly V9EvaluatedAsset[];
  scoreResultDigest: string;
  evaluatedSetDigest: string;
}

function marketRankByAsset(
  assets: readonly V9AssetFactsV3[],
  activeAssetIds: readonly string[],
): ReadonlyMap<string, number> {
  const active = new Set(activeAssetIds);
  const ranked = assets
    .filter(
      (asset) =>
        active.has(asset.assetId) &&
        asset.supply.status.observationState === "known" &&
        asset.supply.circulatingUsd !== null,
    )
    .map((asset) => ({
      assetId: asset.assetId,
      circulatingUsd: asset.supply.circulatingUsd!,
    }))
    .sort(
      (left, right) =>
        right.circulatingUsd - left.circulatingUsd ||
        compareText(left.assetId, right.assetId),
    );
  const result = new Map<string, number>();
  let previousSupply: number | null = null;
  let rank = 0;
  ranked.forEach((asset, index) => {
    if (previousSupply === null || asset.circulatingUsd !== previousSupply) {
      rank = index + 1;
      previousSupply = asset.circulatingUsd;
    }
    result.set(asset.assetId, rank);
  });
  return result;
}

function sourceGenerations(factSet: CompiledV9FactSetV3): Readonly<Record<string, string>> {
  return Object.fromEntries(
    Object.entries(factSet.sourceFingerprints)
      .sort(([left], [right]) => compareText(left, right))
      .map(([source, identity]) => [source, identity.generationId]),
  );
}

/** A reviewed bridge tier as carried by the fact set's bridge-route review. */
type V9BridgeRouteTier = V9AssetFactsBase["economicControlReview"]["bridge"]["routes"][number]["tier"];

export interface V9ConservativeShareBounds {
  lower: number;
  upper: number;
}

export interface V9BridgeDomainExposure {
  shareBounds: V9ConservativeShareBounds;
  reviewedTiers: readonly V9BridgeRouteTier[];
  reviewedTiersComplete: boolean;
}

/**
 * The per-asset evidence the common-mode grader keys severity off, by domain
 * kind. The dependency plan remains identity-only; DEX and bridge materiality is
 * derived here from the asset's exact fact set.
 */
export interface V9SupplyChainExposure {
  shareBySlug: ReadonlyMap<string, number>;
  unattributedShare: number;
  /**
   * Reviewed or conservatively pooled supply with no destination-chain split.
   * The legacy field name is retained for evaluator/test compatibility.
   */
  unmatchedChainLabelPoolShare: number;
  complete: boolean;
}
export interface V9CommonModeContext {
  supplyExposure: V9SupplyChainExposure;
  dexExposureByDomain: ReadonlyMap<string, V9ConservativeShareBounds>;
  bridgeExposureByDomain: ReadonlyMap<string, V9BridgeDomainExposure>;
}

export interface V9MintControlGroupIssuerFacts {
  controllerIssuerKey: string | null;
  members: readonly {
    assetId: string;
    pathKey: string;
    assetIssuerKey: string | null;
  }[];
}

/**
 * Reshape-v2 D2 (owner ruling 2026-07-21): a mint/upgrade-control domain whose
 * key is a tracked asset (`asset:<id>`) IS that asset acting as controller. For
 * a member whose serial-claim parent is exactly that asset the relationship is
 * definitional — the parent/wrapper cap already prices the inheritance — so the
 * shared-controller signal defers to it (diagnostic). Non-child members keep
 * the group severity; non-asset domains (safe/eoa/program keys) never match.
 */
export function v9ControlAssetDomainId(failureDomain: V9FailureDomainRef): string | null {
  return (failureDomain.kind === "mint-control" || failureDomain.kind === "upgrade-control") &&
    failureDomain.key.startsWith("asset:")
    ? failureDomain.key.slice("asset:".length)
    : null;
}

export function isV9ParentControlledCommonModeMember(
  assetId: string,
  controlAssetDomainId: string | null,
  serialPaths: readonly V9DependencyPathPlan[],
): boolean {
  return (
    controlAssetDomainId !== null &&
    serialPaths.some(
      (path) =>
        path.assetId === assetId && path.role === "serial-claim" && path.upstreamAssetId === controlAssetDomainId,
    )
  );
}

/**
 * A controller's native asset does not depend on products that reuse its
 * controller. Exact serial children also defer to their parent cap, while
 * unrelated products remain exposed to the shared controller.
 */
export function isV9ControllerOwnedCommonModeMember(
  assetId: string,
  controllerAssetId: string | null,
  serialPaths: readonly V9DependencyPathPlan[],
): boolean {
  return (
    controllerAssetId !== null &&
    (assetId === controllerAssetId ||
      isV9ParentControlledCommonModeMember(assetId, controllerAssetId, serialPaths))
  );
}

/** Same-issuer mint groups are diagnostic; every unresolved or crossed join fails closed. */
export function resolveV9MintControlGroupSeverity(group: V9MintControlGroupIssuerFacts): V9Severity {
  if (group.controllerIssuerKey === null || group.members.length === 0) return "high";
  return group.members.every(
    (member) => member.assetIssuerKey !== null && member.assetIssuerKey === group.controllerIssuerKey,
  )
    ? "low"
    : "high";
}

const SHARE_RECONCILIATION_TOLERANCE = 0.000001;

function boundedPooledChainShare(supply: V9AssetFactsBase["supply"]): number {
  return supply.selectedBridgeRoutes.reduce(
    (sum, route) =>
      sum +
      (isV9UncanonicalizedChainPoolRoute(route.deploymentRouteKey) ||
      isV9RepresentationGroupRoute(route.deploymentRouteKey)
        ? route.supplyShare
        : 0),
    0,
  );
}

function summarizeSupplyChainExposure(supply: V9AssetFactsBase["supply"]): V9SupplyChainExposure {
  const poolShare = boundedPooledChainShare(supply);
  if (!isKnownRequiredStatus(supply.status)) {
    return {
      shareBySlug: new Map<string, number>(),
      unattributedShare: 1,
      unmatchedChainLabelPoolShare: poolShare,
      complete: false,
    };
  }
  if (supply.chainDistribution === null || supply.chainDistribution === undefined) {
    return {
      shareBySlug: new Map<string, number>(),
      unattributedShare: 1,
      unmatchedChainLabelPoolShare: poolShare,
      complete: false,
    };
  }
  const shareBySlug = new Map<string, number>();
  for (const row of supply.chainDistribution.chains) {
    const chainId = resolveChainId(row.chainId) ?? row.chainId.toLowerCase();
    // Retained facts can contain pre-canonical aliases. Ambiguous rows must not
    // be merged silently because that could understate a material chain share.
    if (shareBySlug.has(chainId)) {
      return {
        shareBySlug: new Map<string, number>(),
        unattributedShare: 1,
        unmatchedChainLabelPoolShare: poolShare,
        complete: false,
      };
    }
    shareBySlug.set(chainId, row.supplyShare);
  }
  return {
    shareBySlug,
    unattributedShare: supply.chainDistribution.unattributedSupplyShare,
    unmatchedChainLabelPoolShare: poolShare,
    complete: true,
  };
}

function referenceExitRequest(envelope: V9ValidatedPolicyEnvelope): V9ExitStressRequest {
  const request = envelope.policy.semantic.exit.stressRequest;
  return {
    requestedNotionalUsd: request.referenceNotionalUsd,
    maxCostBps: request.maxCostBps,
    comparisonWindowSec: request.settlementHorizonSec,
    rawSupplyRequestUsd: request.referenceNotionalUsd,
  };
}

function summarizeDexDomainExposure(
  asset: V9AssetFactsBase,
  envelope: V9ValidatedPolicyEnvelope,
): ReadonlyMap<string, V9ConservativeShareBounds> {
  const request = referenceExitRequest(envelope);
  const dexRoutes = asset.exitRoutes.filter((route) => route.lane === "dex");
  const domains = uniqueSorted(
    dexRoutes
      .filter((route) => route.coverageClass !== "diagnostic")
      .flatMap((route) => route.failureDomains.filter((domain) => domain.kind === "dex-protocol").map(domainKey)),
  );
  return new Map(
    domains.map((key) => {
      const relevantRoutes = dexRoutes.filter(
        (route) =>
          route.coverageClass !== "diagnostic" && route.failureDomains.some((domain) => domainKey(domain) === key),
      );
      const projectedRoutes = relevantRoutes.map(projectV9ExitEvaluationRoute);
      const resolved = resolveV9DistinctExitCapacity(projectedRoutes, request, envelope);
      const lower = clampShare(
        Math.min(request.requestedNotionalUsd, resolved.valuedExecutableUsd) / request.requestedNotionalUsd,
      );
      const completeAndCurrent =
        asset.exitStatus.observationState === "known" &&
        relevantRoutes.length > 0 &&
        relevantRoutes.every((route) => {
          if (
            route.status.observationState !== "known" ||
            !route.scoreEligible ||
            route.coverageClass !== "exact-complete"
          ) {
            return false;
          }
          return resolved.includedRouteKeys.includes(route.routeKey);
        });
      return [key, { lower, upper: completeAndCurrent ? lower : 1 }] as const;
    }),
  );
}

function isKnownRequiredStatus(status: V9FactStatusV2): boolean {
  return status.applicability.state === "required" && status.observationState === "known";
}

export interface V9ControlDomainScopeAssessment {
  economicLossScope: "deployment" | "global-claim";
  deploymentKeys: readonly string[];
  materialShare: number | null;
}

/**
 * A shared mint/upgrade authority is deployment-scoped only when every local
 * member explicitly says that its reach is deployment-local and a complete
 * liability partition supplies the affected share. Any unresolved reach,
 * presentation-level deployment key, or incomplete partition remains a
 * whole-claim common mode.
 */
export function assessV9ControlDomainScope(
  failureDomain: V9FailureDomainRef,
  members: readonly V9CommonModeMember[],
  asset: V9AssetFactsBase | undefined,
  supplyExposure: V9SupplyChainExposure,
): V9ControlDomainScopeAssessment {
  const globalClaim = (): V9ControlDomainScopeAssessment => ({
    economicLossScope: "global-claim",
    deploymentKeys: [],
    materialShare: null,
  });
  if (
    (failureDomain.kind !== "mint-control" && failureDomain.kind !== "upgrade-control") ||
    asset === undefined ||
    members.length === 0 ||
    !members.every((member) => member.owner === "control") ||
    !supplyExposure.complete ||
    supplyExposure.unattributedShare > SHARE_RECONCILIATION_TOLERANCE
  ) {
    return globalClaim();
  }

  const shareByDeployment = new Map<string, number>();
  for (const member of members) {
    const control = asset.controls.find((candidate) => candidate.controlKey === member.pathKey);
    if (
      control === undefined ||
      !isKnownRequiredStatus(control.status) ||
      control.scope !== "deployment" ||
      control.economicLossScope !== "deployment" ||
      control.claimImpairment === "unknown" ||
      control.deploymentKey.startsWith("asset:")
    ) {
      return globalClaim();
    }
    const deploymentKey = control.deploymentKey;
    const separatorIndex = deploymentKey.indexOf(":");
    if (separatorIndex <= 0) return globalClaim();
    const chainKey = deploymentKey.slice(0, separatorIndex);
    const chainId = resolveChainId(chainKey) ?? chainKey.toLowerCase();
    const materialShare = control.materialSupplyShare ?? supplyExposure.shareBySlug.get(chainId) ?? null;
    if (materialShare === null) return globalClaim();
    const previous = shareByDeployment.get(deploymentKey);
    if (previous !== undefined && !sharesReconcile(previous, materialShare)) return globalClaim();
    shareByDeployment.set(deploymentKey, materialShare);
  }

  const materialShare = [...shareByDeployment.values()].reduce((sum, share) => sum + share, 0);
  if (materialShare > 1 + SHARE_RECONCILIATION_TOLERANCE) return globalClaim();
  return {
    economicLossScope: "deployment",
    deploymentKeys: [...shareByDeployment.keys()].sort(compareText),
    materialShare: clampShare(materialShare),
  };
}

function commonModeMemberStatus(
  member: V9CommonModeMember,
  assetsById: ReadonlyMap<string, V9AssetFactsV3>,
): V9FactStatusV2 | null {
  const asset = assetsById.get(member.assetId);
  if (!asset) return null;
  if (member.owner === "backing") {
    const exposure = asset.reserveExposures.find((candidate) => candidate.exposureKey === member.pathKey);
    return exposure?.status ?? null;
  }
  if (member.owner === "exit") {
    const route = asset.exitRoutes.find((candidate) => candidate.routeKey === member.pathKey);
    return route?.status ?? null;
  }
  if (member.owner === "control") {
    const control = asset.controls.find((candidate) => candidate.controlKey === member.pathKey);
    return control?.status ?? null;
  }
  if (member.owner === "dependency") {
    return (
      asset.dependencies.edges.some((edge) => edge.edgeKey === member.pathKey)
        ? asset.dependencies.status
        : null
    );
  }
  if (member.owner === "peg") return asset.peg.status;
  return asset.supply.status;
}

function isKnownCommonModeMember(
  member: V9CommonModeMember,
  assetsById: ReadonlyMap<string, V9AssetFactsV3>,
): boolean {
  const status = commonModeMemberStatus(member, assetsById);
  return status !== null && isKnownRequiredStatus(status);
}

function isBoundedUnknownCommonModeMember(
  member: V9CommonModeMember,
  assetsById: ReadonlyMap<string, V9AssetFactsV3>,
): boolean {
  const status = commonModeMemberStatus(member, assetsById);
  return status !== null &&
    status.applicability.state === "required" &&
    status.observationState === "bounded-unknown";
}

function sharesReconcile(left: number, right: number): boolean {
  return Math.abs(left - right) <= SHARE_RECONCILIATION_TOLERANCE;
}

function bridgeSupplyIsConsistent(supply: V9AssetFactsBase["supply"]): boolean {
  const circulatingUsd = supply.circulatingUsd;
  if (!isKnownRequiredStatus(supply.status) || circulatingUsd === null) return false;
  const { selectedRouteSupplyShare, unknownRouteSupplyShare, unreviewedRouteSupplyShare } = supply;
  if (selectedRouteSupplyShare === null || unknownRouteSupplyShare === null || unreviewedRouteSupplyShare === null) {
    return false;
  }
  const expectedTotalShare = circulatingUsd > 0 ? 1 : 0;
  if (
    !sharesReconcile(
      selectedRouteSupplyShare + unknownRouteSupplyShare + unreviewedRouteSupplyShare,
      expectedTotalShare,
    )
  ) {
    return false;
  }
  const reviewedRowShare = supply.selectedBridgeRoutes
    .filter((route) => route.reviewState === "selected-reviewed")
    .reduce((sum, route) => sum + route.supplyShare, 0);
  const unresolvedRowShare = supply.selectedBridgeRoutes
    .filter((route) => route.reviewState === "selected-unresolved")
    .reduce((sum, route) => sum + route.supplyShare, 0);
  const unmatchedRowShare = supply.selectedBridgeRoutes
    .filter((route) => route.reviewState === "unmatched")
    .reduce((sum, route) => sum + route.supplyShare, 0);
  const carriesExplicitUnmatchedRows = supply.selectedBridgeRoutes.some((route) => route.reviewState === "unmatched");
  if (
    !sharesReconcile(reviewedRowShare, selectedRouteSupplyShare) ||
    !sharesReconcile(unresolvedRowShare, unreviewedRouteSupplyShare) ||
    (carriesExplicitUnmatchedRows && !sharesReconcile(unmatchedRowShare, unknownRouteSupplyShare))
  ) {
    return false;
  }
  return supply.selectedBridgeRoutes.every((route) => {
    if (circulatingUsd === 0) {
      return route.supplyUsd <= 0.01 && route.supplyShare <= SHARE_RECONCILIATION_TOLERANCE;
    }
    return sharesReconcile(route.supplyUsd / circulatingUsd, route.supplyShare);
  });
}

function summarizeBridgeDomainExposure(
  asset: V9AssetFactsBase,
  representationGroupMaterialShareThreshold: number,
): ReadonlyMap<string, V9BridgeDomainExposure> {
  const controlsByKey = new Map(asset.controls.map((control) => [control.controlKey, control]));
  const selectedByDeployment = new Map(
    asset.supply.selectedBridgeRoutes.map((route) => [route.deploymentRouteKey, route]),
  );
  const lowerByDomain = new Map<string, number>();
  const tiersByDomain = new Map<string, Set<V9BridgeRouteTier>>();
  const validJoinedDeployments = new Set<string>();
  const joinedDomainDeployments = new Set<string>();
  const unresolvedDomains = new Set<string>();
  const supplyBridgeDomainKeys: ReadonlySet<string> = new Set(
    asset.supply.failureDomains.filter((domain) => domain.kind === "bridge-route").map(domainKey),
  );
  const domainKeys = new Set(supplyBridgeDomainKeys);
  const bridgeReviewKnown = isKnownRequiredStatus(asset.economicControlReview.bridge.status);
  const supplyConsistent = bridgeSupplyIsConsistent(asset.supply);
  let unresolvedJoin = !bridgeReviewKnown || !supplyConsistent;

  for (const review of asset.economicControlReview.bridge.routes) {
    const control = controlsByKey.get(review.controlKey);
    if (!control) {
      unresolvedJoin = true;
      continue;
    }
    const bridgeDomains = control.failureDomains.filter((domain) => domain.kind === "bridge-route");
    if (bridgeDomains.length === 0) {
      unresolvedJoin = true;
      continue;
    }
    const selected = selectedByDeployment.get(control.deploymentKey);
    const boundedRepresentationGroupMechanism =
      isV9RepresentationGroupRoute(control.deploymentKey) &&
      control.status.applicability.state === "required" &&
      control.status.observationState === "bounded-unknown" &&
      control.authority?.model === "unknown" &&
      control.capSemantics.kind !== "unknown" &&
      control.claimImpairment !== "unknown" &&
      control.economicLossScope === "deployment" &&
      control.materialSupplyShare !== null &&
      control.materialSupplyShare <
        representationGroupMaterialShareThreshold;
    const validControl =
      (isKnownRequiredStatus(control.status) ||
        boundedRepresentationGroupMechanism) &&
      control.controlKind === "bridge" &&
      control.capabilities.includes("bridge-mint");
    const knownZeroExposure =
      bridgeReviewKnown &&
      supplyConsistent &&
      validControl &&
      selected === undefined &&
      control.materialSupplyShare === 0;
    const materialShareConsistent =
      selected !== undefined &&
      control.materialSupplyShare !== null &&
      sharesReconcile(control.materialSupplyShare, selected.supplyShare);
    const validJoin =
      bridgeReviewKnown &&
      supplyConsistent &&
      validControl &&
      selected?.reviewState === "selected-reviewed" &&
      materialShareConsistent;
    if (validJoin) validJoinedDeployments.add(control.deploymentKey);
    for (const domain of bridgeDomains) {
      const key = domainKey(domain);
      domainKeys.add(key);
      if (knownZeroExposure) continue;
      if (!validJoin) {
        unresolvedDomains.add(key);
        continue;
      }
      const tiers = tiersByDomain.get(key) ?? new Set<V9BridgeRouteTier>();
      tiers.add(review.tier);
      tiersByDomain.set(key, tiers);
      const joinedDomainDeployment = `${key}\u0000${control.deploymentKey}`;
      if (!joinedDomainDeployments.has(joinedDomainDeployment)) {
        lowerByDomain.set(key, (lowerByDomain.get(key) ?? 0) + selected.supplyShare);
        joinedDomainDeployments.add(joinedDomainDeployment);
      }
    }
  }

  for (const route of asset.supply.selectedBridgeRoutes) {
    if (
      route.reviewState !== "selected-reviewed" ||
      route.reviewedRouteKind === "native" ||
      validJoinedDeployments.has(route.deploymentRouteKey)
    ) {
      continue;
    }
    const attributableDomain = `bridge-route:${route.deploymentRouteKey}`;
    if (supplyBridgeDomainKeys.has(attributableDomain)) {
      unresolvedDomains.add(attributableDomain);
    } else {
      unresolvedJoin = true;
    }
  }
  const unresolvedShare = supplyConsistent
    ? clampShare(asset.supply.unreviewedRouteSupplyShare! + asset.supply.unknownRouteSupplyShare!)
    : 1;

  return new Map(
    [...domainKeys].sort(compareText).map((key) => {
      const lower = clampShare(lowerByDomain.get(key) ?? 0);
      const upper = unresolvedJoin || unresolvedDomains.has(key) ? 1 : clampShare(lower + unresolvedShare);
      return [
        key,
        {
          shareBounds: { lower, upper },
          reviewedTiers: [...(tiersByDomain.get(key) ?? [])].sort(compareText),
          reviewedTiersComplete: !unresolvedJoin && !unresolvedDomains.has(key),
        },
      ] as const;
    }),
  );
}

function buildCommonModeContext(
  asset: V9AssetFactsBase | undefined,
  envelope: V9ValidatedPolicyEnvelope,
): V9CommonModeContext {
  // A missing asset fact fails closed: no attributed share, no reviewed tiers.
  if (!asset) {
    return {
      supplyExposure: {
        shareBySlug: new Map<string, number>(),
        unattributedShare: 1,
        unmatchedChainLabelPoolShare: 0,
        complete: false,
      },
      dexExposureByDomain: new Map<string, V9ConservativeShareBounds>(),
      bridgeExposureByDomain: new Map<string, V9BridgeDomainExposure>(),
    };
  }
  return {
    supplyExposure: summarizeSupplyChainExposure(asset.supply),
    dexExposureByDomain: summarizeDexDomainExposure(asset, envelope),
    bridgeExposureByDomain: summarizeBridgeDomainExposure(
      asset,
      Math.min(
        envelope.policy.semantic.materiality
          .deploymentMaterialSharePct / 100,
        envelope.policy.semantic.materiality
          .commonModeShareThreshold,
      ),
    ),
  };
}

/**
 * Grades proportional common-mode domains from reviewed asset-local exposure.
 * Mature ecosystem domains are diagnostic; otherwise proven exposure below 10%
 * is diagnostic, 10%-<25% is moderate, and >=25% or unknown is high. Control
 * domains enter this path only after their deployment reach and complete
 * liability share are proved; unresolved control reach remains fail-closed.
 */
function venueFamilyKey(key: string): string {
  return key.toLowerCase().replace(/-v\d+$/u, "");
}

function proportionalCommonModeSeverity(
  share: number | null,
  mature: boolean,
  materiality: V9ValidatedPolicyEnvelope["policy"]["semantic"]["materiality"],
): V9Severity {
  if (mature) return "low";
  const high = materiality.commonModeSignal.severity;
  if (share === null) return high;
  if (!isV9MaterialShare(share, materiality.commonModeShareThreshold)) return "low";
  return isV9MaterialShare(share, materiality.commonModeHighShareThreshold) ? high : "moderate";
}

export function deploymentControlDomainSeverity(
  assessment: V9ControlDomainScopeAssessment,
  materiality: V9ValidatedPolicyEnvelope["policy"]["semantic"]["materiality"],
): V9Severity {
  if (assessment.economicLossScope !== "deployment" || assessment.materialShare === null) {
    return materiality.commonModeSignal.severity;
  }
  return proportionalCommonModeSeverity(assessment.materialShare, false, materiality);
}

interface V9CommonModeShareInfo {
  share: number | null;
  mature: boolean;
}

// Factored out of commonModeSignalSeverity so the reason-text builder in
// commonModeSignalsByAsset can render the same measured share it graded
// against, instead of re-deriving it. Returns null for domain kinds that
// carry no proportional share (reserve-issuer and the fail-closed defaults).
function commonModeShareForDomain(
  failureDomain: V9FailureDomainRef,
  context: V9CommonModeContext,
  materiality: V9ValidatedPolicyEnvelope["policy"]["semantic"]["materiality"],
): V9CommonModeShareInfo | null {
  switch (failureDomain.kind) {
    case "chain": {
      const chainId = resolveChainId(failureDomain.key) ?? failureDomain.key.toLowerCase();
      // A pooled destination distribution below the common-mode floor is
      // bounded by its exact aggregate share. This covers both unresolved raw
      // provider labels and reviewed representation groups; at or above the
      // floor the full unattributed share remains fail-closed.
      const poolShare = context.supplyExposure.unmatchedChainLabelPoolShare;
      const unattributedAddon =
        poolShare < materiality.commonModeShareThreshold
          ? clampShare(context.supplyExposure.unattributedShare - poolShare)
          : context.supplyExposure.unattributedShare;
      const share = context.supplyExposure.complete
        ? clampShare((context.supplyExposure.shareBySlug.get(chainId) ?? 0) + unattributedAddon)
        : null;
      return { share, mature: materiality.matureChains.includes(chainId) };
    }
    case "dex-protocol":
      return {
        share: context.dexExposureByDomain.get(domainKey(failureDomain))?.upper ?? null,
        // Measured-execution routes carry versioned protocol keys
        // ("uniswap-v3", "pancakeswap-v3"); venue maturity is a property of
        // the venue family, so membership is tested on the version-stripped
        // family key.
        mature: materiality.matureVenues.includes(venueFamilyKey(failureDomain.key)),
      };
    case "bridge-route": {
      const exposure = context.bridgeExposureByDomain.get(domainKey(failureDomain));
      return {
        share: exposure !== undefined && exposure.reviewedTiersComplete ? exposure.shareBounds.upper : null,
        mature: false,
      };
    }
    default:
      return null;
  }
}

export function commonModeSignalSeverity(
  failureDomain: V9FailureDomainRef,
  context: V9CommonModeContext,
  materiality: V9ValidatedPolicyEnvelope["policy"]["semantic"]["materiality"],
): V9Severity {
  if (failureDomain.kind === "reserve-issuer") {
    // Single-obligor exposure is already priced by backing concentration;
    // keep the signal diagnostic (non-capping) to avoid double-counting.
    return "low";
  }
  const shareInfo = commonModeShareForDomain(failureDomain, context, materiality);
  if (!shareInfo) return materiality.commonModeSignal.severity;
  return proportionalCommonModeSeverity(shareInfo.share, shareInfo.mature, materiality);
}

// Renders a materiality share as a percentage string for reason text, e.g.
// 0.1083 -> "10.8%", 0.25 -> "25%".
function formatCommonModeSharePct(share: number): string {
  const rounded = Math.round(share * 1000) / 10;
  return `${Number.isInteger(rounded) ? rounded.toFixed(0) : rounded.toFixed(1)}%`;
}

function commonModeEconomicScope(
  kind: V9FailureDomainRef["kind"],
): NonNullable<V9StructuralSignal["economicLossScope"]> {
  if (kind === "dex-protocol") return "access-only";
  if (kind === "chain" || kind === "bridge-route") return "deployment";
  if (kind === "reserve-issuer" || kind === "reserve-custodian") return "reserve-claim";
  return "global-claim";
}

function commonModeReasonQualifier(
  kind: V9FailureDomainRef["kind"],
  severity: V9Severity,
  materiality: V9ValidatedPolicyEnvelope["policy"]["semantic"]["materiality"],
  shareUnavailable: boolean,
): string {
  const lowPct = formatCommonModeSharePct(materiality.commonModeShareThreshold);
  const highPct = formatCommonModeSharePct(materiality.commonModeHighShareThreshold);
  if (kind === "chain") {
    if (severity === "low")
      return `reviewed mature chain or conservative exposure upper bound below ${lowPct}, diagnostic only`;
    if (severity === "moderate") return `conservative non-mature exposure upper bound from ${lowPct} to below ${highPct}`;
    // The unavailable disjunction only applies to the fail-closed case (no
    // reviewed chain inventory); a measured share at or above the high
    // threshold states its own bound instead of reusing that phrasing.
    return shareUnavailable
      ? "chain inventory unavailable, treated at the high-severity floor"
      : `conservative exposure upper bound at or above ${highPct}`;
  }
  if (kind === "dex-protocol") {
    if (severity === "low") return `reviewed mature venue or proven exposure below ${lowPct}, diagnostic only`;
    if (severity === "moderate") return `reviewed non-mature exposure from ${lowPct} to below ${highPct}`;
    return shareUnavailable ? "unknown venue concentration" : `exposure at or above ${highPct}`;
  }
  if (kind === "bridge-route") {
    if (severity === "low") return `proven exposure below ${lowPct}, diagnostic only`;
    if (severity === "moderate") return `reviewed exposure from ${lowPct} to below ${highPct}`;
    return shareUnavailable ? "unknown/unattributed bridge exposure" : `exposure at or above ${highPct}`;
  }
  if (kind === "reserve-issuer") {
    return "single-obligor exposure priced in backing, diagnostic only";
  }
  if (kind === "mint-control" || kind === "upgrade-control") {
    if (severity === "low") return `proven deployment exposure below ${lowPct}, diagnostic only`;
    if (severity === "moderate") return `proven deployment exposure from ${lowPct} to below ${highPct}`;
    return shareUnavailable ? "control reach or deployment exposure unresolved" : `deployment exposure at or above ${highPct}`;
  }
  return severity === "high" ? "shared critical control identity" : "diagnostic";
}

function commonModeSignalsByAsset(
  plan: V9DependencyEvaluationPlan,
  envelope: V9ValidatedPolicyEnvelope,
  assetsById: ReadonlyMap<string, V9AssetFactsV3>,
): ReadonlyMap<string, readonly V9StructuralSignal[]> {
  const materiality = envelope.policy.semantic.materiality;
  const contextByAsset = new Map<string, V9CommonModeContext>();
  const contextFor = (assetId: string): V9CommonModeContext => {
    const cached = contextByAsset.get(assetId);
    if (cached) return cached;
    const context = buildCommonModeContext(assetsById.get(assetId), envelope);
    contextByAsset.set(assetId, context);
    return context;
  };
  const roleScopedDependencyPaths = new Set(
    [...plan.exitPaths, ...plan.controlPaths, ...plan.oracleNavPaths].map(
      (path) => `${path.assetId}\u0000${path.edgeKey}`,
    ),
  );
  const signals = new Map<string, V9StructuralSignal[]>();
  for (const group of plan.commonModeGroups) {
    const unpricedMembers = group.members.filter(
      (member) =>
        member.owner !== "dependency" ||
        !roleScopedDependencyPaths.has(`${member.assetId}\u0000${member.pathKey}`),
    );
    const effectiveMembers =
      group.failureDomain.kind === "dex-protocol"
        ? unpricedMembers.filter((member) => {
            if (member.owner !== "exit") return false;
            const route = assetsById
              .get(member.assetId)
              ?.exitRoutes.find((candidate) => candidate.routeKey === member.pathKey);
            return (
              route?.lane === "dex" &&
              isKnownRequiredStatus(route.status) &&
              route.scoreEligible &&
              route.coverageClass !== "diagnostic" &&
              route.failureDomains.some((domain) => domainKey(domain) === domainKey(group.failureDomain))
            );
          })
        : unpricedMembers;
    const assetIds = uniqueSorted(effectiveMembers.map((member) => member.assetId));
    // Root-liability collapse is a control-census rule: a wrapper must not make
    // its own parent look like a second independent asset sharing one mint or
    // upgrade authority. Other common modes (DEX, bridge, chain, reserve,
    // oracle) count distinct affected assets/paths; collapsing them erased real
    // shared-resource signals and was broader than the approved methodology.
    const controlCensus =
      group.failureDomain.kind === "mint-control" ||
      group.failureDomain.kind === "upgrade-control";
    const censusAssetIds = controlCensus
      ? distinctV9RootLiabilityIds(assetIds, plan.serialPaths)
      : assetIds;
    if (
      censusAssetIds.length < materiality.commonControlMinAssets ||
      effectiveMembers.length < materiality.commonControlMinPaths
    ) {
      continue;
    }
    const key = domainKey(group.failureDomain);
    const mintControlAssessment = (() => {
      // D2 (mint-control) extended by D15 (2026-07-18) to upgrade-control:
      // an issuer's own controller shared across its own products is the
      // issuer itself, not an external dependency. Cross-issuer and
      // unresolved-identity groups still fail closed in
      // resolveV9MintControlGroupSeverity.
      if (group.failureDomain.kind !== "mint-control" && group.failureDomain.kind !== "upgrade-control") return null;
      const members = assetIds.map((assetId) => {
        const assetMembers = effectiveMembers.filter((member) => member.assetId === assetId);
        return {
          assetId,
          pathKey: assetMembers[0]?.pathKey ?? key,
          assetIssuerKey: assetsById.get(assetId)?.assetIssuerKey ?? null,
        };
      });
      let controllerAssetId: string | null = null;
      let controllerAttributionComplete = effectiveMembers.length > 0;
      for (const member of effectiveMembers) {
        const attributedControllerAssetId =
          member.owner === "control"
            ? (assetsById
                .get(member.assetId)
                ?.controls.find((control) => control.controlKey === member.pathKey)
                ?.controllerAssetId ?? null)
            : null;
        if (
          attributedControllerAssetId === null ||
          (controllerAssetId !== null && controllerAssetId !== attributedControllerAssetId)
        ) {
          controllerAttributionComplete = false;
          break;
        }
        controllerAssetId = attributedControllerAssetId;
      }
      // Attribution is usable only when every path names the same controller
      // owner. Retained facts without that field preserve the prior fail-closed
      // member-issuer proxy.
      if (!controllerAttributionComplete) controllerAssetId = null;
      const controllerIssuerKey =
        controllerAssetId === null
          ? (members[0]?.assetIssuerKey ?? null)
          : (assetsById.get(controllerAssetId)?.assetIssuerKey ?? null);
      return {
        controllerAssetId,
        severity: resolveV9MintControlGroupSeverity({
          controllerIssuerKey,
          members,
        }),
        identitiesKnown:
          controllerIssuerKey !== null &&
          members.every((member) => member.assetIssuerKey !== null),
      };
    })();
    const mintControlSeverity = mintControlAssessment?.severity ?? null;
    const boundedUnknownMemberCount = effectiveMembers.filter((member) =>
      isBoundedUnknownCommonModeMember(member, assetsById),
    ).length;
    const groupHasBoundedUnknownMember = boundedUnknownMemberCount > 0;
    const controlAssetDomainId = v9ControlAssetDomainId(group.failureDomain);
    for (const assetId of assetIds) {
      const ownMembers = effectiveMembers.filter((member) => member.assetId === assetId);
      const ownMemberFactsKnown = ownMembers.every((member) =>
        isKnownCommonModeMember(member, assetsById),
      );
      const ownMemberFactsReviewed = ownMembers.every(
        (member) =>
          isKnownCommonModeMember(member, assetsById) ||
          isBoundedUnknownCommonModeMember(member, assetsById),
      );
      const parentControlled = isV9ParentControlledCommonModeMember(assetId, controlAssetDomainId, plan.serialPaths);
      const controllerOwned = isV9ControllerOwnedCommonModeMember(
        assetId,
        mintControlAssessment?.controllerAssetId ?? null,
        plan.serialPaths,
      );
      const context = contextFor(assetId);
      const controlDomainScope = assessV9ControlDomainScope(
        group.failureDomain,
        ownMembers,
        assetsById.get(assetId),
        context.supplyExposure,
      );
      const localControlShare =
        controlDomainScope.economicLossScope === "deployment"
          ? controlDomainScope.materialShare
          : null;
      const sameIssuerControl = mintControlSeverity === "low";
      const severity = parentControlled || controllerOwned || sameIssuerControl
        ? "low"
        : localControlShare !== null
          ? deploymentControlDomainSeverity(controlDomainScope, materiality)
          : (mintControlSeverity ?? commonModeSignalSeverity(group.failureDomain, context, materiality));
      // Proportional chain, DEX, bridge, and proven deployment-local control
      // domains carry a per-asset measured share. All unresolved control scope
      // keeps the existing group-first, fail-closed phrasing below.
      const shareInfo =
        parentControlled || controllerOwned || sameIssuerControl
          ? null
          : localControlShare !== null
            ? { share: localControlShare, mature: false }
            : commonModeShareForDomain(group.failureDomain, context, materiality);
      const shareUnavailable = severity === "high" && shareInfo !== null && shareInfo.share === null;
      const qualifier = parentControlled || controllerOwned
        ? assetId === mintControlAssessment?.controllerAssetId
          ? "own controller, downstream reuse creates no reverse dependency, diagnostic only"
          : "own required parent's controller, priced by the parent cap, diagnostic only"
        : sameIssuerControl
          ? "same-issuer controller, diagnostic only"
          : localControlShare !== null
            ? commonModeReasonQualifier(group.failureDomain.kind, severity, materiality, false)
            : commonModeReasonQualifier(group.failureDomain.kind, severity, materiality, shareUnavailable);
      const groupClause = controlCensus
        ? `${effectiveMembers.length} reviewed paths across ${censusAssetIds.length} independent root liabilities share ${key}`
        : `${effectiveMembers.length} reviewed paths across ${censusAssetIds.length} assets share ${key}`;
      // Where the coin's own measured share drives the severity (moderate, or
      // high with a measured — not unavailable — share), lead the reason with
      // that share and demote the cross-asset group trigger to secondary
      // context; readers otherwise misread the group count as the driver.
      const ownShare = severity !== "low" && shareInfo !== null ? shareInfo.share : null;
      // Evidence ownership is local to the receiving asset. A reviewed
      // bounded-unknown member is still adverse — an unverified critical
      // control cannot make a shared failure domain safer — while a truly
      // missing/stale/unresolved member remains integration-owned.
      const responsibility: V9EvidenceResponsibility =
        shareInfo !== null
          ? shareInfo.share === null
            ? "integration-missing"
            : "measured-adverse"
          : ownMemberFactsReviewed &&
              (mintControlAssessment === null || mintControlAssessment.identitiesKnown)
            ? "measured-adverse"
            : "integration-missing";
      const memberQualityClause = groupHasBoundedUnknownMember
        ? `; ${boundedUnknownMemberCount} shared member${boundedUnknownMemberCount === 1 ? " is" : "s are"} bounded-unknown and remains adverse`
        : "";
      const reason =
        ownShare !== null
          ? `This asset's own reviewed share is ${formatCommonModeSharePct(ownShare)} at ${key}, ${qualifier} (also ${groupClause}${memberQualityClause}).`
          : `${groupClause}${memberQualityClause}, ${qualifier}.`;
      const defaultEconomicLossScope = commonModeEconomicScope(group.failureDomain.kind);
      const economicLossScope =
        controlDomainScope.economicLossScope === "deployment"
          ? "deployment"
          : defaultEconomicLossScope;
      const localDeploymentKeys = controlDomainScope.deploymentKeys;
      const signal: V9StructuralSignal = {
        ...materiality.commonModeSignal,
        severity,
        reason,
        ...(shareInfo?.share === null || shareInfo === null
          ? {}
          : { materialSharePct: shareInfo.share * 100 }),
        economicLossScope,
        ...(economicLossScope === "deployment"
          ? {
              exposureKey:
                localDeploymentKeys.length === 0
                  ? `common-mode-slice:${assetId}:${key}`
                  : deploymentExposureKey(localDeploymentKeys),
              riskEventKey: deploymentRiskEventKey("common-mode", [key]),
            }
          : {}),
        recoveryPath:
          group.failureDomain.kind === "dex-protocol"
            ? "market-substitution"
            : economicLossScope === "deployment"
              ? "deployment-migration"
              : group.failureDomain.kind === "reserve-issuer" || group.failureDomain.kind === "reserve-custodian"
                ? "unknown"
                : "issuer-remediation",
        expectedRecoverySec: null,
        lossAbsorptionPct: 0,
        responsibility,
        evidenceConfidence:
          responsibility === "measured-adverse" && ownMemberFactsKnown ? "high" : "low",
        failureDomainKeys: [key],
        evidence: [],
      };
      signals.set(assetId, [...(signals.get(assetId) ?? []), signal]);
    }
  }
  return new Map(
    [...signals].map(([assetId, assetSignals]) => [
      assetId,
      [...assetSignals].sort((left, right) =>
        compareText(left.failureDomainKeys[0] ?? "", right.failureDomainKeys[0] ?? ""),
      ),
    ]),
  );
}

function evaluatedSetDigestPayload(result: Omit<V9EvaluatedSet, "evaluatedSetDigest">) {
  return {
    schemaVersion: result.schemaVersion,
    factSetDigest: result.factSetDigest,
    baseInputGenerationId: result.baseInputGenerationId,
    policyId: result.policyId,
    policyDigest: result.policyDigest,
    evaluationBuildDigest: result.evaluationBuildDigest,
    asOfSec: result.asOfSec,
    sourceGenerations: result.sourceGenerations,
    dependencyPlanDigest: result.dependencyPlan.planDigest,
    evaluationOrder: result.evaluationOrder,
    scoreResultDigest: result.scoreResultDigest,
    assets: result.assets.map((asset) => ({
      compactTrace: asset.compactTrace,
      dependencyInputs: asset.dependencyInputs,
      access: asset.access,
      operationalResilience: asset.operationalResilience,
      wrapperParentLimit: asset.trace.wrapperParentLimit,
    })),
  };
}

function evaluateV9FactSetRead(
  factSetRead: V9EvaluationFactSetRead,
  envelope: V9ValidatedPolicyEnvelope,
): Readonly<V9EvaluatedSet> {
  assertV9ValidatedPolicyEnvelope(envelope);
  const factSet = factSetRead.factSet;
  const assetsById = new Map(factSet.assets.map((asset) => [asset.assetId, asset]));
  const marketRanks = marketRankByAsset(factSet.assets, factSet.activeAssetIds);
  const dependencyPlan = buildV9DependencyEvaluationPlan({
    activeAssetIds: factSet.activeAssetIds,
    assets: factSet.assets,
  });
  const commonSignals = commonModeSignalsByAsset(dependencyPlan, envelope, assetsById);
  const evaluatedById = new Map<string, V9EvaluatedAsset>();
  // Terminal unavailable-asset roots per evaluated asset, propagated in
  // topological order: an unavailable asset inherits the union of the roots of
  // its own unavailable upstreams, or is its own root when nothing upstream is
  // unavailable. Backing aggregates materiality by these roots (VER2-001).
  const unavailabilityRootsById = new Map<string, readonly string[]>();
  const identity = {
    factSetDigest: factSetRead.sourceFactSetDigest,
    baseInputGenerationId: factSet.baseInputGenerationId,
    evaluationBuildDigest: SAFETY_SCORE_V9_EVALUATION_BUILD_DIGEST,
    asOfSec: factSet.asOfSec,
    sourceGenerations: sourceGenerations(factSet),
  };

  for (const assetId of dependencyPlan.topologicalOrder) {
    const asset = assetsById.get(assetId);
    if (!asset) throw new Error(`Safety Score v9 dependency plan references missing asset ${assetId}`);
    const unresolved = resolveV9DependencyInputs(
      dependencyPlan,
      [...evaluatedById.values()].map((result) => ({
        assetId: result.assetId,
        score: projectV9DependencyScore(result.trace),
        backingScore: projectV9EffectiveBackingPillarScore(result),
        exitScore: result.scoreInput.pillars.exit.score,
        accessScore: upstreamExitAccessScore(result.exit),
        controlScore: result.scoreInput.pillars.control.score,
        oracleNavScore: upstreamOracleNavScore(result, envelope),
      })),
    ).find((candidate) => candidate.assetId === assetId);
    if (!unresolved) throw new Error(`Safety Score v9 dependency inputs are missing for ${assetId}`);
    const resolved: V9ResolvedDependencyInputs = {
      ...unresolved,
      rolePillarProjections: projectV9RoleDependencyPillarLimits(unresolved, {
        unresolvedMaterialityThreshold:
          envelope.policy.semantic.backing.structural.materialExposureShare,
      }),
    };

    const { evaluatedAsset, unavailabilityRoots } = evaluateV9Asset({
      asset,
      resolved,
      dependencyPlan,
      envelope,
      evaluatedById,
      unavailabilityRootsById,
      identity,
      marketRank: marketRanks.get(assetId) ?? null,
      dependencySignals: commonSignals.get(assetId) ?? [],
    });
    evaluatedById.set(assetId, evaluatedAsset);
    unavailabilityRootsById.set(assetId, unavailabilityRoots);
  }

  const assets = [...evaluatedById.values()].sort((left, right) => compareText(left.assetId, right.assetId));
  const core: Omit<V9EvaluatedSet, "evaluatedSetDigest"> = {
    schemaVersion: 1,
    factSetDigest: factSetRead.sourceFactSetDigest,
    baseInputGenerationId: factSet.baseInputGenerationId,
    policyId: envelope.policy.policyId,
    policyDigest: envelope.semanticDigest,
    evaluationBuildDigest: SAFETY_SCORE_V9_EVALUATION_BUILD_DIGEST,
    asOfSec: factSet.asOfSec,
    sourceGenerations: identity.sourceGenerations,
    dependencyPlan,
    evaluationOrder: dependencyPlan.topologicalOrder,
    assets,
    scoreResultDigest: computeV9ResultDigest(assets.map((asset) => asset.trace)),
  };
  const evaluatedSetDigest = sha256Hex(
    stableJsonStringifyV1({ domain: V9_EVALUATED_SET_DIGEST_DOMAIN, result: evaluatedSetDigestPayload(core) }),
  );
  return deepFreeze({ ...core, evaluatedSetDigest }) as Readonly<V9EvaluatedSet>;
}

/** Evaluate one untrusted compiled active-asset set after strict validation. */
export function evaluateV9FactSet(
  input: CompiledV9FactSetV3,
  envelope: V9ValidatedPolicyEnvelope,
): Readonly<V9EvaluatedSet> {
  return evaluateV9FactSetRead(readCompiledV9FactSetForEvaluation(input), envelope);
}

/**
 * Trusted same-process path for a V3 fact set just returned by
 * compileV9FactSetV3(). Stored, replayed, or otherwise external facts must use
 * evaluateV9FactSet() so their schema and digest are verified first.
 */
export function evaluateValidatedV9FactSet(
  factSet: CompiledV9FactSetV3,
  envelope: V9ValidatedPolicyEnvelope,
): Readonly<V9EvaluatedSet> {
  assertV9FactSetCompiledInProcess(factSet);
  return evaluateV9FactSetRead(
    {
      sourceSchemaVersion: 3,
      sourceFactSetDigest: factSet.v9FactSetDigest,
      factSet,
    },
    envelope,
  );
}
