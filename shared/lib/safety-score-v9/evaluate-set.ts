import { SAFETY_SCORE_V9_EVALUATION_BUILD_DIGEST } from "../../data/safety-score-v9/evaluation-build-manifest-v1";
import type {
  CompiledV9FactSetV2,
  V9AssetFactsV2,
  V9FactStatusV2,
  V9FailureDomainRef,
} from "../../types/safety-score-v9-facts";
import type {
  V9EvidenceLevel,
  V9ReasonCode,
  V9Severity,
  V9StructuralSignal,
  V9ValidatedPolicyEnvelope,
} from "../../types/safety-score-v9";
import { resolveChainId } from "../chains";
import { sha256Hex } from "../sha256";
import { stableJsonStringifyV1 } from "../stable-json";
import { evaluateV9AccessPosture, type V9AccessPostureResult } from "./access-posture";
import {
  createUnavailableV9BackingResult,
  isV9MaterialShare,
  type V9BackingResult,
  type V9CdpLiquidationCapacitySelection,
  type V9ResolvedUpstreamExposure,
} from "./backing";
import { evaluateV9Backing } from "./archetypes";
import { selectV9CdpLiquidationCapacity } from "./archetypes/cdp";
import { evaluateV9EconomicControlAssetFacts, type V9EconomicControlResult } from "./control";
import {
  buildV9DependencyEvaluationPlan,
  resolveV9DependencyInputs,
  type V9DependencyEvaluationPlan,
  type V9ResolvedDependencyInputs,
} from "./dependencies";
import {
  evaluateV9ExitAssetFacts,
  projectV9ExitEvaluationRoute,
  resolveV9DistinctExitCapacity,
  type V9ExitEvaluationResult,
  type V9ExitStressRequest,
} from "./exit";
import { parseCompiledV9FactSetV2 } from "./facts";
import { assertV9ValidatedPolicyEnvelope, resolveV9ReasonPolicy } from "./policy";
import {
  scoreV9EvaluatedAsset,
  type V9PillarEvaluation,
  type V9PillarReason,
  type V9ProductionScoreInput,
  type V9ProductionScoreTrace,
} from "./score";
import { createV9PublicStressState, type V9PublicStressState } from "./stress";
import { computeV9ResultDigest, projectCompactV9ScoreTrace, type V9CompactScoreTrace } from "./trace";

const V9_EVALUATED_SET_DIGEST_DOMAIN = "safety-score-v9.evaluated-set.v1";

export interface V9EvaluatedAsset {
  assetId: string;
  backing: V9BackingResult;
  exit: V9ExitEvaluationResult;
  control: V9EconomicControlResult;
  access: V9AccessPostureResult;
  dependencyInputs: V9ResolvedDependencyInputs;
  scoreInput: V9ProductionScoreInput;
  trace: V9ProductionScoreTrace;
  compactTrace: V9CompactScoreTrace;
  stressState: V9PublicStressState;
  liquidationCapacitySelection?: V9CdpLiquidationCapacitySelection;
}

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

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function uniqueSorted<T extends string>(values: readonly T[]): T[] {
  return [...new Set(values)].sort(compareText);
}

function domainKey(domain: V9FailureDomainRef): string {
  return `${domain.kind}:${domain.key}`;
}

function canonicalDomains(domains: readonly V9FailureDomainRef[]): V9FailureDomainRef[] {
  return [...new Map(domains.map((domain) => [domainKey(domain), domain])).values()].sort((left, right) =>
    compareText(domainKey(left), domainKey(right)),
  );
}

function deepFreeze<T>(value: T): Readonly<T> {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function sourceGenerations(factSet: CompiledV9FactSetV2): Readonly<Record<string, string>> {
  return Object.fromEntries(
    Object.entries(factSet.sourceFingerprints)
      .sort(([left], [right]) => compareText(left, right))
      .map(([source, identity]) => [source, identity.generationId]),
  );
}

function pillarReason(
  envelope: V9ValidatedPolicyEnvelope,
  code: V9ReasonCode,
  path: string,
  message?: string,
): V9PillarReason {
  return {
    code,
    path,
    message: message ?? resolveV9ReasonPolicy(envelope, code).reason.publicLabel,
  };
}

function canonicalReasons(reasons: readonly V9PillarReason[]): V9PillarReason[] {
  return [
    ...new Map(reasons.map((reason) => [`${reason.code}\u0000${reason.path}\u0000${reason.message}`, reason])).values(),
  ].sort(
    (left, right) =>
      compareText(left.code, right.code) ||
      compareText(left.path, right.path) ||
      compareText(left.message, right.message),
  );
}

function structuralSignalFromBacking(reason: V9BackingResult["structuralReasons"][number]): V9StructuralSignal {
  return {
    kind: reason.kind,
    severity: reason.severity,
    reason: `${reason.kind} condition at ${reason.pathKey}.`,
    ...(reason.materialShare === null ? {} : { materialSharePct: reason.materialShare * 100 }),
    failureDomainKeys: reason.failureDomains.map(domainKey),
    evidence: [],
  };
}

function structuralSignalFromControl(
  failure: V9EconomicControlResult["structuralFailures"][number],
): V9StructuralSignal {
  return {
    kind: failure.kind,
    severity: failure.severity,
    reason: failure.reason,
    ...(failure.materialSharePct === null ? {} : { materialSharePct: failure.materialSharePct }),
    failureDomainKeys: failure.failureDomains.map(domainKey),
    evidence: [],
  };
}

function reasonClassifiedEvidenceLevel(
  score: number | null,
  reasonCodes: readonly V9ReasonCode[],
  envelope: V9ValidatedPolicyEnvelope,
  fallback: V9EvidenceLevel,
): V9EvidenceLevel {
  if (score === null) return "insufficient";
  const treatments = reasonCodes.map((code) => resolveV9ReasonPolicy(envelope, code).reason.defaultTreatment);
  if (treatments.includes("NR")) return "insufficient";
  if (treatments.includes("ceiling")) return "limited";
  return fallback;
}

function backingPillar(result: V9BackingResult, envelope: V9ValidatedPolicyEnvelope): V9PillarEvaluation {
  const reasons = canonicalReasons(
    result.unresolved.map((reason) => pillarReason(envelope, reason.code, `backing:${reason.pathKey}`)),
  );
  return {
    score: result.score,
    evidenceLevel: reasonClassifiedEvidenceLevel(
      result.score,
      result.unresolved.map((reason) => reason.code),
      envelope,
      "strong",
    ),
    reasons,
    structuralSignals: result.structuralReasons.map(structuralSignalFromBacking),
  };
}

function exitPillar(
  asset: V9AssetFactsV2,
  result: V9ExitEvaluationResult,
  envelope: V9ValidatedPolicyEnvelope,
): V9PillarEvaluation {
  const primary =
    result.primaryRouteKey === null
      ? null
      : (asset.exitRoutes.find((route) => route.routeKey === result.primaryRouteKey) ?? null);
  const primaryStrong =
    primary !== null &&
    primary.status.observationState === "known" &&
    primary.observationConfidence === "high" &&
    envelope.policy.semantic.exit.strongEvidenceKinds.includes(primary.evidenceKind);
  return {
    score: result.score,
    evidenceLevel: reasonClassifiedEvidenceLevel(
      result.score,
      result.reasons,
      envelope,
      primaryStrong ? "strong" : "adequate",
    ),
    reasons: canonicalReasons(result.reasons.map((code) => pillarReason(envelope, code, `exit:${code}`))),
    structuralSignals: [],
  };
}

function controlPillar(result: V9EconomicControlResult, envelope: V9ValidatedPolicyEnvelope): V9PillarEvaluation {
  return {
    score: result.score,
    evidenceLevel: reasonClassifiedEvidenceLevel(
      result.score,
      result.reasons.map((reason) => reason.code),
      envelope,
      "strong",
    ),
    reasons: canonicalReasons(
      result.reasons.map((reason) => ({ code: reason.code, path: `control:${reason.path}`, message: reason.label })),
    ),
    structuralSignals: result.structuralFailures.filter((failure) => failure.binding).map(structuralSignalFromControl),
  };
}

function worstEvidenceLevel(
  pillars: V9ProductionScoreInput["pillars"],
  envelope: V9ValidatedPolicyEnvelope,
): V9EvidenceLevel {
  const rank = envelope.policy.semantic.evidence.rank;
  return [pillars.backing.evidenceLevel, pillars.exit.evidenceLevel, pillars.control.evidenceLevel].sort(
    (left, right) => rank[right] - rank[left],
  )[0]!;
}

function conservativeTrackRecordMonths(launchedAtSec: number | null, asOfSec: number): number {
  if (launchedAtSec === null) return 0;
  const start = new Date(launchedAtSec * 1_000);
  const end = new Date(asOfSec * 1_000);
  let months = (end.getUTCFullYear() - start.getUTCFullYear()) * 12 + end.getUTCMonth() - start.getUTCMonth();
  if (end.getUTCDate() < start.getUTCDate()) months -= 1;
  return Math.max(0, months);
}

function gapReasonsForStatus(
  asset: V9AssetFactsV2,
  status: V9FactStatusV2,
  envelope: V9ValidatedPolicyEnvelope,
  path: string,
  fallback: V9ReasonCode,
): V9PillarReason[] {
  const reasons = status.gapIds.flatMap((gapId) => {
    const gap = asset.gaps.find((candidate) => candidate.gapId === gapId);
    return gap ? [pillarReason(envelope, gap.reasonCode, path, gap.message)] : [];
  });
  return reasons.length > 0 ? reasons : [pillarReason(envelope, fallback, path)];
}

/** A reviewed bridge tier as carried by the fact set's bridge-route review. */
type V9BridgeRouteTier = V9AssetFactsV2["economicControlReview"]["bridge"]["routes"][number]["tier"];

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

/** Same-issuer mint groups are diagnostic; every unresolved or crossed join fails closed. */
export function resolveV9MintControlGroupSeverity(group: V9MintControlGroupIssuerFacts): V9Severity {
  if (group.controllerIssuerKey === null || group.members.length === 0) return "high";
  return group.members.every(
    (member) => member.assetIssuerKey !== null && member.assetIssuerKey === group.controllerIssuerKey,
  )
    ? "low"
    : "high";
}

const SUPPLY_USD_RECONCILIATION_TOLERANCE = 0.01;
const SHARE_RECONCILIATION_TOLERANCE = 0.000001;

function clampShare(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function summarizeSupplyChainExposure(supply: V9AssetFactsV2["supply"]): V9SupplyChainExposure {
  if (!isKnownRequiredStatus(supply.status)) {
    return { shareBySlug: new Map<string, number>(), unattributedShare: 1, complete: false };
  }
  if (supply.chainDistribution === null || supply.chainDistribution === undefined) {
    return { shareBySlug: new Map<string, number>(), unattributedShare: 1, complete: false };
  }
  const circulatingUsd = supply.circulatingUsd;
  const distributedUsd =
    supply.chainDistribution.chains.reduce((sum, row) => sum + row.supplyUsd, 0) +
    supply.chainDistribution.unattributedSupplyUsd;
  const distributedShare =
    supply.chainDistribution.chains.reduce((sum, row) => sum + row.supplyShare, 0) +
    supply.chainDistribution.unattributedSupplyShare;
  const expectedShare = circulatingUsd !== null && circulatingUsd > 0 ? 1 : 0;
  if (
    circulatingUsd === null ||
    Math.abs(distributedUsd - circulatingUsd) > SUPPLY_USD_RECONCILIATION_TOLERANCE ||
    Math.abs(distributedShare - expectedShare) > SHARE_RECONCILIATION_TOLERANCE
  ) {
    return { shareBySlug: new Map<string, number>(), unattributedShare: 1, complete: false };
  }
  const shareBySlug = new Map<string, number>();
  for (const row of supply.chainDistribution.chains) {
    const chainId = resolveChainId(row.chainId) ?? row.chainId.toLowerCase();
    // Retained facts can contain pre-canonical aliases. Ambiguous rows must not
    // be merged silently because that could understate a material chain share.
    if (shareBySlug.has(chainId)) {
      return { shareBySlug: new Map<string, number>(), unattributedShare: 1, complete: false };
    }
    shareBySlug.set(chainId, row.supplyShare);
  }
  return {
    shareBySlug,
    unattributedShare: supply.chainDistribution.unattributedSupplyShare,
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
  asset: V9AssetFactsV2,
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

function sharesReconcile(left: number, right: number): boolean {
  return Math.abs(left - right) <= SHARE_RECONCILIATION_TOLERANCE;
}

function bridgeSupplyIsConsistent(supply: V9AssetFactsV2["supply"]): boolean {
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

function summarizeBridgeDomainExposure(asset: V9AssetFactsV2): ReadonlyMap<string, V9BridgeDomainExposure> {
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
    const validControl =
      isKnownRequiredStatus(control.status) &&
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
    if (route.reviewState !== "selected-reviewed" || validJoinedDeployments.has(route.deploymentRouteKey)) continue;
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
  asset: V9AssetFactsV2 | undefined,
  envelope: V9ValidatedPolicyEnvelope,
): V9CommonModeContext {
  // A missing asset fact fails closed: no attributed share, no reviewed tiers.
  if (!asset) {
    return {
      supplyExposure: { shareBySlug: new Map<string, number>(), unattributedShare: 1, complete: false },
      dexExposureByDomain: new Map<string, V9ConservativeShareBounds>(),
      bridgeExposureByDomain: new Map<string, V9BridgeDomainExposure>(),
    };
  }
  return {
    supplyExposure: summarizeSupplyChainExposure(asset.supply),
    dexExposureByDomain: summarizeDexDomainExposure(asset, envelope),
    bridgeExposureByDomain: summarizeBridgeDomainExposure(asset),
  };
}

/**
 * Grades proportional common-mode domains from reviewed asset-local exposure.
 * Mature ecosystem domains are diagnostic; otherwise proven exposure below 5%
 * is diagnostic, 5%-<10% is moderate, and >=10% or unknown is high. Serial
 * control domains do not enter this proportional path and remain fail-closed.
 */
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

export function commonModeSignalSeverity(
  failureDomain: V9FailureDomainRef,
  context: V9CommonModeContext,
  materiality: V9ValidatedPolicyEnvelope["policy"]["semantic"]["materiality"],
): V9Severity {
  const high = materiality.commonModeSignal.severity;
  switch (failureDomain.kind) {
    case "chain": {
      const chainId = resolveChainId(failureDomain.key) ?? failureDomain.key.toLowerCase();
      const share = context.supplyExposure.complete
        ? clampShare((context.supplyExposure.shareBySlug.get(chainId) ?? 0) + context.supplyExposure.unattributedShare)
        : null;
      return proportionalCommonModeSeverity(share, materiality.matureChains.includes(chainId), materiality);
    }
    case "reserve-issuer":
      // Single-obligor exposure is already priced by backing concentration;
      // keep the signal diagnostic (non-capping) to avoid double-counting.
      return "low";
    case "dex-protocol":
      return proportionalCommonModeSeverity(
        context.dexExposureByDomain.get(domainKey(failureDomain))?.upper ?? null,
        materiality.matureVenues.includes(failureDomain.key.toLowerCase()),
        materiality,
      );
    case "bridge-route": {
      const exposure = context.bridgeExposureByDomain.get(domainKey(failureDomain));
      return proportionalCommonModeSeverity(
        exposure !== undefined && exposure.reviewedTiersComplete ? exposure.shareBounds.upper : null,
        false,
        materiality,
      );
    }
    default:
      return high;
  }
}

function commonModeReasonQualifier(kind: V9FailureDomainRef["kind"], severity: V9Severity): string {
  if (kind === "chain") {
    if (severity === "low")
      return "reviewed mature chain or conservative exposure upper bound below 5%, diagnostic only";
    if (severity === "moderate") return "conservative non-mature exposure upper bound from 5% to below 10%";
    return "conservative exposure upper bound at or above 10%, or chain inventory unavailable";
  }
  if (kind === "dex-protocol") {
    if (severity === "low") return "reviewed mature venue or proven exposure below 5%, diagnostic only";
    if (severity === "moderate") return "reviewed non-mature exposure from 5% to below 10%";
    return "exposure at or above 10%, or unknown venue concentration";
  }
  if (kind === "bridge-route") {
    if (severity === "low") return "proven exposure below 5%, diagnostic only";
    if (severity === "moderate") return "reviewed exposure from 5% to below 10%";
    return "exposure at or above 10%, or unknown/unattributed bridge exposure";
  }
  if (kind === "reserve-issuer") {
    return "single-obligor exposure priced in backing, diagnostic only";
  }
  return severity === "high" ? "shared critical control identity" : "diagnostic";
}

function commonModeSignalsByAsset(
  plan: V9DependencyEvaluationPlan,
  envelope: V9ValidatedPolicyEnvelope,
  assetsById: ReadonlyMap<string, V9AssetFactsV2>,
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
  const signals = new Map<string, V9StructuralSignal[]>();
  for (const group of plan.commonModeGroups) {
    const effectiveMembers =
      group.failureDomain.kind === "dex-protocol"
        ? group.members.filter((member) => {
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
        : group.members;
    const assetIds = uniqueSorted(effectiveMembers.map((member) => member.assetId));
    if (
      assetIds.length < materiality.commonControlMinAssets ||
      effectiveMembers.length < materiality.commonControlMinPaths
    ) {
      continue;
    }
    const key = domainKey(group.failureDomain);
    const mintControlSeverity = (() => {
      if (group.failureDomain.kind !== "mint-control") return null;
      const members = assetIds.map((assetId) => {
        const assetMembers = effectiveMembers.filter((member) => member.assetId === assetId);
        return {
          assetId,
          pathKey: assetMembers[0]?.pathKey ?? key,
          assetIssuerKey: assetsById.get(assetId)?.assetIssuerKey ?? null,
        };
      });
      // The accepted D2 matrix has no separate controller-entity fact. Its
      // bounded proxy is the common member issuer: unresolved or mixed member
      // identities still fail closed in resolveV9MintControlGroupSeverity.
      return resolveV9MintControlGroupSeverity({
        controllerIssuerKey: members[0]?.assetIssuerKey ?? null,
        members,
      });
    })();
    for (const assetId of assetIds) {
      const severity =
        mintControlSeverity ?? commonModeSignalSeverity(group.failureDomain, contextFor(assetId), materiality);
      const qualifier =
        mintControlSeverity === "low"
          ? "same-issuer controller, diagnostic only"
          : commonModeReasonQualifier(group.failureDomain.kind, severity);
      const signal: V9StructuralSignal = {
        ...materiality.commonModeSignal,
        severity,
        reason: `${effectiveMembers.length} reviewed paths across ${assetIds.length} assets share ${key}, ${qualifier}.`,
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

function resultFailureDomains(result: V9EvaluatedAsset): V9FailureDomainRef[] {
  return canonicalDomains([
    ...result.backing.failureDomains,
    ...result.control.failureDomains,
    ...result.exit.routes.flatMap((route) => {
      if (!route.included) return [];
      const source = result.stressState.exitPortfolio?.routes.find(
        (candidate) => candidate.routeKey === route.routeKey,
      );
      return (
        source?.failureDomains.flatMap((key) => {
          const separator = key.indexOf(":");
          if (separator <= 0) return [];
          return [{ kind: key.slice(0, separator), key: key.slice(separator + 1) } as V9FailureDomainRef];
        }) ?? []
      );
    }),
  ]);
}

function resolvedBackingExposures(
  asset: V9AssetFactsV2,
  dependencyInputs: V9ResolvedDependencyInputs,
  evaluatedById: ReadonlyMap<string, V9EvaluatedAsset>,
  unavailabilityRootsById: ReadonlyMap<string, readonly string[]>,
  envelope: V9ValidatedPolicyEnvelope,
): V9ResolvedUpstreamExposure[] {
  const basketByUpstream = new Map(
    dependencyInputs.basket.map((dependency) => [dependency.upstreamAssetId, dependency]),
  );
  // The availability materiality decision lives in backing, which aggregates by
  // the propagated terminal failure roots (VER2-001) under the shared
  // materiality predicate (VER2-010). This projection only carries the roots
  // and evidence; it no longer emits an availability reason code.
  return asset.reserveExposures.flatMap((exposure) => {
    if (exposure.trackedAssetId === null) return [];
    const dependency = basketByUpstream.get(exposure.trackedAssetId);
    if (!dependency) return [];
    const upstream = evaluatedById.get(dependency.upstreamAssetId);
    const unavailable = upstream?.trace.finalScore === null;
    const failureRootAssetIds = unavailable
      ? (unavailabilityRootsById.get(dependency.upstreamAssetId) ?? [dependency.upstreamAssetId])
      : [dependency.upstreamAssetId];
    return [
      {
        exposureKey: exposure.exposureKey,
        upstreamAssetId: dependency.upstreamAssetId,
        score: upstream?.trace.finalScore ?? null,
        evidenceLevel: upstream ? worstEvidenceLevel(upstream.scoreInput.pillars, envelope) : "insufficient",
        reasonCodes: [],
        failureDomains: upstream ? resultFailureDomains(upstream) : [],
        failureRootAssetIds,
      },
    ];
  });
}

function dependencyReasons(
  asset: V9AssetFactsV2,
  inputs: V9ResolvedDependencyInputs,
  plan: V9DependencyEvaluationPlan,
  envelope: V9ValidatedPolicyEnvelope,
): V9PillarReason[] {
  const reasons: V9PillarReason[] = [];
  if (
    asset.dependencies.status.applicability.state === "unresolved" ||
    asset.dependencies.status.observationState !== "known"
  ) {
    reasons.push(
      ...gapReasonsForStatus(
        asset,
        asset.dependencies.status,
        envelope,
        "dependency:envelope",
        "unreviewed-dependency-relationships",
      ),
    );
  }
  if (
    asset.dependencies.diagnostics.graphState === "invalid" ||
    asset.dependencies.diagnostics.graphState === "unresolved"
  ) {
    reasons.push(pillarReason(envelope, "unreviewed-dependency-relationships", "dependency:graph"));
  }
  const mappedWeightByUpstream = new Map<string, number>();
  for (const exposure of asset.reserveExposures) {
    if (exposure.trackedAssetId === null) continue;
    mappedWeightByUpstream.set(
      exposure.trackedAssetId,
      (mappedWeightByUpstream.get(exposure.trackedAssetId) ?? 0) + exposure.weight,
    );
  }
  for (const dependency of inputs.basket) {
    const mappedWeight = mappedWeightByUpstream.get(dependency.upstreamAssetId);
    if (mappedWeight === undefined || Math.abs(mappedWeight - dependency.weight) > 0.000001) {
      reasons.push(
        pillarReason(
          envelope,
          "unreviewed-dependency-relationships",
          `dependency:collateral:${dependency.upstreamAssetId}`,
          `Collateral dependency ${dependency.upstreamAssetId} is not exactly mapped to reserve exposures.`,
        ),
      );
    }
  }
  const cycleMembers = new Set(plan.cyclicComponents.flat());
  if (cycleMembers.has(asset.assetId)) {
    reasons.push(pillarReason(envelope, "implementation-parent-cycle", "dependency:cycle"));
  } else if (plan.serialBlockedDescendants.includes(asset.assetId)) {
    reasons.push(pillarReason(envelope, "parent-cycle", "dependency:serial-ancestor-cycle"));
  }
  for (const serial of inputs.serial.filter((dependency) => dependency.blocked)) {
    reasons.push(
      pillarReason(
        envelope,
        "missing-parent-score",
        `dependency:serial:${serial.upstreamAssetId}`,
        `Required upstream ${serial.upstreamAssetId} is not rateable.`,
      ),
    );
  }
  return canonicalReasons(reasons);
}

function pegInput(asset: V9AssetFactsV2, envelope: V9ValidatedPolicyEnvelope): V9ProductionScoreInput["peg"] {
  const applicable = asset.peg.status.applicability.state !== "not-applicable";
  const reasons =
    applicable && asset.peg.status.observationState !== "known"
      ? gapReasonsForStatus(asset, asset.peg.status, envelope, `peg:${asset.peg.pegKey}`, "missing-peg-input")
      : [];
  return {
    applicable,
    score: applicable ? asset.peg.pegScore : null,
    activeDepegBps: applicable && asset.peg.activeDepeg === true ? asset.peg.activeDepegBps : null,
    reasons: canonicalReasons(reasons),
  };
}

function parentInput(
  inputs: V9ResolvedDependencyInputs,
  evaluatedById: ReadonlyMap<string, V9EvaluatedAsset>,
): V9ProductionScoreInput["parent"] {
  const required = inputs.serial.length > 0 || inputs.cycleBlocked;
  const availableScores = inputs.serial.flatMap((dependency) =>
    dependency.blocked || dependency.score === null ? [] : [dependency.score],
  );
  const score =
    !required || inputs.cycleBlocked || availableScores.length !== inputs.serial.length
      ? null
      : Math.min(...availableScores);
  const propagatedReasons = inputs.serial.flatMap((dependency) => {
    const upstream = evaluatedById.get(dependency.upstreamAssetId);
    return upstream?.trace.nrReasons ?? [];
  });
  return { required, score, propagatedReasons };
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
      stressStateDigest: asset.stressState.stateDigest,
    })),
  };
}

/** Evaluate one exact, compiled active-asset set under one explicit candidate policy. */
export function evaluateV9FactSet(
  input: CompiledV9FactSetV2,
  envelope: V9ValidatedPolicyEnvelope,
): Readonly<V9EvaluatedSet> {
  assertV9ValidatedPolicyEnvelope(envelope);
  const factSet = parseCompiledV9FactSetV2(input);
  const assetsById = new Map(factSet.assets.map((asset) => [asset.assetId, asset]));
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
    factSetDigest: factSet.v9FactSetDigest,
    baseInputGenerationId: factSet.baseInputGenerationId,
    evaluationBuildDigest: SAFETY_SCORE_V9_EVALUATION_BUILD_DIGEST,
    asOfSec: factSet.asOfSec,
    sourceGenerations: sourceGenerations(factSet),
  };

  for (const assetId of dependencyPlan.topologicalOrder) {
    const asset = assetsById.get(assetId);
    if (!asset) throw new Error(`Safety Score v9 dependency plan references missing asset ${assetId}`);
    const resolved = resolveV9DependencyInputs(
      dependencyPlan,
      [...evaluatedById.values()].map((result) => ({ assetId: result.assetId, score: result.trace.finalScore })),
    ).find((candidate) => candidate.assetId === assetId);
    if (!resolved) throw new Error(`Safety Score v9 dependency inputs are missing for ${assetId}`);

    const cdpReview = asset.mechanismRiskReview.review?.archetype === "cdp" ? asset.mechanismRiskReview.review : null;
    const liquidationCapacitySelection =
      asset.archetype === "cdp"
        ? selectV9CdpLiquidationCapacity(asset.assetId, cdpReview, asset.cdpStressCoverage, envelope, factSet.asOfSec)
        : undefined;
    const backingAsset = {
      assetId: asset.assetId,
      reserveStatus: asset.reserveStatus,
      reserveExposures: asset.reserveExposures,
      gaps: asset.gaps,
      resolvedUpstreamExposures: resolvedBackingExposures(
        asset,
        resolved,
        evaluatedById,
        unavailabilityRootsById,
        envelope,
      ),
      seriallyResolvedUpstreamAssetIds: resolved.serial.map((dependency) => dependency.upstreamAssetId),
      ...(liquidationCapacitySelection === undefined
        ? {}
        : { cdpLiquidationCapacitySelection: liquidationCapacitySelection }),
    };
    const backing =
      asset.mechanismRiskReview.review === null
        ? createUnavailableV9BackingResult(backingAsset, asset, envelope)
        : evaluateV9Backing(backingAsset, asset.mechanismRiskReview.review, envelope);
    const exit = evaluateV9ExitAssetFacts(asset, envelope);
    const control = evaluateV9EconomicControlAssetFacts(
      asset,
      { assetId: asset.assetId, ...asset.economicControlReview },
      envelope,
    );
    const access = evaluateV9AccessPosture({
      policy: envelope,
      facts: asset,
      transfer: asset.accessReview.transfer,
      freezeReviews: asset.accessReview.freeze.reviews,
    });
    const pillars = {
      backing: backingPillar(backing, envelope),
      exit: exitPillar(asset, exit, envelope),
      control: controlPillar(control, envelope),
    };
    const methodologyReasons =
      asset.implementation.launchedAtSec === null
        ? gapReasonsForStatus(
            asset,
            asset.implementation.status,
            envelope,
            "methodology:implementation-date",
            "missing-implementation-date",
          )
        : [];
    const scoreInput: V9ProductionScoreInput = {
      assetId,
      identity,
      pillars,
      peg: pegInput(asset, envelope),
      trackRecordMonths: conservativeTrackRecordMonths(asset.implementation.launchedAtSec, factSet.asOfSec),
      parent: parentInput(resolved, evaluatedById),
      dependencyReasons: dependencyReasons(asset, resolved, dependencyPlan, envelope),
      dependencyStructuralSignals: commonSignals.get(assetId) ?? [],
      methodologyReasons,
    };
    const trace = scoreV9EvaluatedAsset(scoreInput, envelope);
    const unavailableUpstreamRoots = uniqueSorted(
      [...resolved.basket, ...resolved.serial]
        .filter((dependency) => evaluatedById.get(dependency.upstreamAssetId)?.trace.finalScore === null)
        .flatMap(
          (dependency) => unavailabilityRootsById.get(dependency.upstreamAssetId) ?? [dependency.upstreamAssetId],
        ),
    );
    unavailabilityRootsById.set(
      assetId,
      trace.finalScore !== null || unavailableUpstreamRoots.length === 0 ? [assetId] : unavailableUpstreamRoots,
    );
    const stressState = createV9PublicStressState(scoreInput, {
      circulatingUsd: asset.supply.status.observationState === "known" ? asset.supply.circulatingUsd : null,
      portfolioStatus:
        asset.exitStatus.observationState === "known" && asset.exitStatus.applicability.state === "required"
          ? "reviewed-complete"
          : "incomplete",
      routes: asset.exitRoutes.map(projectV9ExitEvaluationRoute),
    });
    evaluatedById.set(assetId, {
      assetId,
      backing,
      exit,
      control,
      access,
      dependencyInputs: resolved,
      scoreInput,
      trace,
      compactTrace: projectCompactV9ScoreTrace(trace),
      stressState,
      ...(liquidationCapacitySelection === undefined ? {} : { liquidationCapacitySelection }),
    });
  }

  const assets = [...evaluatedById.values()].sort((left, right) => compareText(left.assetId, right.assetId));
  const core: Omit<V9EvaluatedSet, "evaluatedSetDigest"> = {
    schemaVersion: 1,
    factSetDigest: factSet.v9FactSetDigest,
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
